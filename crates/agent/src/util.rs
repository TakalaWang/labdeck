//! Shared helpers: running external commands, atomic textfile writes, label escaping, globs.

use std::ffi::OsStr;
use std::fs;
use std::io::{self, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Runs external commands; tests pass a closure with canned outputs instead.
pub trait Runner {
    /// `(exit code, stdout)`; the exit code is -1 when the command was killed by a signal.
    /// `Err` when it could not be started (e.g. not installed) or ran past `timeout`.
    fn run(&self, argv: &[&OsStr], timeout: Option<Duration>) -> io::Result<(i32, Vec<u8>)>;
}

/// The real thing: `LC_ALL=C`, stdin from /dev/null, stderr discarded.
pub struct System;

impl Runner for System {
    fn run(&self, argv: &[&OsStr], timeout: Option<Duration>) -> io::Result<(i32, Vec<u8>)> {
        let mut child = Command::new(argv[0])
            .args(&argv[1..])
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let mut pipe = child.stdout.take().expect("piped stdout");
        let reader = std::thread::spawn(move || {
            let mut out = Vec::new();
            let _ = pipe.read_to_end(&mut out);
            out
        });
        let deadline = timeout.map(|t| Instant::now() + t);
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if deadline.is_some_and(|d| Instant::now() >= d) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(io::Error::new(io::ErrorKind::TimedOut, "command timed out"));
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let out = reader.join().unwrap_or_default();
        Ok((status.code().unwrap_or(-1), out))
    }
}

impl<F: Fn(&[String]) -> io::Result<(i32, Vec<u8>)>> Runner for F {
    fn run(&self, argv: &[&OsStr], _timeout: Option<Duration>) -> io::Result<(i32, Vec<u8>)> {
        let argv: Vec<String> = argv.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        self(&argv)
    }
}

/// `run` with plain string arguments.
pub fn run(r: &dyn Runner, argv: &[&str], timeout: Option<Duration>) -> io::Result<(i32, Vec<u8>)> {
    let argv: Vec<&OsStr> = argv.iter().map(OsStr::new).collect();
    r.run(&argv, timeout)
}

/// Write `dir/name` through `dir/name.tmp` + rename, so node_exporter never reads a half-written file.
pub fn write_atomic(dir: &Path, name: &str, content: &str) -> io::Result<()> {
    let tmp = dir.join(format!("{name}.tmp"));
    fs::write(&tmp, content)?;
    fs::rename(&tmp, dir.join(name))
}

/// Label value escaping per the exposition format: `\`, `"` and newline.
pub fn esc(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")
}

/// Sorted lines (byte order, like `LC_ALL=C sort` and Python's `sorted`), each ending in a newline.
pub fn sorted_lines(mut lines: Vec<String>) -> String {
    lines.sort();
    lines.iter().map(|l| format!("{l}\n")).collect()
}

/// Python's `repr(float)`: shortest round-trip digits, `.0` on integral values, exponent outside [1e-4, 1e16).
pub fn py_float(v: f64) -> String {
    if v.is_nan() {
        return "nan".into();
    }
    if v.is_infinite() {
        return if v > 0.0 { "inf" } else { "-inf" }.into();
    }
    let a = v.abs();
    if a != 0.0 && !(1e-4..1e16).contains(&a) {
        let s = format!("{v:e}");
        let (mantissa, exp) = s.split_once('e').expect("exponent");
        let exp: i32 = exp.parse().expect("exponent digits");
        return format!("{mantissa}e{}{:02}", if exp < 0 { '-' } else { '+' }, exp.abs());
    }
    let s = format!("{v}");
    if s.contains('.') {
        s
    } else {
        format!("{s}.0")
    }
}

/// Shell-style wildcard match of one name: `*`, `?`, `[...]` (`[!...]` negates; with `caret`, `[^...]` too,
/// as in bash). An unterminated `[` is a literal. Python's fnmatch is the same without `caret`.
pub fn fnmatch(name: &str, pat: &str, caret: bool) -> bool {
    let n: Vec<char> = name.chars().collect();
    let p: Vec<char> = pat.chars().collect();
    let (mut ni, mut pi) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while ni < n.len() {
        let step = match p.get(pi) {
            Some('*') => {
                star = Some((pi, ni));
                pi += 1;
                continue;
            }
            Some('?') => Some(1),
            Some('[') => match class(&p[pi..], n[ni], caret) {
                Some((true, len)) => Some(len),
                Some((false, _)) => None,
                None if n[ni] == '[' => Some(1),
                None => None,
            },
            Some(&c) if c == n[ni] => Some(1),
            _ => None,
        };
        match (step, star) {
            (Some(len), _) => {
                ni += 1;
                pi += len;
            }
            (None, Some((sp, sn))) => {
                pi = sp + 1;
                ni = sn + 1;
                star = Some((sp, sn + 1));
            }
            (None, None) => return false,
        }
    }
    p[pi..].iter().all(|&c| c == '*')
}

/// `[...]` at the start of `p`: `(c matches, pattern length)`, or `None` when the class is unterminated.
fn class(p: &[char], c: char, caret: bool) -> Option<(bool, usize)> {
    let mut i = 1;
    let negate = matches!(p.get(i), Some('!')) || (caret && matches!(p.get(i), Some('^')));
    if negate {
        i += 1;
    }
    let mut close = i + usize::from(p.get(i) == Some(&']'));
    while p.get(close)? != &']' {
        close += 1;
    }
    let (mut k, mut hit) = (i, false);
    while k < close {
        if k + 2 < close && p[k + 1] == '-' {
            hit |= p[k] <= c && c <= p[k + 2];
            k += 3;
        } else {
            hit |= p[k] == c;
            k += 1;
        }
    }
    Some((hit != negate, close + 1))
}

fn has_wildcard(s: &str) -> bool {
    s.contains(['*', '?', '['])
}

/// Pathname expansion of an unquoted word, like bash without nullglob/dotglob: matches sorted, hidden names
/// only for a component that starts with `.`, and the word itself when nothing matches.
pub fn glob(pattern: &str) -> Vec<String> {
    if !has_wildcard(pattern) {
        return vec![pattern.to_string()];
    }
    let absolute = pattern.starts_with('/');
    let comps: Vec<&str> = pattern.split('/').skip(usize::from(absolute)).collect();
    // None = relative start (no prefix yet); Some("") = the root.
    let mut current: Vec<Option<String>> = vec![absolute.then(String::new)];
    for (i, comp) in comps.iter().enumerate() {
        let last = i + 1 == comps.len();
        let join = |base: &Option<String>, name: &str| match base {
            None => name.to_string(),
            Some(b) => format!("{b}/{name}"),
        };
        let mut next = Vec::new();
        for base in &current {
            if !has_wildcard(comp) {
                next.push(Some(join(base, comp)));
                continue;
            }
            let dir = match base {
                None => ".".to_string(),
                Some(b) if b.is_empty() => "/".to_string(),
                Some(b) => b.clone(),
            };
            let Ok(entries) = fs::read_dir(&dir) else { continue };
            let mut names: Vec<String> = entries
                .filter_map(|e| e.ok()?.file_name().into_string().ok())
                .filter(|n| (comp.starts_with('.') || !n.starts_with('.')) && fnmatch(n, comp, true))
                .collect();
            names.sort();
            for n in names {
                let path = join(base, &n);
                if last || Path::new(&path).is_dir() {
                    next.push(Some(path));
                }
            }
        }
        current = next;
    }
    let found: Vec<String> = current.into_iter().flatten().collect();
    if found.is_empty() {
        vec![pattern.to_string()]
    } else {
        found
    }
}

/// Days since 1970-01-01 of a proleptic Gregorian date.
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (i64::from(m) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// The date `days` after 1970-01-01 as (year, month, day).
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

pub fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

#[cfg(test)]
pub mod testutil {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A fresh directory under the system temp dir, removed on drop.
    pub struct TempDir(pub PathBuf);

    impl TempDir {
        pub fn new() -> TempDir {
            static N: AtomicUsize = AtomicUsize::new(0);
            let p = std::env::temp_dir().join(format!(
                "labdeck-agent-test-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::TempDir;
    use super::*;

    #[test]
    fn python_float_repr() {
        assert_eq!(py_float(0.0), "0.0");
        assert_eq!(py_float(3.0), "3.0");
        assert_eq!(py_float(1.52), "1.52");
        assert_eq!(py_float(-0.0), "-0.0");
        assert_eq!(py_float(1e16), "1e+16");
        assert_eq!(py_float(1.5e-5), "1.5e-05");
        assert_eq!(py_float(1e15), "1000000000000000.0");
        assert_eq!(py_float(0.0001), "0.0001");
    }

    #[test]
    fn wildcard_match() {
        assert!(fnmatch("data0", "data*", false));
        assert!(fnmatch("database", "data*", false));
        assert!(!fnmatch("mnt", "data*", false));
        assert!(fnmatch("data0", "data[0-9]", false));
        assert!(!fnmatch("datax", "data[0-9]", false));
        assert!(fnmatch("datax", "data[!0-9]", false));
        assert!(fnmatch("a[b", "a[b", false)); // unterminated class is literal
        assert!(fnmatch("x-", "x[a-]", false));
        assert!(fnmatch("a", "[^a]", false) && !fnmatch("a", "[^a]", true)); // bash negates, Python does not
        assert!(fnmatch("abcabd", "*b?", false));
        assert!(fnmatch("", "*", false) && !fnmatch("", "?", false));
    }

    #[test]
    fn bash_glob() {
        let t = TempDir::new();
        let root = t.path().to_str().unwrap();
        for d in ["data0", "data1", ".data2", "other"] {
            std::fs::create_dir(t.path().join(d)).unwrap();
        }
        std::fs::write(t.path().join("datafile"), "").unwrap();
        assert_eq!(
            glob(&format!("{root}/data*")),
            [
                format!("{root}/data0"),
                format!("{root}/data1"),
                format!("{root}/datafile")
            ]
        );
        assert_eq!(
            glob(&format!("{root}/data*/")),
            [format!("{root}/data0/"), format!("{root}/data1/")]
        );
        assert_eq!(glob(&format!("{root}/.data*")), [format!("{root}/.data2")]);
        assert_eq!(glob(&format!("{root}/nope*")), [format!("{root}/nope*")]); // no match: the word itself
        assert_eq!(glob("/home"), ["/home"]);
    }

    #[test]
    fn calendar() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2026, 8, 1), 20666);
        assert_eq!(civil_from_days(20666), (2026, 8, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(days_in_month(2024, 2), 29);
        assert_eq!(days_in_month(1900, 2), 28);
    }

    #[test]
    fn atomic_write_leaves_no_tmp() {
        let t = TempDir::new();
        write_atomic(t.path(), "x.prom", "a 1\n").unwrap();
        let names: Vec<_> = std::fs::read_dir(t.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["x.prom"]);
        assert_eq!(std::fs::read_to_string(t.path().join("x.prom")).unwrap(), "a 1\n");
    }

    #[test]
    fn system_runner() {
        assert_eq!(
            run(&System, &["sh", "-c", "printf hi; exit 3"], None).unwrap(),
            (3, b"hi".to_vec())
        );
        assert!(run(&System, &["definitely-not-a-command-xyz"], None).is_err());
        let e = run(&System, &["sleep", "5"], Some(Duration::from_millis(100))).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::TimedOut);
    }
}
