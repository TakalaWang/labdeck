//! `gpu.prom`: GPU metrics from nvidia-smi, refreshed every 15 s (lab-gpu.service).

use crate::util::{esc, run, sorted_lines, Runner};
use std::collections::HashMap;
use std::time::Duration;

pub const INTERVAL: Duration = Duration::from_secs(15);
const SMI_TIMEOUT: Option<Duration> = Some(Duration::from_secs(10));
const MIB: u64 = 1_048_576;

/// The fields of one CSV line as bash's `IFS=, read -ra f` + `f=("${f[@]# }")` gives them:
/// one trailing empty field is dropped, and one leading space is removed from each field.
fn csv_fields(line: &str) -> Vec<&str> {
    if line.is_empty() {
        return Vec::new();
    }
    let mut f: Vec<&str> = line.split(',').collect();
    if f.last() == Some(&"") {
        f.pop();
    }
    f.into_iter().map(|x| x.strip_prefix(' ').unwrap_or(x)).collect()
}

/// `^[0-9]+([.][0-9]+)?$`
fn is_decimal(s: &str) -> bool {
    let (int, frac) = match s.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (s, None),
    };
    is_uint(int) && frac.is_none_or(is_uint)
}

/// `^[0-9]+$`
fn is_uint(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// The text after `$(...)` (trailing newlines stripped), split into the lines `while read` sees.
fn lines(out: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(out);
    let text = text.trim_end_matches('\n');
    if text.is_empty() {
        return Vec::new();
    }
    text.split('\n').map(str::to_string).collect()
}

/// `read -r user comm` on the first line: first word, then the rest without surrounding blanks.
fn user_comm(out: &[u8]) -> Option<(String, String)> {
    let text = String::from_utf8_lossy(out);
    let line = text.split('\n').next().filter(|_| text.contains('\n'))?;
    let blank = |c: char| c == ' ' || c == '\t';
    let line = line.trim_matches(blank);
    let (user, comm) = line.split_once(blank).unwrap_or((line, ""));
    Some((user.to_string(), comm.trim_matches(blank).to_string()))
}

pub fn metrics(r: &dyn Runner) -> String {
    let mut out = Vec::new();
    let pci = run(r, &["lspci", "-d", "10de:", "-n"], SMI_TIMEOUT)
        .map(|(_, o)| o)
        .unwrap_or_default();
    let pci = String::from_utf8_lossy(&pci)
        .lines()
        .filter(|l| {
            l.split_whitespace()
                .nth(1)
                .is_some_and(|f| f.starts_with("0300:") || f.starts_with("0302:"))
        })
        .count();
    out.push(format!("lab_gpu_pci_count {pci}"));
    let query = "--query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw";
    let gpus = match run(r, &["nvidia-smi", "--format=csv,noheader,nounits", query], SMI_TIMEOUT) {
        Ok((0, o)) => lines(&o),
        _ => {
            out.push("lab_nvidia_smi_ok 0".into());
            out.push("lab_gpu_smi_count 0".into());
            return sorted_lines(out);
        }
    };
    out.push("lab_nvidia_smi_ok 1".into());
    out.push(format!(
        "lab_gpu_smi_count {}",
        gpus.iter().filter(|l| !l.is_empty()).count()
    ));
    let mut idx: HashMap<String, String> = HashMap::new();
    for line in &gpus {
        let f = csv_fields(line);
        if f.len() != 8 {
            continue;
        }
        idx.insert(f[1].to_string(), f[0].to_string());
        let l = format!("gpu=\"{}\",uuid=\"{}\"", f[0], f[1]);
        out.push(format!("lab_gpu_info{{{l},name=\"{}\"}} 1", esc(f[2])));
        if is_decimal(f[3]) {
            out.push(format!("lab_gpu_utilization_percent{{{l}}} {}", f[3]));
        }
        if let Some(v) = f[4].parse::<u64>().ok().filter(|_| is_uint(f[4])) {
            out.push(format!("lab_gpu_memory_used_bytes{{{l}}} {}", v * MIB));
        }
        if let Some(v) = f[5].parse::<u64>().ok().filter(|_| is_uint(f[5])) {
            out.push(format!("lab_gpu_memory_total_bytes{{{l}}} {}", v * MIB));
        }
        if is_decimal(f[6]) {
            out.push(format!("lab_gpu_temperature_celsius{{{l}}} {}", f[6]));
        }
        if is_decimal(f[7]) {
            out.push(format!("lab_gpu_power_watts{{{l}}} {}", f[7]));
        }
    }
    let apps = "--query-compute-apps=gpu_uuid,pid,used_memory";
    let apps = run(r, &["nvidia-smi", apps, "--format=csv,noheader,nounits"], SMI_TIMEOUT)
        .map(|(_, o)| lines(&o))
        .unwrap_or_default();
    for line in &apps {
        let f = csv_fields(line);
        if f.len() != 3 || !is_uint(f[1]) || !is_uint(f[2]) {
            continue;
        }
        let Ok(mem) = f[2].parse::<u64>() else { continue };
        let ps = run(r, &["ps", "-o", "user:32=,comm=", "-p", f[1]], None)
            .map(|(_, o)| o)
            .unwrap_or_default();
        let Some((user, comm)) = user_comm(&ps) else { continue };
        out.push(format!(
            "lab_gpu_process_memory_bytes{{gpu=\"{}\",uuid=\"{}\",user=\"{}\",pid=\"{}\",comm=\"{}\"}} {}",
            idx.get(f[0]).map_or("", String::as_str),
            f[0],
            esc(&user),
            f[1],
            esc(&comm),
            mem * MIB
        ));
    }
    sorted_lines(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    const LSPCI: &str = include_str!("../tests/fixtures/gpu/lspci.txt");

    /// Canned outputs; the old gpu.sh produced the golden file from the same fixtures.
    fn fake(args: &[String]) -> io::Result<(i32, Vec<u8>)> {
        let out = match args[0].as_str() {
            "lspci" => LSPCI,
            "nvidia-smi" if args[1].starts_with("--format") => include_str!("../tests/fixtures/gpu/query-gpu.csv"),
            "nvidia-smi" => include_str!("../tests/fixtures/gpu/query-compute-apps.csv"),
            "ps" => match args[4].as_str() {
                "4242" => include_str!("../tests/fixtures/gpu/ps-4242.txt"),
                "4243" => include_str!("../tests/fixtures/gpu/ps-4243.txt"),
                "4244" => include_str!("../tests/fixtures/gpu/ps-4244.txt"),
                _ => return Ok((1, Vec::new())), // exited since nvidia-smi listed it
            },
            _ => unreachable!(),
        };
        Ok((0, out.as_bytes().to_vec()))
    }

    #[test]
    fn golden() {
        assert_eq!(metrics(&fake), include_str!("../tests/golden/gpu.prom"));
    }

    #[test]
    fn no_nvidia_smi() {
        let missing = |args: &[String]| -> io::Result<(i32, Vec<u8>)> {
            match args[0].as_str() {
                "lspci" => Ok((0, LSPCI.as_bytes().to_vec())),
                _ => Err(io::Error::from(io::ErrorKind::NotFound)),
            }
        };
        assert_eq!(
            metrics(&missing),
            "lab_gpu_pci_count 3\nlab_gpu_smi_count 0\nlab_nvidia_smi_ok 0\n"
        );
        let failing = |args: &[String]| -> io::Result<(i32, Vec<u8>)> {
            match args[0].as_str() {
                "lspci" => Err(io::Error::from(io::ErrorKind::NotFound)),
                _ => Ok((9, b"NVIDIA-SMI has failed\n".to_vec())),
            }
        };
        assert_eq!(
            metrics(&failing),
            "lab_gpu_pci_count 0\nlab_gpu_smi_count 0\nlab_nvidia_smi_ok 0\n"
        );
    }

    #[test]
    fn bash_field_splitting() {
        assert_eq!(csv_fields("0, a,  b,"), ["0", "a", " b"]);
        assert_eq!(csv_fields("a,,"), ["a", ""]);
        assert!(csv_fields("").is_empty());
        assert!(is_decimal("12.5") && is_decimal("7") && !is_decimal("1.") && !is_decimal("[N/A]"));
        assert_eq!(
            user_comm(b"  root   my  prog \n"),
            Some(("root".into(), "my  prog".into()))
        );
        assert_eq!(user_comm(b""), None);
    }
}
