//! labdeck-agent: LabDeck's host-side collectors in one static binary (docs/design.md 約定 D, E).

mod du;
mod facts;
mod gpu;
mod procs;
mod smart;
mod util;

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use util::{write_atomic, System};

const USAGE: &str = "usage:
  labdeck-agent textfile gpu   [--dir DIR] [--once]         gpu.prom every 15 s
  labdeck-agent textfile procs [--dir DIR] [--once] [--proc DIR]   procs.prom every 30 s (5 s sample)
  labdeck-agent textfile du ROOT_GLOB OUTFILE [--dir DIR]   e.g. du /home du_home.prom; du '/data*' du_data.prom
  labdeck-agent textfile smart [--dir DIR]                  smart.prom
  labdeck-agent facts INVENTORY_HOSTNAME [DATA_MOUNT_GLOB]  collect JSON on stdout (glob default /data*)
DIR defaults to /var/lib/node_exporter/textfile.";

struct Args {
    positional: Vec<String>,
    dir: PathBuf,
    proc: PathBuf,
    once: bool,
}

fn parse(args: impl Iterator<Item = String>) -> Option<Args> {
    let mut a = Args {
        positional: Vec::new(),
        dir: "/var/lib/node_exporter/textfile".into(),
        proc: "/proc".into(),
        once: false,
    };
    let mut args = args.peekable();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--dir" => a.dir = args.next()?.into(),
            "--proc" => a.proc = args.next()?.into(),
            "--once" => a.once = true,
            "-h" | "--help" => return None,
            _ if arg.starts_with("--") => return None,
            _ => a.positional.push(arg),
        }
    }
    Some(a)
}

fn write(dir: &Path, name: &str, text: &str) -> bool {
    match write_atomic(dir, name, text) {
        Ok(()) => true,
        Err(e) => {
            eprintln!("labdeck-agent: writing {}: {e}", dir.join(name).display());
            false
        }
    }
}

fn main() -> ExitCode {
    let Some(a) = parse(std::env::args().skip(1)) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let pos: Vec<&str> = a.positional.iter().map(String::as_str).collect();
    let ok = match pos[..] {
        ["textfile", "gpu"] => loop {
            let ok = write(&a.dir, "gpu.prom", &gpu::metrics(&System));
            if a.once {
                break ok;
            }
            std::thread::sleep(gpu::INTERVAL);
        },
        ["textfile", "procs"] => {
            let hz = procs::clock_ticks();
            let lookup = |uid| procs::lookup_user(&System, uid);
            let start = Instant::now();
            let mut clock = || start.elapsed().as_secs_f64();
            loop {
                let ok = match procs::sample(&a.proc, hz, &lookup, &mut clock, &mut || {
                    std::thread::sleep(procs::SAMPLE)
                }) {
                    Ok(users) => write(&a.dir, "procs.prom", &procs::render(&users)),
                    Err(e) => {
                        eprintln!("labdeck-agent: reading {}: {e}", a.proc.display());
                        false
                    }
                };
                if a.once {
                    break ok;
                }
                std::thread::sleep(procs::INTERVAL - procs::SAMPLE);
            }
        }
        ["textfile", "du", pattern, out] => {
            let now = || SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
            write(&a.dir, out, &du::report(pattern, &System, &now))
        }
        ["textfile", "smart"] => write(&a.dir, "smart.prom", &smart::metrics(&System)),
        ["facts", host] | ["facts", host, _] => {
            let glob = pos.get(2).copied().unwrap_or("/data*");
            let doc = facts::collect(host, glob, &System);
            println!("{}", serde_json::to_string(&doc).expect("serializable"));
            true
        }
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
