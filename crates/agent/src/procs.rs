//! `procs.prom`: per-user CPU and memory (lab-procs.service, every 30 s).
//!
//! Reads /proc twice, SAMPLE apart: CPU cores in use = utime+stime ticks gained / (seconds × CLK_TCK);
//! memory = VmRSS (shared pages count once per process, so forked workers add up to more than they use).
//! Processes are attributed to their effective UID; UIDs below 1000 are summed as user "system", except root.
//! Processes that exit between the two reads are missed, like in top.

use crate::util::{esc, py_float, run, Runner};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io;
use std::path::Path;
use std::time::Duration;

pub const SAMPLE: Duration = Duration::from_secs(5);
pub const INTERVAL: Duration = Duration::from_secs(30);
const METRICS: [(&str, &str); 3] = [
    ("lab_user_cpu_cores", "CPU cores in use by the user's processes."),
    (
        "lab_user_memory_bytes",
        "Resident memory (sum of RSS) of the user's processes.",
    ),
    ("lab_user_processes", "Number of the user's processes."),
];

/// {user: (cores, rss bytes, processes)}
pub type Users = BTreeMap<String, (f64, i64, i64)>;
/// pid → (utime + stime ticks, start time), in /proc listing order.
pub type Snapshot = Vec<(String, (i64, i64))>;

/// /proc/PID/stat → (utime + stime ticks, start time); comm may contain spaces and parentheses.
pub fn parse_stat(text: &[u8]) -> Option<(i64, i64)> {
    let close = text.iter().rposition(|&b| b == b')')?;
    let rest = String::from_utf8_lossy(text.get(close + 2..).unwrap_or_default());
    let f: Vec<&str> = rest.split_whitespace().collect();
    let num = |i: usize| f.get(i)?.parse::<i64>().ok();
    Some((num(11)? + num(12)?, num(19)?))
}

/// /proc/PID/status → (effective uid, VmRSS bytes); kernel threads have no VmRSS. `None` when unparseable.
pub fn parse_status(text: &str) -> Option<(Option<i64>, i64)> {
    let (mut uid, mut rss) = (None, 0);
    for line in text.lines() {
        if line.starts_with("Uid:") {
            uid = Some(line.split_whitespace().nth(2)?.parse().ok()?);
        } else if line.starts_with("VmRSS:") {
            rss = line.split_whitespace().nth(1)?.parse::<i64>().ok()? * 1024;
        }
    }
    Some((uid, rss))
}

/// The processes that are still there while we read them.
pub fn snapshot(proc: &Path) -> io::Result<Snapshot> {
    let mut out = Vec::new();
    for e in fs::read_dir(proc)? {
        let Ok(name) = e?.file_name().into_string() else {
            continue;
        };
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        // exited mid-read (ENOENT/ESRCH)
        if let Some(st) = fs::read(proc.join(&name).join("stat"))
            .ok()
            .and_then(|t| parse_stat(&t))
        {
            out.push((name, st));
        }
    }
    Ok(out)
}

pub fn owner(uid: i64, names: &mut HashMap<i64, String>, lookup: &dyn Fn(i64) -> Option<String>) -> String {
    if uid == 0 {
        return "root".into();
    }
    if uid < 1000 {
        return "system".into();
    }
    names
        .entry(uid)
        .or_insert_with(|| lookup(uid).unwrap_or_else(|| uid.to_string()))
        .clone()
}

/// Users from two snapshots and {pid: (uid, rss)}. A pid missing from `before`, or reused (another start
/// time), started during the sample: all of its ticks are new.
pub fn aggregate(
    before: &Snapshot,
    after: &Snapshot,
    status: &HashMap<String, (i64, i64)>,
    seconds: f64,
    hz: f64,
    lookup: &dyn Fn(i64) -> Option<String>,
) -> Users {
    let before: HashMap<&str, (i64, i64)> = before.iter().map(|(p, v)| (p.as_str(), *v)).collect();
    let mut names = HashMap::new();
    let mut users = Users::new();
    for (pid, (ticks, start)) in after {
        let Some(&(uid, rss)) = status.get(pid) else { continue }; // exited before we read its status
        let used = match before.get(pid.as_str()) {
            Some(&(prev, prev_start)) if prev_start == *start => ticks - prev,
            _ => *ticks,
        };
        let u = users.entry(owner(uid, &mut names, lookup)).or_insert((0.0, 0, 0));
        u.0 += used.max(0) as f64 / (seconds * hz);
        u.1 += rss;
        u.2 += 1;
    }
    users
}

/// Python's `round(v, 3)`: correctly rounded to three decimals.
fn round3(v: f64) -> f64 {
    format!("{v:.3}").parse().unwrap_or(v)
}

pub fn render(users: &Users) -> String {
    let mut out = String::new();
    for (i, (name, doc)) in METRICS.iter().enumerate() {
        out += &format!("# HELP {name} {doc}\n# TYPE {name} gauge\n");
        for (user, (cores, rss, n)) in users {
            let v = match i {
                0 => py_float(round3(*cores)),
                1 => rss.to_string(),
                _ => n.to_string(),
            };
            out += &format!("{name}{{user=\"{}\"}} {v}\n", esc(user));
        }
    }
    out
}

/// Two snapshots around `wait()`; `clock` gives monotonic seconds.
pub fn sample(
    proc: &Path,
    hz: f64,
    lookup: &dyn Fn(i64) -> Option<String>,
    clock: &mut dyn FnMut() -> f64,
    wait: &mut dyn FnMut(),
) -> io::Result<Users> {
    let t0 = clock();
    let before = snapshot(proc)?;
    wait();
    let after = snapshot(proc)?;
    let t1 = clock();
    let mut status = HashMap::new();
    for (pid, _) in &after {
        let Ok(text) = fs::read(proc.join(pid).join("status")) else {
            continue;
        };
        if let Some((Some(uid), rss)) = parse_status(&String::from_utf8_lossy(&text)) {
            status.insert(pid.clone(), (uid, rss));
        }
    }
    Ok(aggregate(&before, &after, &status, t1 - t0, hz, lookup))
}

/// The user name of `uid` from /etc/passwd, else from NSS (`getent passwd UID`, e.g. LDAP users).
pub fn lookup_user(r: &dyn Runner, uid: i64) -> Option<String> {
    let id = uid.to_string();
    let find = |text: &str| {
        text.lines().find_map(|l| {
            let f: Vec<&str> = l.split(':').collect();
            (f.len() >= 3 && f[2] == id).then(|| f[0].to_string())
        })
    };
    if let Some(name) = fs::read("/etc/passwd")
        .ok()
        .and_then(|t| find(&String::from_utf8_lossy(&t)))
    {
        return Some(name);
    }
    match run(r, &["getent", "passwd", &id], Some(Duration::from_secs(10))) {
        Ok((0, out)) => find(&String::from_utf8_lossy(&out)),
        _ => None,
    }
}

pub fn clock_ticks() -> f64 {
    // SAFETY: sysconf has no preconditions.
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if hz > 0 {
        hz as f64
    } else {
        100.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::testutil::TempDir;

    /// A /proc/PID/stat line: utime and stime split `ticks`; the fields in between are realistic filler.
    fn stat(pid: u32, comm: &str, ticks: i64, start: i64) -> String {
        let u = ticks / 2;
        format!(
            "{pid} ({comm}) R 1 {pid} {pid} 0 -1 4194304 1200 0 3 0 {u} {} 0 0 20 0 8 0 {start} \
             25000000000 6000000 18446744073709551615 1 1 0 0 0 0 0 16781312 17638 0 0 0 17 3 0 0 0 0 0\n",
            ticks - u
        )
    }

    fn status(uid: i64, rss_kb: Option<i64>) -> String {
        let mut lines = vec![
            "Name:\tpython".to_string(),
            "State:\tR (running)".into(),
            format!("Uid:\t{uid}\t{uid}\t{uid}\t{uid}"),
            format!("Gid:\t{uid}\t{uid}\t{uid}\t{uid}"),
        ];
        if let Some(kb) = rss_kb {
            // kernel threads have no Vm* lines
            lines.extend([
                "VmPeak:\t 9999999 kB".into(),
                format!("VmRSS:\t{kb:>9} kB"),
                "RssAnon:\t    1 kB".into(),
            ]);
        }
        lines.push("Threads:\t8".into());
        lines.join("\n") + "\n"
    }

    fn names(uid: i64) -> Option<String> {
        match uid {
            1001 => Some("alice".into()),
            1002 => Some("bob".into()),
            _ => None,
        }
    }

    #[test]
    fn test_parse_stat() {
        assert_eq!(
            parse_stat(stat(42, "python", 700, 123456).as_bytes()),
            Some((700, 123456))
        );
        // comm is free text up to 15 bytes: spaces and ')' inside it must not shift the fields
        assert_eq!(parse_stat(stat(43, "a) b (c) R 9", 10, 7).as_bytes()), Some((10, 7)));
        // and need not be UTF-8
        assert_eq!(
            parse_stat(&[b"44 (\xff\xfe) ".as_slice(), &stat(44, "x", 4, 2).as_bytes()[7..]].concat()),
            Some((4, 2))
        );
        assert_eq!(parse_stat(b"45 (truncated"), None);
        assert_eq!(parse_stat(b"46 (x) R 1"), None);
    }

    #[test]
    fn test_parse_status() {
        assert_eq!(parse_status(&status(1001, Some(2048))), Some((Some(1001), 2048 * 1024)));
        assert_eq!(parse_status(&status(0, None)), Some((Some(0), 0))); // kernel thread
                                                                        // setuid program started by alice: the effective uid (second column) owns it, as in top and ps
        assert_eq!(
            parse_status("Uid:\t1001\t0\t0\t0\nVmRSS:\t4 kB\n"),
            Some((Some(0), 4096))
        );
        assert_eq!(parse_status("Name:\tx\n"), Some((None, 0)));
        assert_eq!(parse_status("Uid:\t1001\n"), None);
    }

    fn snap(items: &[(&str, (i64, i64))]) -> Snapshot {
        items.iter().map(|(p, v)| (p.to_string(), *v)).collect()
    }

    #[test]
    fn test_aggregate() {
        let before = snap(&[
            ("10", (1000, 50)),
            ("11", (200, 60)),
            ("12", (5, 70)),
            ("13", (9, 80)),
            ("14", (100, 90)),
            ("20", (0, 95)),
        ]);
        let after = snap(&[
            ("10", (1500, 50)), // alice: 500 ticks in 5 s at 100 Hz = 1 core
            ("11", (450, 60)),  // alice: another half core
            ("12", (5, 70)),    // root, idle
            ("13", (29, 80)),   // www-data (uid 33) → system
            ("14", (40, 1234)), // pid reused by a new bob process: all 40 ticks are new
            ("15", (10, 1300)), // started during the sample: all ticks are new
            ("16", (7, 1400)),  // exited before its status was read: skipped
            ("17", (0, 1500)),  // uid with no passwd entry: numeric name
            ("18", (3, 1600)),  // another system account (uid 999)
        ]); // pid 20 exited between the two reads: gone
        let st: HashMap<String, (i64, i64)> = [
            ("10", (1001, 4 << 30)),
            ("11", (1001, 1 << 30)),
            ("12", (0, 8 << 20)),
            ("13", (33, 1 << 20)),
            ("14", (1002, 3 << 20)),
            ("15", (1001, 0)),
            ("17", (3999998, 1 << 10)),
            ("18", (999, 1 << 20)),
        ]
        .into_iter()
        .map(|(p, v)| (p.to_string(), v))
        .collect();
        let u = aggregate(&before, &after, &st, 5.0, 100.0, &names);
        let u: Vec<(String, f64, i64, i64)> = u
            .into_iter()
            .map(|(k, v)| (k, (v.0 * 1e6).round() / 1e6, v.1, v.2))
            .collect();
        assert_eq!(
            u,
            [
                ("3999998".into(), 0.0, 1 << 10, 1),
                ("alice".into(), 1.52, 5 << 30, 3),
                ("bob".into(), 0.08, 3 << 20, 1),
                ("root".into(), 0.0, 8 << 20, 1),
                ("system".into(), 0.046, 2 << 20, 2),
            ]
        );
        // a counter that went backwards (can't happen for one process) never gives negative CPU
        let st = HashMap::from([("1".to_string(), (1001, 0))]);
        assert_eq!(
            aggregate(
                &snap(&[("1", (50, 1))]),
                &snap(&[("1", (40, 1))]),
                &st,
                5.0,
                100.0,
                &names
            )["alice"]
                .0,
            0.0
        );
    }

    #[test]
    fn test_owner_names() {
        let mut cache = HashMap::new();
        let lookup = |uid: i64| {
            assert!(uid >= 1000, "system accounts are never looked up");
            names(uid)
        };
        assert_eq!(owner(0, &mut cache, &lookup), "root");
        assert_eq!(owner(1, &mut cache, &lookup), "system");
        assert_eq!(owner(999, &mut cache, &lookup), "system");
        assert!(cache.is_empty());
        assert_eq!(owner(1001, &mut cache, &lookup), "alice");
        assert_eq!(cache, HashMap::from([(1001, "alice".to_string())]));
        assert_eq!(owner(3999999, &mut cache, &lookup), "3999999");
    }

    #[test]
    fn test_render() {
        let users = Users::from([
            ("alice".into(), (1.0249, 5368709120, 3)),
            ("ev\"il\\\nx".into(), (0.0, 1024, 1)),
            ("root".into(), (0.12, 0, 150)),
        ]);
        let text = render(&users);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            lines[..2],
            [
                "# HELP lab_user_cpu_cores CPU cores in use by the user's processes.",
                "# TYPE lab_user_cpu_cores gauge"
            ]
        );
        assert!(lines.contains(&"lab_user_cpu_cores{user=\"alice\"} 1.025"));
        assert!(lines.contains(&"lab_user_memory_bytes{user=\"alice\"} 5368709120"));
        assert!(lines.contains(&"lab_user_processes{user=\"root\"} 150"));
        assert!(lines.contains(&"lab_user_cpu_cores{user=\"ev\\\"il\\\\\\nx\"} 0.0")); // one sample per line
        assert_eq!(lines.len(), 3 * 2 + 3 * 3);
        assert!(text.ends_with('\n'));
        assert_eq!(render(&Users::new()).lines().count(), 6); // HELP/TYPE even without samples
        assert_eq!(py_float(round3(0.0625)), "0.062"); // round half to even, like Python
    }

    fn fake_proc(root: &Path, procs: &[(u32, String, String)]) {
        for (pid, st, stat_text) in procs {
            let d = root.join(pid.to_string());
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join("stat"), stat_text).unwrap();
            fs::write(d.join("status"), st).unwrap();
        }
    }

    /// The fixture of the golden test: what changes while procs sleeps between the two reads.
    fn golden_fixture(root: &Path) -> impl FnMut() + '_ {
        fs::create_dir_all(root.join("self")).unwrap(); // non-numeric entries are ignored
        fs::write(root.join("uptime"), "1 1\n").unwrap();
        fake_proc(
            root,
            &[
                (100, status(1001, Some(1024)), stat(100, "busy", 1000, 5)),
                (101, status(1001, Some(2048)), stat(101, "a) b (c", 300, 6)),
                (200, status(0, Some(2048)), stat(200, "sshd", 50, 6)),
                (300, status(33, Some(10)), stat(300, "gone", 70, 7)),
                (400, String::new(), stat(400, "k", 1, 8)), // a status that can't be parsed: skipped
                (401, status(0, None), stat(401, "kworker/0:1", 5, 2)),
                (402, status(999, Some(100)), stat(402, "systemd-resolve", 0, 3)),
                (403, status(3999998, Some(1)), stat(403, "orphan", 0, 4)),
                (404, status(1002, Some(4)), stat(404, "old", 100, 9)),
            ],
        );
        move || {
            fake_proc(
                root,
                &[
                    (100, status(1001, Some(1024)), stat(100, "busy", 2000, 5)),
                    (101, status(1001, Some(2048)), stat(101, "a) b (c", 633, 6)),
                    (404, status(1002, Some(8)), stat(404, "new", 40, 1234)),
                    (500, status(1001, Some(4)), stat(500, "new", 250, 99)),
                ],
            );
            for name in ["stat", "status"] {
                fs::remove_file(root.join("300").join(name)).unwrap(); // exited: the directory lingers
            }
        }
    }

    #[test]
    fn golden() {
        // Golden file produced by the old procs.py (render(sample(root))) on the same fixture.
        let t = TempDir::new();
        let mut between = golden_fixture(t.path());
        let mut clock = [100.0, 105.0].into_iter();
        let u = sample(t.path(), 100.0, &names, &mut || clock.next().unwrap(), &mut between).unwrap();
        assert_eq!(render(&u), include_str!("../tests/golden/procs.prom"));
    }

    #[test]
    fn test_sample_reads_proc_and_survives_vanishing_processes() {
        let t = TempDir::new();
        let root = t.path();
        let hz = 100;
        fs::create_dir_all(root.join("self")).unwrap();
        fake_proc(
            root,
            &[
                (100, status(1001, Some(1024)), stat(100, "busy", 1000, 5)),
                (200, status(0, Some(2048)), stat(200, "sshd", 50, 6)),
                (300, status(1001, Some(10)), stat(300, "gone", 70, 7)),
                (400, String::new(), stat(400, "k", 1, 8)),
            ],
        );
        let mut between = || {
            fake_proc(
                root,
                &[
                    (100, status(1001, Some(1024)), stat(100, "busy", 1000 + 2 * hz * 5, 5)),
                    (500, status(1001, Some(4)), stat(500, "new", hz * 5, 9)),
                ],
            );
            for name in ["stat", "status"] {
                fs::remove_file(root.join("300").join(name)).unwrap();
            }
        };
        let mut clock = [100.0, 105.0].into_iter();
        let u = sample(root, hz as f64, &names, &mut || clock.next().unwrap(), &mut between).unwrap();
        assert_eq!(
            u,
            Users::from([
                ("alice".into(), (3.0, 1028 * 1024, 2)),
                ("root".into(), (0.0, 2048 * 1024, 1))
            ])
        );
    }
}
