#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid as UnixPid;
use serde::Serialize;
use sysinfo::{Pid, PidExt, Process, ProcessExt, System, SystemExt};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessInfo {
    pid: i32,
    parent_pid: Option<i32>,
    name: String,
    exe: Option<String>,
    cmd: String,
    status: String,
    cpu_percent: f32,
    memory_bytes: u64,
    virtual_memory_bytes: u64,
    read_bytes: u64,
    written_bytes: u64,
    run_time_seconds: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessSnapshot {
    collected_at_epoch_ms: u128,
    process_count: usize,
    processes: Vec<ProcessInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessDetails {
    process: ProcessInfo,
    open_file_handles: Option<u32>,
    cwd: Option<String>,
    root: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortInfo {
    protocol: String,
    local_address: String,
    port: u16,
    state: Option<String>,
    pid: Option<i32>,
    process_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct KillError {
    pid: i32,
    error: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct KillReport {
    matched: usize,
    attempted: usize,
    killed: Vec<i32>,
    failed: Vec<KillError>,
}

fn pid_to_i32(pid: Pid) -> i32 {
    pid.as_u32() as i32
}

fn path_to_string(path: &Path) -> Option<String> {
    if path.as_os_str().is_empty() {
        None
    } else {
        Some(path.display().to_string())
    }
}

fn process_to_info(pid: Pid, process: &Process) -> ProcessInfo {
    let disk_usage = process.disk_usage();

    ProcessInfo {
        pid: pid_to_i32(pid),
        parent_pid: process.parent().map(pid_to_i32),
        name: process.name().to_string(),
        exe: path_to_string(process.exe()),
        cmd: process.cmd().join(" "),
        status: format!("{:?}", process.status()),
        cpu_percent: process.cpu_usage(),
        memory_bytes: process.memory().saturating_mul(1024),
        virtual_memory_bytes: process.virtual_memory().saturating_mul(1024),
        read_bytes: disk_usage.total_read_bytes,
        written_bytes: disk_usage.total_written_bytes,
        run_time_seconds: process.run_time(),
    }
}

fn collect_processes() -> Vec<ProcessInfo> {
    let mut system = System::new_all();
    system.refresh_all();

    let mut processes = system
        .processes()
        .iter()
        .map(|(pid, process)| process_to_info(*pid, process))
        .collect::<Vec<_>>();

    processes.sort_by(|a, b| {
        b.cpu_percent
            .partial_cmp(&a.cpu_percent)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.memory_bytes.cmp(&a.memory_bytes))
            .then_with(|| a.pid.cmp(&b.pid))
    });

    processes
}

fn parse_endpoint(endpoint: &str) -> Option<(String, u16)> {
    let local = endpoint.split("->").next()?.trim();

    let separator = local.rfind(':')?;
    let (address, port_text) = local.split_at(separator);
    let port = port_text.trim_start_matches(':').parse::<u16>().ok()?;

    let normalized_address = address.trim_matches(|c| c == '[' || c == ']').to_string();
    let local_address = if normalized_address.is_empty() {
        "*".to_string()
    } else {
        normalized_address
    };

    Some((local_address, port))
}

fn parse_lsof_line(line: &str) -> Option<PortInfo> {
    if line.trim().is_empty() || line.starts_with("COMMAND") {
        return None;
    }

    let columns = line.split_whitespace().collect::<Vec<_>>();
    if columns.len() < 9 {
        return None;
    }

    let process_name = columns[0].to_string();
    let pid = columns[1].parse::<i32>().ok();
    let protocol = columns[7].to_ascii_uppercase();

    let name_segment = columns[8..].join(" ");
    let (endpoint, state) = if let Some(idx) = name_segment.find(" (") {
        let (ep, rest) = name_segment.split_at(idx);
        (
            ep.trim().to_string(),
            Some(
                rest.trim()
                    .trim_start_matches('(')
                    .trim_end_matches(')')
                    .to_string(),
            ),
        )
    } else {
        (name_segment.trim().to_string(), None)
    };

    let (local_address, port) = parse_endpoint(&endpoint)?;

    Some(PortInfo {
        protocol,
        local_address,
        port,
        state,
        pid,
        process_name: Some(process_name),
    })
}

fn collect_ports() -> Result<Vec<PortInfo>, String> {
    let output = Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-iUDP"])
        .output()
        .map_err(|error| format!("Failed to run lsof: {error}"))?;

    if !output.status.success() {
        return Err(format!(
            "lsof exited with status {:?}",
            output.status.code()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut ports = stdout
        .lines()
        .filter_map(parse_lsof_line)
        .collect::<Vec<_>>();

    let mut seen = HashSet::new();
    ports.retain(|entry| {
        let key = format!(
            "{}:{}:{}:{}:{:?}",
            entry.protocol,
            entry.local_address,
            entry.port,
            entry.pid.unwrap_or_default(),
            entry.state
        );
        seen.insert(key)
    });

    ports.sort_by(|a, b| {
        a.port
            .cmp(&b.port)
            .then_with(|| a.protocol.cmp(&b.protocol))
            .then_with(|| a.pid.unwrap_or_default().cmp(&b.pid.unwrap_or_default()))
    });

    Ok(ports)
}

fn count_open_file_handles(pid: i32) -> Option<u32> {
    let output = Command::new("lsof")
        .args(["-nP", "-p", &pid.to_string()])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let count = stdout.lines().count().saturating_sub(1);
    Some(count as u32)
}

fn build_child_map(processes: &[ProcessInfo]) -> HashMap<i32, Vec<i32>> {
    let mut child_map = HashMap::<i32, Vec<i32>>::new();

    for process in processes {
        if let Some(parent_pid) = process.parent_pid {
            child_map.entry(parent_pid).or_default().push(process.pid);
        }
    }

    child_map
}

fn collect_descendants(root_pid: i32, child_map: &HashMap<i32, Vec<i32>>, out: &mut Vec<i32>) {
    if let Some(children) = child_map.get(&root_pid) {
        for child_pid in children {
            collect_descendants(*child_pid, child_map, out);
            out.push(*child_pid);
        }
    }
}

fn dedupe_pids(pids: Vec<i32>) -> Vec<i32> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();

    for pid in pids {
        if seen.insert(pid) {
            deduped.push(pid);
        }
    }

    deduped
}

fn resolve_signal(force: Option<bool>) -> Signal {
    if force.unwrap_or(false) {
        Signal::SIGKILL
    } else {
        Signal::SIGTERM
    }
}

fn perform_kill(targets: Vec<i32>, matched: usize, signal: Signal) -> KillReport {
    let self_pid = std::process::id() as i32;

    let mut attempted = 0usize;
    let mut killed = Vec::<i32>::new();
    let mut failed = Vec::<KillError>::new();

    for pid in targets {
        if pid <= 0 || pid == self_pid {
            continue;
        }

        attempted += 1;
        match kill(UnixPid::from_raw(pid), signal) {
            Ok(_) => killed.push(pid),
            Err(error) => failed.push(KillError {
                pid,
                error: error.to_string(),
            }),
        }
    }

    KillReport {
        matched,
        attempted,
        killed,
        failed,
    }
}

#[tauri::command]
fn get_process_snapshot() -> Result<ProcessSnapshot, String> {
    let processes = collect_processes();

    let collected_at_epoch_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Clock error: {error}"))?
        .as_millis();

    Ok(ProcessSnapshot {
        collected_at_epoch_ms,
        process_count: processes.len(),
        processes,
    })
}

#[tauri::command]
fn get_process_details(pid: i32) -> Result<ProcessDetails, String> {
    if pid <= 0 {
        return Err("PID must be a positive integer".to_string());
    }

    let mut system = System::new_all();
    system.refresh_all();

    let target_pid = Pid::from_u32(pid as u32);
    let process = system
        .process(target_pid)
        .ok_or_else(|| format!("Process {pid} was not found"))?;

    Ok(ProcessDetails {
        process: process_to_info(target_pid, process),
        open_file_handles: count_open_file_handles(pid),
        cwd: path_to_string(process.cwd()),
        root: path_to_string(process.root()),
    })
}

#[tauri::command]
fn list_open_ports() -> Result<Vec<PortInfo>, String> {
    collect_ports()
}

#[tauri::command]
fn kill_process(
    pid: i32,
    include_children: Option<bool>,
    force: Option<bool>,
) -> Result<KillReport, String> {
    if pid <= 0 {
        return Err("PID must be a positive integer".to_string());
    }

    let processes = collect_processes();
    if !processes.iter().any(|process| process.pid == pid) {
        return Err(format!("Process {pid} was not found"));
    }

    let child_map = build_child_map(&processes);

    let mut targets = Vec::<i32>::new();
    if include_children.unwrap_or(true) {
        collect_descendants(pid, &child_map, &mut targets);
    }
    targets.push(pid);

    let deduped = dedupe_pids(targets);

    Ok(perform_kill(deduped, 1, resolve_signal(force)))
}

#[tauri::command]
fn kill_matching_processes(
    query: String,
    include_children: Option<bool>,
    force: Option<bool>,
) -> Result<KillReport, String> {
    let normalized_query = query.trim().to_ascii_lowercase();
    if normalized_query.is_empty() {
        return Err("Query cannot be empty".to_string());
    }

    let processes = collect_processes();
    let child_map = build_child_map(&processes);

    let matched_roots = processes
        .iter()
        .filter_map(|process| {
            let name_match = process
                .name
                .to_ascii_lowercase()
                .contains(&normalized_query);
            let cmd_match = process.cmd.to_ascii_lowercase().contains(&normalized_query);
            if name_match || cmd_match {
                Some(process.pid)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    if matched_roots.is_empty() {
        return Ok(KillReport {
            matched: 0,
            attempted: 0,
            killed: Vec::new(),
            failed: Vec::new(),
        });
    }

    let mut targets = Vec::<i32>::new();

    for root_pid in &matched_roots {
        if include_children.unwrap_or(true) {
            collect_descendants(*root_pid, &child_map, &mut targets);
        }
        targets.push(*root_pid);
    }

    let deduped = dedupe_pids(targets);

    Ok(perform_kill(
        deduped,
        matched_roots.len(),
        resolve_signal(force),
    ))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_process_snapshot,
            get_process_details,
            list_open_ports,
            kill_process,
            kill_matching_processes
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
