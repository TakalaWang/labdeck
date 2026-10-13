//! `smart.prom`: SMART health from `smartctl -j` (lab-smartmon.timer, hourly).

use crate::util::{esc, py_float, run, sorted_lines, Runner};
use serde_json::{Map, Value};
use std::time::Duration;

const TIMEOUT: Option<Duration> = Some(Duration::from_secs(120));

/// The JSON object smartctl printed; `{}` when it is missing, hung or printed something else.
/// The exit status is a bitmask of warnings, so the JSON is parsed whatever it is.
fn smartctl(r: &dyn Runner, args: &[&str]) -> Map<String, Value> {
    let argv: Vec<&str> = ["smartctl", "-j"].iter().chain(args).copied().collect();
    match run(r, &argv, TIMEOUT).map(|(_, out)| serde_json::from_slice(&out)) {
        Ok(Ok(Value::Object(m))) => m,
        _ => Map::new(),
    }
}

/// `d.get(a, {}).get(b)`.
fn get2<'a>(d: &'a Map<String, Value>, a: &str, b: &str) -> Option<&'a Value> {
    d.get(a)?.as_object()?.get(b)
}

/// Python's `str()` of a JSON value.
fn py_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "None".into(),
        Value::Bool(b) => if *b { "True" } else { "False" }.into(),
        Value::Number(n) => py_num(n),
        other => other.to_string(),
    }
}

fn py_num(n: &serde_json::Number) -> String {
    if n.is_i64() || n.is_u64() {
        n.to_string()
    } else {
        py_float(n.as_f64().unwrap_or(f64::NAN))
    }
}

/// Python truthiness.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

fn device_metrics(r: &dyn Runner, dev: &Map<String, Value>) -> Vec<String> {
    let Some(name) = dev.get("name").map(py_str) else {
        return Vec::new();
    };
    let dtype = dev.get("type").and_then(Value::as_str).unwrap_or("");
    // megaraid,N / cciss,N share one device node, so keep the type in the label.
    let label = if dtype.contains(',') {
        format!("{name} {dtype}")
    } else {
        name.clone()
    };
    let d = if dtype.is_empty() {
        smartctl(r, &["-a", &name])
    } else {
        smartctl(r, &["-a", "-d", dtype, &name])
    };
    let mut lines = Vec::new();
    let mut add = |metric: &str, value: Option<String>, extra: &[(&str, String)]| {
        if let Some(value) = value {
            let labels: Vec<String> = std::iter::once(("device", label.clone()))
                .chain(extra.iter().cloned())
                .map(|(k, v)| format!("{k}=\"{}\"", esc(&v)))
                .collect();
            lines.push(format!("{metric}{{{}}} {value}", labels.join(",")));
        }
    };
    // Only numbers (not booleans) become samples.
    let num = |v: Option<&Value>| v.and_then(Value::as_number).map(py_num);

    let passed = match get2(&d, "smart_status", "passed") {
        Some(Value::Bool(b)) => Some(u8::from(*b).to_string()),
        Some(Value::Number(n)) => n.as_f64().map(|f| (f.trunc() as i64).to_string()),
        _ => None,
    };
    if passed.is_some() {
        let model = ["model_name", "scsi_model_name", "product"]
            .iter()
            .find_map(|k| d.get(*k).filter(|v| truthy(v)))
            .map(py_str)
            .unwrap_or_default();
        let serial = d.get("serial_number").map(py_str).unwrap_or_default();
        add("lab_smart_healthy", passed, &[("model", model), ("serial", serial)]);
    }
    add(
        "lab_smart_temperature_celsius",
        num(get2(&d, "temperature", "current")),
        &[],
    );
    let table = get2(&d, "ata_smart_attributes", "table").and_then(Value::as_array);
    // The last attribute with a given id wins, as in a dict comprehension.
    let raw = |id: f64| {
        table?
            .iter()
            .rev()
            .find(|a| a.get("id").and_then(Value::as_f64) == Some(id))
            .and_then(|a| a.get("raw")?.get("value"))
    };
    add("lab_smart_reallocated_sectors", num(raw(5.0)), &[]);
    add("lab_smart_pending_sectors", num(raw(197.0)), &[]);
    let nvme = "nvme_smart_health_information_log";
    add(
        "lab_smart_nvme_percentage_used",
        num(get2(&d, nvme, "percentage_used")),
        &[],
    );
    add("lab_smart_nvme_media_errors", num(get2(&d, nvme, "media_errors")), &[]);
    lines
}

pub fn metrics(r: &dyn Runner) -> String {
    let scan = smartctl(r, &["--scan-open"]);
    let mut lines = Vec::new();
    for dev in scan.get("devices").and_then(Value::as_array).into_iter().flatten() {
        if let Some(dev) = dev.as_object() {
            lines.extend(device_metrics(r, dev));
        }
    }
    sorted_lines(lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    fn fake(args: &[String]) -> io::Result<(i32, Vec<u8>)> {
        let fixture = match args[2..].join(" ").as_str() {
            "--scan-open" => include_str!("../tests/fixtures/smart/scan.json"),
            "-a /dev/sda" => include_str!("../tests/fixtures/smart/sda.json"),
            "-a -d nvme /dev/nvme0" => include_str!("../tests/fixtures/smart/nvme0.json"),
            "-a -d megaraid,3 /dev/bus/0" => include_str!("../tests/fixtures/smart/megaraid3.json"),
            "-a -d sat /dev/sdb" => "not json",
            "-a /dev/sdc" => return Err(io::Error::from(io::ErrorKind::TimedOut)),
            other => panic!("unexpected smartctl {other}"),
        };
        Ok((4, fixture.as_bytes().to_vec())) // non-zero: a warning bit, the JSON is still read
    }

    #[test]
    fn golden() {
        // Golden file produced by the old smartmon.py with the same fixtures.
        assert_eq!(metrics(&fake), include_str!("../tests/golden/smart.prom"));
    }

    #[test]
    fn no_smartctl() {
        let missing = |_: &[String]| -> io::Result<(i32, Vec<u8>)> { Err(io::Error::from(io::ErrorKind::NotFound)) };
        assert_eq!(metrics(&missing), "");
    }
}
