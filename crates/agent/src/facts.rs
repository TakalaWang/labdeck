//! `facts`: one JSON document describing this host (run as root by playbooks/collect.yaml).
//! Format: docs/design.md 約定 E. Every probe that fails yields its default instead of breaking the document.

use crate::util::{civil_from_days, days_from_civil, days_in_month, fnmatch, run, Runner};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::ffi::CString;
use std::fs;
use std::net::IpAddr;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const UID_MIN: i64 = 1000;
const UID_MAX: i64 = 65533;
const TIMEOUT: Option<Duration> = Some(Duration::from_secs(120));

#[derive(Serialize, Debug, PartialEq)]
pub struct Doc {
    pub host: String,
    pub collected_at: u64,
    pub facts: Facts,
    /// None (JSON null) = couldn't list the accounts: the portal then keeps what it knew instead of dropping them all.
    pub accounts: Option<Vec<Account>>,
    pub logins: Vec<Login>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Facts {
    pub os: Option<String>,
    pub kernel: Option<String>,
    pub cpu_model: Option<String>,
    pub cpu_count: Option<u64>,
    pub mem_mb: Option<u64>,
    pub nvidia_driver: Option<String>,
    pub cuda: Option<String>,
    pub gpu_pci_count: Option<u64>,
    pub gpus: Vec<Gpu>,
    pub disks: Vec<Disk>,
    pub mounts: Vec<Mount>,
    pub uptime_s: Option<i64>,
    pub apt_update_at: Option<i64>,
    pub apt_check_ok: Option<bool>,
    pub reboot_required: Option<bool>,
    pub reboot_pkgs: Vec<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Gpu {
    pub index: u64,
    pub name: String,
    pub uuid: String,
    pub memory_mb: Option<u64>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Disk {
    pub name: Value,
    pub size_bytes: Option<i64>,
    pub model: Option<String>,
    pub serial: Option<String>,
    pub rota: bool,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Mount {
    pub mountpoint: String,
    pub size_bytes: Option<u64>,
    pub used_bytes: Option<u64>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Account {
    pub username: String,
    pub uid: i64,
    pub home: String,
    pub shell: String,
    pub last_login: Option<i64>,
    pub home_mtime: Option<i64>,
    pub locked: bool,
    pub expires: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Login {
    pub username: String,
    pub src: String,
    pub ts: i64,
}

// --- helpers -------------------------------------------------------------------------------------

/// stdout of a command that must exit 0 (non-UTF-8 bytes become U+FFFD, so one odd GECOS field can't fail it).
fn run_ok(r: &dyn Runner, argv: &[&str]) -> Option<String> {
    match run(r, argv, TIMEOUT) {
        Ok((0, out)) => Some(String::from_utf8_lossy(&out).into_owned()),
        _ => None,
    }
}

fn read(path: &str) -> Option<String> {
    fs::read(path).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

// --- pure parsers --------------------------------------------------------------------------------

/// `^PRETTY_NAME="?([^"\n]*)"?$` (multi-line)
pub fn parse_os_release(text: &str) -> Option<String> {
    text.split('\n').find_map(|line| {
        let rest = line.strip_prefix("PRETTY_NAME=")?;
        let rest = rest.strip_prefix('"').unwrap_or(rest);
        let end = rest.find('"').unwrap_or(rest.len());
        matches!(&rest[end..], "" | "\"").then(|| rest[..end].to_string())
    })
}

pub fn parse_cpu_model(text: &str) -> Option<String> {
    text.split('\n').find_map(|line| {
        let rest = line.strip_prefix("model name")?.trim_start();
        let value = rest.strip_prefix(':')?.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

pub fn parse_mem_mb(text: &str) -> Option<u64> {
    text.split('\n').find_map(|line| {
        // ^MemTotal:\s+(\d+) kB
        let rest = line
            .strip_prefix("MemTotal:")
            .filter(|r| r.starts_with(char::is_whitespace))?
            .trim_start();
        let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        if digits == 0 || !rest[digits..].starts_with(" kB") {
            return None;
        }
        rest[..digits].parse::<u64>().ok().map(|kb| kb / 1024)
    })
}

/// The first `label\s*(\S+)` in the text.
fn after_label(text: &str, label: &str) -> Option<String> {
    text.match_indices(label).find_map(|(i, _)| {
        let value: String = text[i + label.len()..]
            .trim_start()
            .chars()
            .take_while(|c| !c.is_whitespace())
            .collect();
        (!value.is_empty()).then_some(value)
    })
}

/// (driver, cuda) from the plain `nvidia-smi` banner.
pub fn parse_smi_banner(text: &str) -> (Option<String>, Option<String>) {
    (after_label(text, "Driver Version:"), after_label(text, "CUDA Version:"))
}

/// `nvidia-smi --query-gpu=index,name,uuid,memory.total --format=csv,noheader,nounits`.
pub fn parse_smi_gpus(text: &str) -> Option<Vec<Gpu>> {
    let mut gpus = Vec::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split(',').map(str::trim).collect();
        if f.len() == 4 && is_digits(f[0]) {
            gpus.push(Gpu {
                index: f[0].parse().ok()?,
                name: f[1].into(),
                uuid: f[2].into(),
                memory_mb: if is_digits(f[3]) {
                    Some(f[3].parse().ok()?)
                } else {
                    None
                },
            });
        }
    }
    Some(gpus)
}

/// `lspci -d 10de: -n`: count VGA (0300) and 3D (0302) controllers.
pub fn count_nvidia_pci(text: &str) -> u64 {
    text.lines()
        .filter(|line| {
            let Some(sp) = line.find(char::is_whitespace) else {
                return false;
            };
            sp > 0 && (line[sp..].starts_with(" 0300:") || line[sp..].starts_with(" 0302:"))
        })
        .count() as u64
}

/// `lsblk -J -b -d -o NAME,SIZE,MODEL,SERIAL,ROTA,TYPE` (older util-linux prints numbers as strings).
pub fn parse_lsblk(text: &str) -> Option<Vec<Disk>> {
    let doc: Value = serde_json::from_str(text).ok()?;
    let devices = match doc.as_object()?.get("blockdevices") {
        None => return Some(Vec::new()),
        Some(d) => d.as_array()?,
    };
    let text_field = |d: &Value, k: &str| {
        let s = match d.get(k) {
            Some(Value::String(s)) => s.trim().to_string(),
            _ => String::new(),
        };
        (!s.is_empty()).then_some(s)
    };
    let mut disks = Vec::new();
    for d in devices {
        if d.get("type").and_then(Value::as_str) != Some("disk") {
            continue;
        }
        let size_bytes = match d.get("size") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.trim().parse().ok()?),
            Some(Value::Number(n)) => Some(n.as_i64().or_else(|| n.as_f64().map(|f| f as i64))?),
            Some(_) => return None,
        };
        disks.push(Disk {
            name: d.get("name")?.clone(),
            size_bytes,
            model: text_field(d, "model"),
            serial: text_field(d, "serial"),
            rota: match d.get("rota") {
                Some(Value::Bool(b)) => *b,
                Some(Value::Number(n)) => n.as_f64() == Some(1.0),
                Some(Value::String(s)) => s == "1",
                _ => false,
            },
        });
    }
    Some(disks)
}

/// `PurePosixPath(path).match(pattern)`: matched per path component from the right; an absolute pattern
/// must match the whole path. `None` for an empty pattern.
fn path_match(path: &str, pattern: &str) -> Option<bool> {
    let parts = |p: &str| -> Vec<String> {
        let mut v: Vec<String> = if p.starts_with('/') {
            vec!["/".into()]
        } else {
            Vec::new()
        };
        v.extend(p.split('/').filter(|c| !c.is_empty() && *c != ".").map(String::from));
        v
    };
    let (path, pat) = (parts(path), parts(pattern));
    if pat.is_empty() {
        return None;
    }
    let absolute = pattern.starts_with('/');
    if absolute && (path.first().is_none_or(|p| p != "/") || path.len() != pat.len()) {
        return Some(false);
    }
    if pat.len() > path.len() {
        return Some(false);
    }
    let skip = usize::from(absolute);
    Some(
        path.iter()
            .rev()
            .zip(pat.iter().rev())
            .take(pat.len() - skip)
            .all(|(p, q)| fnmatch(p, q, false)),
    )
}

/// /proc/mounts: [(mountpoint, fstype)] of /, /home and data_glob mountpoints, in order, without duplicates.
/// Matched per path component like a shell glob, so /data* does not match /data0/docker/overlay2/...
pub fn parse_mountpoints(text: &str, data_glob: &str) -> Option<Vec<(String, String)>> {
    let mut seen: Vec<(String, String)> = Vec::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() > 2
            && (f[1] == "/" || f[1] == "/home" || path_match(f[1], data_glob)?)
            && !seen.iter().any(|(m, _)| m == f[1])
        {
            seen.push((f[1].into(), f[2].into()));
        }
    }
    Some(seen)
}

/// `getent passwd` → human accounts (UID 1000-65533), without the login fields yet.
pub fn parse_passwd(text: &str) -> Vec<Account> {
    text.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split(':').collect();
            if f.len() != 7 || !is_digits(f[2]) {
                return None;
            }
            let uid: i64 = f[2].parse().ok()?;
            (UID_MIN..=UID_MAX).contains(&uid).then(|| Account {
                username: f[0].into(),
                uid,
                home: f[5].into(),
                shell: f[6].into(),
                last_login: None,
                home_mtime: None,
                locked: false,
                expires: None,
            })
        })
        .collect()
}

/// Days since the epoch → ISO date; `None` past what Python's date can hold (year 9999).
fn iso_date(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

const MAX_DAY: i64 = 2_932_896; // 9999-12-31

/// /etc/shadow → {username: (locked, expires ISO date or None)}.
///
/// expires = the last day logins are allowed; shadow stores the first day they are refused (the day after).
/// locked = `usermod -L`-ed password ("!" before a real hash) or expired, counted in UTC days like PAM does.
/// "!", "!*" or "*" alone is a key-only account, not a locked one.
pub fn parse_shadow(text: &str, today: i64) -> Option<HashMap<String, (bool, Option<String>)>> {
    let mut result = HashMap::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split(':').collect();
        if f.len() < 8 {
            continue;
        }
        let refused = if is_digits(f[7]) {
            let days = f[7].parse::<i64>().ok().filter(|d| *d <= MAX_DAY)?;
            Some(days)
        } else {
            None
        };
        let hash_locked = f[1]
            .strip_prefix('!')
            .is_some_and(|rest| !rest.is_empty() && rest != "*");
        let locked = hash_locked || refused.is_some_and(|r| r <= today);
        result.insert(f[0].to_string(), (locked, refused.map(|r| iso_date(r - 1))));
    }
    Some(result)
}

/// UTC days since the epoch, now.
fn utc_today() -> i64 {
    (now() / 86400) as i64
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

const WEEKDAYS: [&str; 7] = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
];
const MONTHS: [&str; 12] = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

/// A full or three-letter name, case-insensitive, as strptime's %a / %b accept it → its index.
fn name_index(s: &str, names: &[&str]) -> Option<usize> {
    let s = s.to_ascii_lowercase();
    names
        .iter()
        .position(|n| *n == s || (s.len() == 3 && n.starts_with(&s)))
}

fn num_in(s: &str, digits: std::ops::RangeInclusive<usize>, max: u32) -> Option<u32> {
    if !digits.contains(&s.len()) || !is_digits(s) {
        return None;
    }
    s.parse().ok().filter(|v| *v <= max)
}

/// "Mon Sep 22 10:11:12 [+0800 ]2025" → (year, month, day, seconds of the day, UTC offset seconds)
fn parse_stamp(s: &str, with_zone: bool) -> Option<(i64, u32, u32, i64, i64)> {
    let f: Vec<&str> = s.split(' ').collect();
    if f.len() != 5 + usize::from(with_zone) {
        return None;
    }
    name_index(f[0], &WEEKDAYS)?;
    let month = name_index(f[1], &MONTHS)? as u32 + 1;
    let day = num_in(f[2], 1..=2, 31).filter(|d| *d >= 1)?;
    let hms: Vec<&str> = f[3].split(':').collect();
    let [h, m, sec] = hms[..] else { return None };
    let (h, m, sec) = (num_in(h, 1..=2, 23)?, num_in(m, 1..=2, 59)?, num_in(sec, 1..=2, 59)?);
    let offset = if with_zone { parse_zone(f[4])? } else { 0 };
    let year = i64::from(num_in(f[f.len() - 1], 4..=4, 9999).filter(|y| *y >= 1)?);
    if day > days_in_month(year, month) {
        return None;
    }
    Some((year, month, day, i64::from(h * 3600 + m * 60 + sec), offset))
}

/// strptime's %z: Z, ±HHMM or ±HH:MM.
fn parse_zone(z: &str) -> Option<i64> {
    if z == "Z" {
        return Some(0);
    }
    let sign = match z.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let digits = z[1..].replacen(':', "", usize::from(z.len() == 6));
    if digits.len() != 4 || !is_digits(&digits) {
        return None;
    }
    let (h, m): (i64, i64) = (digits[..2].parse().ok()?, digits[2..].parse().ok()?);
    (h < 24 && m < 60).then_some(sign * (h * 3600 + m * 60))
}

/// `lastlog -u 1000-65533` → {username: epoch or None}.
pub fn parse_lastlog(text: &str) -> HashMap<String, Option<i64>> {
    let mut result = HashMap::new();
    for line in text.lines().skip(1) {
        let f: Vec<&str> = line.split_whitespace().collect();
        let Some(user) = f.first() else { continue };
        let mut ts = None;
        if !line.contains("**Never logged in**") && f.len() >= 7 {
            if let Some((y, mo, d, secs, offset)) = parse_stamp(&f[f.len() - 6..].join(" "), true) {
                ts = Some(days_from_civil(y, mo, d) * 86400 + secs - offset);
            }
        }
        result.insert(user.to_string(), ts);
    }
    result
}

/// Local time → epoch, like Python's `time.mktime` (DST decided by the C library).
fn mktime_local(y: i64, mo: u32, d: u32, secs: i64) -> Option<i64> {
    // SAFETY: an all-zero tm is valid; mktime only reads and normalizes it.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    tm.tm_year = (y - 1900) as i32;
    tm.tm_mon = mo as i32 - 1;
    tm.tm_mday = d as i32;
    tm.tm_hour = (secs / 3600) as i32;
    tm.tm_min = (secs / 60 % 60) as i32;
    tm.tm_sec = (secs % 60) as i32;
    tm.tm_isdst = -1;
    // SAFETY: tm is a valid, exclusively borrowed struct.
    let t = unsafe { libc::mktime(&mut tm) };
    (t != -1).then_some(t as i64)
}

/// `^(\S+)\s+\S+\s+(\S+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})` → (user, src, stamp)
fn last_fields(line: &str) -> Option<(&str, &str, &str)> {
    if line.is_empty() || line.starts_with(char::is_whitespace) {
        return None;
    }
    let mut rest = line;
    let mut token = || {
        let end = rest.find(char::is_whitespace)?;
        let (t, r) = rest.split_at(end);
        rest = r.trim_start();
        (r.len() > rest.len()).then_some(t)
    };
    let (user, _, src) = (token()?, token()?, token()?);
    let stamp = rest.get(..24)?;
    let b = stamp.as_bytes();
    let word = |i: usize| b[i..i + 3].iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_');
    let digit = |i: usize| b[i].is_ascii_digit();
    let ok = word(0)
        && b[3] == b' '
        && word(4)
        && b[7] == b' '
        && (b[8] == b' ' || digit(8))
        && digit(9)
        && b[10] == b' '
        && digit(11)
        && digit(12)
        && b[13] == b':'
        && digit(14)
        && digit(15)
        && b[16] == b':'
        && digit(17)
        && digit(18)
        && b[19] == b' '
        && (20..24).all(digit);
    ok.then_some((user, src, stamp))
}

/// `last -Fiw` → logins that came from an IP address (local time stamps).
pub fn parse_last(text: &str) -> Vec<Login> {
    let mut logins = Vec::new();
    for line in text.lines() {
        let Some((user, src, stamp)) = last_fields(line) else {
            continue;
        };
        let Ok(ip) = src.parse::<IpAddr>() else { continue };
        if ip.is_unspecified() {
            continue;
        }
        let stamp = stamp.split_whitespace().collect::<Vec<_>>().join(" ");
        let Some((y, mo, d, secs, _)) = parse_stamp(&stamp, false) else {
            continue;
        };
        let Some(ts) = mktime_local(y, mo, d, secs) else {
            continue;
        };
        logins.push(Login {
            username: user.into(),
            src: src.into(),
            ts,
        });
    }
    logins
}

/// /var/run/reboot-required.pkgs → package names, in order, without duplicates.
pub fn parse_reboot_pkgs(text: &str) -> Vec<String> {
    let mut pkgs: Vec<String> = Vec::new();
    for p in text.lines().map(str::trim).filter(|p| !p.is_empty()) {
        if !pkgs.iter().any(|q| q == p) {
            pkgs.push(p.into());
        }
    }
    pkgs
}

pub fn parse_uptime(text: &str) -> Option<i64> {
    let v: f64 = text.split_whitespace().next()?.parse().ok()?;
    v.is_finite().then_some(v.trunc() as i64)
}

/// "0-3,5,7-8" (/sys/devices/system/cpu/online) → 7
fn count_cpu_list(text: &str) -> Option<u64> {
    let mut n = 0;
    for part in text.trim().split(',') {
        n += match part.split_once('-') {
            Some((a, b)) => b.parse::<u64>().ok()?.checked_sub(a.parse::<u64>().ok()?)? + 1,
            None => {
                part.parse::<u64>().ok()?;
                1
            }
        };
    }
    Some(n)
}

// --- probes --------------------------------------------------------------------------------------

/// apt health without running `apt-get update` (network, minutes, takes the lock): the time of the last
/// *successful* update. Ubuntu's update-notifier-common hook touches update-success-stamp only when
/// `apt update` exits 0, which it doesn't when a source fails (expired key, repo gone, no route);
/// apt.systemd.daily touches update-stamp only after a successful daily run. With the daily timer on, a stamp
/// days old means every update since has failed.
pub const APT_STAMPS: [&str; 2] = [
    "/var/lib/apt/periodic/update-success-stamp",
    "/var/lib/apt/periodic/update-stamp",
];

/// Epoch of the newest success stamp; None when there is none.
pub fn apt_update_at(stamps: &[&str]) -> Option<i64> {
    stamps.iter().filter_map(|p| mtime(Path::new(p))).max()
}

fn mtime(p: &Path) -> Option<i64> {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(p).ok().map(|m| m.mtime())
}

/// `apt-get check` (local, no network, no lock): false on broken dependencies or an interrupted dpkg;
/// None when there is no apt-get or it hung (unknown, not broken).
pub fn apt_check_ok(r: &dyn Runner) -> Option<bool> {
    run(r, &["apt-get", "-o", "Debug::NoLocking=1", "-qq", "check"], TIMEOUT)
        .ok()
        .map(|(code, _)| code == 0)
}

/// statvfs can hang on these (server gone): `nfs.*|cifs|smb3|fuse\..*`
fn is_network_fs(fstype: &str) -> bool {
    fstype.starts_with("nfs") || fstype == "cifs" || fstype == "smb3" || fstype.starts_with("fuse.")
}

pub fn mount_usage(mountpoint: &str, fstype: &str, statvfs: &dyn Fn(&str) -> Option<(u64, u64)>) -> Option<Mount> {
    if is_network_fs(fstype) {
        // listed, but never statvfs-ed
        return Some(Mount {
            mountpoint: mountpoint.into(),
            size_bytes: None,
            used_bytes: None,
        });
    }
    let (size, used) = statvfs(mountpoint)?;
    Some(Mount {
        mountpoint: mountpoint.into(),
        size_bytes: Some(size),
        used_bytes: Some(used),
    })
}

/// (size, used) bytes of the filesystem at `path`.
#[allow(clippy::useless_conversion)] // the field types differ between Linux and macOS
pub fn statvfs(path: &str) -> Option<(u64, u64)> {
    let c = CString::new(path).ok()?;
    // SAFETY: an all-zero statvfs is valid output space; c is a NUL-terminated path.
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    let (blocks, free, frsize) = (u64::from(st.f_blocks), u64::from(st.f_bfree), u64::from(st.f_frsize));
    Some((blocks * frsize, (blocks - free) * frsize))
}

fn kernel_release() -> Option<String> {
    // SAFETY: an all-zero utsname is valid output space for uname.
    let mut u: libc::utsname = unsafe { std::mem::zeroed() };
    if unsafe { libc::uname(&mut u) } != 0 {
        return None;
    }
    // SAFETY: uname NUL-terminates release.
    let release = unsafe { std::ffi::CStr::from_ptr(u.release.as_ptr()) };
    Some(release.to_string_lossy().into_owned())
}

/// Online CPUs, as glibc's sysconf(_SC_NPROCESSORS_ONLN) counts them (Python's os.cpu_count()).
fn cpu_count() -> Option<u64> {
    if let Some(n) = read("/sys/devices/system/cpu/online").and_then(|t| count_cpu_list(&t)) {
        return Some(n);
    }
    let stat = read("/proc/stat")?;
    let n = stat
        .lines()
        .filter(|l| l.starts_with("cpu") && l[3..].starts_with(|c: char| c.is_ascii_digit()))
        .count();
    (n > 0).then_some(n as u64)
}

pub fn collect(host: &str, data_glob: &str, r: &dyn Runner) -> Doc {
    let (driver, cuda) = run_ok(r, &["nvidia-smi"])
        .map(|t| parse_smi_banner(&t))
        .unwrap_or_default();
    let gpu_query = [
        "nvidia-smi",
        "--query-gpu=index,name,uuid,memory.total",
        "--format=csv,noheader,nounits",
    ];
    let lsblk = ["lsblk", "-J", "-b", "-d", "-o", "NAME,SIZE,MODEL,SERIAL,ROTA,TYPE"];
    let mounts = read("/proc/mounts")
        .and_then(|t| parse_mountpoints(&t, data_glob))
        .and_then(|ms| {
            ms.iter()
                .map(|(m, fs)| mount_usage(m, fs, &statvfs))
                .collect::<Option<Vec<_>>>()
        });
    let facts = Facts {
        os: read("/etc/os-release").and_then(|t| parse_os_release(&t)),
        kernel: kernel_release(),
        cpu_model: read("/proc/cpuinfo").and_then(|t| parse_cpu_model(&t)),
        cpu_count: cpu_count(),
        mem_mb: read("/proc/meminfo").and_then(|t| parse_mem_mb(&t)),
        nvidia_driver: driver,
        cuda,
        gpu_pci_count: run_ok(r, &["lspci", "-d", "10de:", "-n"]).map(|t| count_nvidia_pci(&t)),
        gpus: run_ok(r, &gpu_query)
            .and_then(|t| parse_smi_gpus(&t))
            .unwrap_or_default(),
        disks: run_ok(r, &lsblk).and_then(|t| parse_lsblk(&t)).unwrap_or_default(),
        mounts: mounts.unwrap_or_default(),
        uptime_s: read("/proc/uptime").and_then(|t| parse_uptime(&t)),
        apt_update_at: apt_update_at(&APT_STAMPS),
        apt_check_ok: apt_check_ok(r),
        reboot_required: Some(Path::new("/var/run/reboot-required").exists()),
        reboot_pkgs: read("/var/run/reboot-required.pkgs")
            .map(|t| parse_reboot_pkgs(&t))
            .unwrap_or_default(),
    };
    let shadow = read("/etc/shadow")
        .and_then(|t| parse_shadow(&t, utc_today()))
        .unwrap_or_default();
    // ponytail: Ubuntu 24.04+ replaced lastlog with lastlog2, so last_login is null there.
    let range = format!("{UID_MIN}-{UID_MAX}");
    let lastlog = run_ok(r, &["lastlog", "-u", &range])
        .map(|t| parse_lastlog(&t))
        .unwrap_or_default();
    let accounts = run_ok(r, &["getent", "passwd"]).map(|t| {
        let mut accounts = parse_passwd(&t);
        for a in &mut accounts {
            let (locked, expires) = shadow.get(&a.username).cloned().unwrap_or((false, None));
            a.last_login = lastlog.get(&a.username).copied().flatten();
            a.home_mtime = Some(Path::new(&a.home)).filter(|p| p.is_dir()).and_then(mtime);
            a.locked = locked;
            a.expires = expires;
        }
        accounts
    });
    let mut logins = Vec::new();
    for wtmp in ["/var/log/wtmp", "/var/log/wtmp.1"] {
        logins.extend(
            run_ok(r, &["last", "-Fiw", "-f", wtmp])
                .map(|t| parse_last(&t))
                .unwrap_or_default(),
        );
    }
    Doc {
        host: host.into(),
        collected_at: now(),
        facts,
        accounts,
        logins,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::testutil::TempDir;
    use std::io;

    fn local_epoch(y: i64, mo: u32, d: u32, h: i64, mi: i64, s: i64) -> i64 {
        mktime_local(y, mo, d, h * 3600 + mi * 60 + s).unwrap()
    }

    #[test]
    fn test_lastlog() {
        let out = "Username         Port     From             Latest\n\
                   alice            pts/0    198.51.100.7     Mon Sep 22 10:11:12 +0800 2025\n\
                   bob                                        **Never logged in**\n\
                   carol            tty1                      Tue Sep  2 08:00:00 +0000 2025\n\
                   a-very-long-username-here pts/3 198.51.100.8 Wed Sep  3 01:02:03 +0800 2025\n";
        let r = parse_lastlog(out);
        assert_eq!(
            r["alice"],
            Some(days_from_civil(2025, 9, 22) * 86400 + 2 * 3600 + 11 * 60 + 12)
        );
        assert_eq!(r["bob"], None);
        assert_eq!(r["carol"], Some(days_from_civil(2025, 9, 2) * 86400 + 8 * 3600));
        assert!(r["a-very-long-username-here"].is_some());
        assert_eq!(
            parse_lastlog("h\nx pts/0 1.2.3.4 Mon Feb 30 10:11:12 +0800 2025\n")["x"],
            None
        ); // no such day
    }

    #[test]
    fn test_last() {
        let out = "alice    pts/0        198.51.100.7     Mon Sep 22 10:11:12 2025 - Mon Sep 22 12:00:00 2025  (01:48)\n\
                   bob      pts/1        2001:db8::1      Tue Sep  2 08:00:00 2025   still logged in\n\
                   carol    pts/2        0.0.0.0          Tue Sep  2 09:00:00 2025 - Tue Sep  2 09:05:00 2025  (00:05)\n\
                   carol    tty1         0.0.0.0          Tue Sep  2 09:00:00 2025 - down                      (00:05)\n\
                   reboot   system boot  0.0.0.0          Mon Sep  1 00:00:00 2025   still running\n\
                   \n\
                   wtmp begins Mon Sep  1 00:00:00 2025\n";
        assert_eq!(
            parse_last(out),
            [
                Login {
                    username: "alice".into(),
                    src: "198.51.100.7".into(),
                    ts: local_epoch(2025, 9, 22, 10, 11, 12)
                },
                Login {
                    username: "bob".into(),
                    src: "2001:db8::1".into(),
                    ts: local_epoch(2025, 9, 2, 8, 0, 0)
                },
            ]
        );
    }

    #[test]
    fn test_smi_banner() {
        let out = "+---------------------------------------------------------------------------------------+\n\
                   | NVIDIA-SMI 535.183.01             Driver Version: 535.183.01   CUDA Version: 12.2     |\n\
                   |-----------------------------------------+----------------------+----------------------+\n";
        assert_eq!(parse_smi_banner(out), (Some("535.183.01".into()), Some("12.2".into())));
        assert_eq!(parse_smi_banner(""), (None, None));
    }

    #[test]
    fn test_smi_gpus() {
        let out = "0, NVIDIA GeForce RTX 3090, GPU-aaaa, 24576\n1, NVIDIA GeForce RTX 3090, GPU-bbbb, [N/A]\n";
        assert_eq!(
            parse_smi_gpus(out).unwrap(),
            [
                Gpu {
                    index: 0,
                    name: "NVIDIA GeForce RTX 3090".into(),
                    uuid: "GPU-aaaa".into(),
                    memory_mb: Some(24576)
                },
                Gpu {
                    index: 1,
                    name: "NVIDIA GeForce RTX 3090".into(),
                    uuid: "GPU-bbbb".into(),
                    memory_mb: None
                },
            ]
        );
    }

    #[test]
    fn test_pci_count() {
        let out =
            "01:00.0 0300: 10de:2204 (rev a1)\n01:00.1 0403: 10de:1aef (rev a1)\n41:00.0 0302: 10de:20b0 (rev a1)\n";
        assert_eq!(count_nvidia_pci(out), 2);
    }

    #[test]
    fn test_shadow() {
        let out = "root:*:19000:0:99999:7:::\n\
                   alice:$6$salt$hash:19000:0:99999:7::20666:\n\
                   bob:!$6$salt$hash:19000:0:99999:7::1:\n\
                   carol:!:19000:0:99999:7:::\n\
                   dave:$6$salt$hash:19000:0:99999:7::1:\n\
                   erin:!*:19000:0:99999:7:::\n\
                   fred:*:19000:0:99999:7:::\n";
        // alice: logins refused from 2026-08-01 (chage -E 2026-08-01); dave: users.yaml's lock sentinel
        let r = parse_shadow(out, days_from_civil(2026, 1, 1)).unwrap();
        assert_eq!(r["alice"], (false, Some("2026-07-31".into()))); // the last day she can log in
        assert_eq!(r["bob"], (true, Some("1970-01-01".into())));
        for key_only in ["carol", "erin", "fred"] {
            assert_eq!(r[key_only], (false, None)); // key-only, not locked
        }
        assert_eq!(r["dave"], (true, Some("1970-01-01".into()))); // expired
        assert!(!parse_shadow(out, days_from_civil(2026, 7, 31)).unwrap()["alice"].0); // still usable that day
        assert!(parse_shadow(out, days_from_civil(2026, 8, 1)).unwrap()["alice"].0);
        let day = utc_today(); // the default in collect: UTC days, as PAM counts
        let r = parse_shadow(
            &format!("g:$6$x:1:0:99999:7::{day}:\nh:$6$x:1:0:99999:7::{}:\n", day + 1),
            day,
        )
        .unwrap();
        assert_eq!(r["g"], (true, Some(iso_date(day - 1))));
        assert_eq!(r["h"], (false, Some(iso_date(day))));
        assert_eq!(parse_shadow("x:$6$x:1:0:99999:7::99999999:\n", day), None); // past year 9999: no shadow data
    }

    #[test]
    fn test_passwd() {
        let out = "root:x:0:0:root:/root:/bin/bash\n\
                   bob:x:1000:1000:,,,:/home/bob:/bin/bash\n\
                   alice:x:20001:20001::/home/alice:/bin/bash\n\
                   nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n";
        let a = parse_passwd(out);
        assert_eq!(
            a.iter().map(|a| a.username.as_str()).collect::<Vec<_>>(),
            ["bob", "alice"]
        );
        assert_eq!(
            (a[1].uid, a[1].home.as_str(), a[1].shell.as_str()),
            (20001, "/home/alice", "/bin/bash")
        );
    }

    #[test]
    fn test_lsblk() {
        let new = r#"{"blockdevices": [{"name": "sda", "size": 4000787030016, "model": "ST4000NM000A   ", "serial": "ZC1",
             "rota": true, "type": "disk"}, {"name": "sr0", "size": 1073741312, "model": null, "serial": null,
             "rota": true, "type": "rom"}]}"#;
        let old = r#"{"blockdevices": [{"name": "nvme0n1", "size": "1000204886016", "model": "Samsung SSD 980",
             "serial": "S6", "rota": "0", "type": "disk"}]}"#;
        assert_eq!(
            parse_lsblk(new).unwrap(),
            [Disk {
                name: "sda".into(),
                size_bytes: Some(4000787030016),
                model: Some("ST4000NM000A".into()),
                serial: Some("ZC1".into()),
                rota: true
            }]
        );
        assert_eq!(
            parse_lsblk(old).unwrap(),
            [Disk {
                name: "nvme0n1".into(),
                size_bytes: Some(1000204886016),
                model: Some("Samsung SSD 980".into()),
                serial: Some("S6".into()),
                rota: false
            }]
        );
    }

    #[test]
    fn test_misc() {
        assert_eq!(
            parse_os_release("NAME=\"Ubuntu\"\nPRETTY_NAME=\"Ubuntu 22.04.4 LTS\"\n").as_deref(),
            Some("Ubuntu 22.04.4 LTS")
        );
        assert_eq!(parse_os_release("PRETTY_NAME=Debian\n").as_deref(), Some("Debian"));
        assert_eq!(
            parse_cpu_model("processor\t: 0\nmodel name\t: AMD EPYC 7302 16-Core Processor\n").as_deref(),
            Some("AMD EPYC 7302 16-Core Processor")
        );
        assert_eq!(parse_mem_mb("MemTotal:       263769240 kB\n"), Some(257587));
        assert_eq!(count_cpu_list("0-63\n"), Some(64));
        assert_eq!(count_cpu_list("0-3,5,7-8"), Some(7));
    }

    #[test]
    fn test_mountpoints() {
        let mounts = "/dev/sda2 / ext4 rw 0 0\n/dev/sdb1 /data0 ext4 rw 0 0\n/dev/sdc1 /data0/x ext4 rw 0 0\n\
                      overlay /data0/docker/overlay2/abc/merged overlay rw 0 0\n/dev/sde1 /database ext4 rw 0 0\n\
                      /dev/sdf1 /mnt/data1 ext4 rw 0 0\n/dev/sdd1 /home xfs rw 0 0\n/dev/sda2 / ext4 rw 0 0\n";
        let names = |glob: &str| -> Vec<String> {
            parse_mountpoints(mounts, glob)
                .unwrap()
                .into_iter()
                .map(|(m, _)| m)
                .collect()
        };
        assert_eq!(
            parse_mountpoints(mounts, "/data*").unwrap(),
            [
                ("/", "ext4"),
                ("/data0", "ext4"),
                ("/database", "ext4"),
                ("/home", "xfs")
            ]
            .map(|(a, b)| (a.to_string(), b.to_string()))
        );
        assert_eq!(names("/data[0-9]"), ["/", "/data0", "/home"]);
        assert_eq!(names("/mnt/*"), ["/", "/mnt/data1", "/home"]);
        assert_eq!(parse_mountpoints(mounts, ""), None); // empty pattern: no mounts at all, like pathlib's ValueError
    }

    #[test]
    fn test_network_mounts_are_not_statvfsed() {
        let calls = std::cell::RefCell::new(Vec::new());
        let fake = |p: &str| {
            calls.borrow_mut().push(p.to_string());
            statvfs("/")
        };
        for fs in ["nfs", "nfs4", "cifs", "smb3", "fuse.sshfs"] {
            assert_eq!(
                mount_usage("/data9", fs, &fake),
                Some(Mount {
                    mountpoint: "/data9".into(),
                    size_bytes: None,
                    used_bytes: None
                })
            );
        }
        assert!(mount_usage("/", "ext4", &fake).unwrap().size_bytes.unwrap() > 0);
        assert!(mount_usage("/", "fuseblk", &fake).unwrap().size_bytes.unwrap() > 0);
        assert_eq!(*calls.borrow(), ["/", "/"]);
    }

    #[test]
    fn test_run_survives_bad_bytes() {
        let out = run_ok(&crate::util::System, &["printf", "al\\377ice:x:1001"]).unwrap();
        assert_eq!(out, "al\u{fffd}ice:x:1001");
    }

    #[test]
    fn test_accounts_null_when_passwd_fails() {
        let fake = |args: &[String]| -> io::Result<(i32, Vec<u8>)> {
            Ok(if args[0] == "getent" {
                (2, Vec::new())
            } else {
                (0, Vec::new())
            })
        };
        let doc = collect("gpu01", "/data*", &fake);
        assert_eq!(doc.accounts, None);
        assert!(serde_json::to_string(&doc).unwrap().contains("\"accounts\":null")); // not [] (= every account gone)
        assert_eq!(doc.host, "gpu01");
    }

    #[test]
    fn test_host_health_parsers() {
        assert_eq!(parse_uptime("1052311.87 4012345.10\n"), Some(1052311));
        assert_eq!(
            parse_reboot_pkgs("linux-image-5.15.0-120-generic\nlibc6\n\nlibc6\n"),
            ["linux-image-5.15.0-120-generic", "libc6"]
        );
    }

    #[test]
    fn test_apt_update_at() {
        let t = TempDir::new();
        let a = t.path().join("update-success-stamp");
        let b = t.path().join("update-stamp");
        let (sa, sb) = (a.to_str().unwrap(), b.to_str().unwrap());
        assert_eq!(apt_update_at(&[sa, sb]), None); // never updated successfully (or no apt at all)
        let touch = |p: &Path, t: u64| {
            let f = fs::File::create(p).unwrap();
            f.set_modified(UNIX_EPOCH + Duration::from_secs(t)).unwrap();
        };
        touch(&a, 1790000000);
        assert_eq!(apt_update_at(&[sa, sb]), Some(1790000000));
        touch(&b, 1790086400);
        assert_eq!(apt_update_at(&[sa, sb]), Some(1790086400)); // the newer of the two
    }

    #[test]
    fn test_apt_check_ok() {
        let seen = std::cell::RefCell::new(Vec::new());
        let rc = std::cell::Cell::new(0);
        let fake = |args: &[String]| -> io::Result<(i32, Vec<u8>)> {
            seen.borrow_mut().push(args.to_vec());
            Ok((rc.get(), Vec::new()))
        };
        assert_eq!(apt_check_ok(&fake), Some(true));
        rc.set(100);
        assert_eq!(apt_check_ok(&fake), Some(false));
        assert_eq!(seen.borrow()[0][..3], ["apt-get", "-o", "Debug::NoLocking=1"]); // never waits for the dpkg lock
        let missing = |_: &[String]| -> io::Result<(i32, Vec<u8>)> { Err(io::Error::from(io::ErrorKind::NotFound)) };
        assert_eq!(apt_check_ok(&missing), None);
    }

    #[test]
    fn test_collect_never_crashes_on_a_bare_host() {
        // no nvidia-smi, lspci, lsblk, apt-get, getent, last …
        let missing = |_: &[String]| -> io::Result<(i32, Vec<u8>)> { Err(io::Error::from(io::ErrorKind::NotFound)) };
        let doc = collect("gpu01", "/data*", &missing);
        let f = &doc.facts;
        assert_eq!(f.apt_check_ok, None);
        assert!(f.reboot_pkgs.is_empty() && f.reboot_required.is_some());
        assert!(f.uptime_s.is_none_or(|u| u >= 0)); // /proc/uptime only exists on Linux
        assert_eq!(doc.accounts, None);
        assert!(doc.logins.is_empty() && f.gpus.is_empty() && f.disks.is_empty());
        serde_json::to_string(&doc).unwrap();
    }

    #[test]
    fn json_keys_in_contract_order() {
        let missing = |_: &[String]| -> io::Result<(i32, Vec<u8>)> { Err(io::Error::from(io::ErrorKind::NotFound)) };
        let text = serde_json::to_string(&collect("gpu01", "/data*", &missing)).unwrap();
        let pos = |k: &str| text.find(&format!("\"{k}\"")).unwrap();
        let order = [
            "host",
            "collected_at",
            "facts",
            "os",
            "kernel",
            "cpu_model",
            "cpu_count",
            "mem_mb",
            "nvidia_driver",
            "cuda",
            "gpu_pci_count",
            "gpus",
            "disks",
            "mounts",
            "uptime_s",
            "apt_update_at",
            "apt_check_ok",
            "reboot_required",
            "reboot_pkgs",
            "accounts",
            "logins",
        ];
        assert!(order.windows(2).all(|w| pos(w[0]) < pos(w[1])), "{text}");
    }
}
