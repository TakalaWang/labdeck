//! `du_home.prom` / `du_data.prom`: disk usage of each top-level directory under the roots matching a glob.
//! lab-du-*.service runs it with Nice=19, IOSchedulingClass=idle and a 6 h timeout (a scan killed by the
//! timeout writes nothing, so the previous file stays and goes stale).

use crate::util::{esc, glob, sorted_lines, Runner};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::Path;

/// `pattern` is expanded like an unquoted shell word (e.g. `/data*`); `now` gives the success timestamp.
pub fn report(pattern: &str, r: &dyn Runner, now: &dyn Fn() -> u64) -> String {
    let mut out = Vec::new();
    for root in glob(pattern) {
        if !Path::new(&root).is_dir() {
            continue;
        }
        // "$root"/*/ minus symlinks: real directories, hidden ones excluded like the shell glob does.
        let mut dirs: Vec<_> = fs::read_dir(&root)
            .map(|it| it.filter_map(Result::ok).collect())
            .unwrap_or_default();
        dirs.retain(|e| !e.file_name().as_encoded_bytes().starts_with(b".") && e.file_type().is_ok_and(|t| t.is_dir()));
        dirs.sort_by_key(|e| e.file_name());
        for e in dirs {
            let mut path = OsString::from(&root);
            path.push("/");
            path.push(e.file_name());
            let path = path.as_os_str();
            let du = r.run(
                &[
                    OsStr::new("du"),
                    OsStr::new("-sb"),
                    OsStr::new("--one-file-system"),
                    path,
                ],
                None,
            );
            let Ok((_, du)) = du else { continue };
            let du = String::from_utf8_lossy(&du);
            let bytes = du.split('\t').next().unwrap_or("");
            if bytes.is_empty() || !bytes.bytes().all(|b| b.is_ascii_digit()) {
                continue;
            }
            let owner = r
                .run(&[OsStr::new("stat"), OsStr::new("-c"), OsStr::new("%U"), path], None)
                .map(|(_, o)| String::from_utf8_lossy(&o).trim_end_matches('\n').to_string())
                .unwrap_or_default();
            out.push(format!(
                "lab_user_disk_bytes{{root=\"{}\",path=\"{}\",owner=\"{}\"}} {bytes}",
                esc(&root),
                esc(&path.to_string_lossy()),
                esc(&owner)
            ));
        }
        out.push(format!(
            "lab_du_success_timestamp_seconds{{root=\"{}\"}} {}",
            esc(&root),
            now()
        ));
    }
    sorted_lines(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::testutil::TempDir;
    use std::io;

    /// A fixture tree; `du` and `stat` answers are canned so the golden file does not depend on the filesystem.
    fn tree(t: &TempDir) {
        let p = t.path();
        for d in [
            "home/alice/sub",
            "home/bob",
            "home/.hidden",
            "home/we\"ird\\name",
            "home/new\nline",
            "data0/proj",
            "data1/scratch",
            "data1/empty",
            "datafile-dir/x",
        ] {
            fs::create_dir_all(p.join(d)).unwrap();
        }
        fs::write(p.join("home/plainfile"), "x").unwrap();
        fs::write(p.join("data9"), "not a dir").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(p.join("home/alice"), p.join("home/link")).unwrap();
    }

    fn fake(args: &[String]) -> io::Result<(i32, Vec<u8>)> {
        let name = args.last().unwrap().rsplit('/').next().unwrap().to_string();
        match args[0].as_str() {
            "du" if name == "empty" => Ok((1, Vec::new())), // e.g. vanished during the scan
            "du" => Ok((1, format!("{}\t{}\n", 4096 * (name.len() as u64), args[3]).into_bytes())), // exit 1: some files unreadable
            "stat" if name == "bob" => Ok((1, Vec::new())),
            "stat" if name == "scratch" => Ok((0, b"UNKNOWN\n".to_vec())),
            "stat" => Ok((0, b"alice\n".to_vec())),
            _ => unreachable!(),
        }
    }

    #[test]
    fn golden() {
        let t = TempDir::new();
        tree(&t);
        let base = t.path().to_str().unwrap();
        let home = report(&format!("{base}/home"), &fake, &|| 1790000000).replace(base, "BASE");
        assert_eq!(home, include_str!("../tests/golden/du_home.prom"));
        let data = report(&format!("{base}/data*"), &fake, &|| 1790000000).replace(base, "BASE");
        assert_eq!(data, include_str!("../tests/golden/du_data.prom"));
        assert_eq!(report(&format!("{base}/nothing*"), &fake, &|| 1), "");
    }
}
