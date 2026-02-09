const tauriGlobal = window.__TAURI__;
const invoke =
  tauriGlobal?.core?.invoke ??
  tauriGlobal?.tauri?.invoke ??
  tauriGlobal?.invoke;

const state = {
  processes: [],
  ports: [],
  selectedPid: null,
  processSearch: "",
  portSearch: "",
  sortBy: "cpu",
  treeMode: true,
  autoRefresh: true,
  refreshTimer: null,
  isRefreshing: false,
};

const el = {};
const PANE_STORAGE_KEY = "pswtf-left-pane-width";
const PANE_MIN_LEFT = 520;
const PANE_MIN_RIGHT = 320;
const PANE_DIVIDER_WIDTH = 12;
const PANE_MOBILE_BREAKPOINT = 1100;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatBytes(bytes) {
  if (!bytes || Number.isNaN(bytes)) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatCpu(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) {
    return "0.0";
  }
  return n.toFixed(1);
}

function formatEpochMs(epochMs) {
  if (!epochMs) {
    return "-";
  }
  return new Date(Number(epochMs)).toLocaleTimeString();
}

function setStatus(message, level = "info") {
  el.statusBar.textContent = message;
  el.statusBar.classList.remove("badge-warn");
  if (level === "warn") {
    el.statusBar.classList.add("badge-warn");
  }
}

async function call(command, args = {}) {
  if (!invoke) {
    throw new Error("Tauri invoke bridge not found. Check withGlobalTauri config and relaunch.");
  }
  return invoke(command, args);
}

function isSplitViewActive() {
  return window.innerWidth > PANE_MOBILE_BREAKPOINT;
}

function readStoredPaneWidth() {
  try {
    const storedValue = Number(window.localStorage.getItem(PANE_STORAGE_KEY));
    if (Number.isFinite(storedValue) && storedValue > 0) {
      return storedValue;
    }
  } catch (_) {}
  return null;
}

function writeStoredPaneWidth(width) {
  try {
    window.localStorage.setItem(PANE_STORAGE_KEY, String(Math.round(width)));
  } catch (_) {}
}

function clampPaneWidth(leftWidth) {
  const totalWidth = el.mainGrid.getBoundingClientRect().width;
  const maxLeft = Math.max(PANE_MIN_LEFT, totalWidth - PANE_DIVIDER_WIDTH - PANE_MIN_RIGHT);
  return Math.min(Math.max(leftWidth, PANE_MIN_LEFT), maxLeft);
}

function applyPaneLayout(leftWidth) {
  if (!isSplitViewActive()) {
    el.mainGrid.style.gridTemplateColumns = "";
    return;
  }

  const totalWidth = el.mainGrid.getBoundingClientRect().width;
  const clampedLeft = clampPaneWidth(leftWidth);
  const rightWidth = Math.max(PANE_MIN_RIGHT, totalWidth - PANE_DIVIDER_WIDTH - clampedLeft);

  el.mainGrid.style.gridTemplateColumns = `${Math.round(clampedLeft)}px ${PANE_DIVIDER_WIDTH}px ${Math.round(rightWidth)}px`;
}

function setupPaneResize() {
  let isDragging = false;
  let dragStartX = 0;
  let dragStartWidth = 0;

  const restorePaneWidth = () => {
    if (!isSplitViewActive()) {
      el.mainGrid.style.gridTemplateColumns = "";
      return;
    }

    const storedWidth = readStoredPaneWidth();
    if (storedWidth) {
      applyPaneLayout(storedWidth);
      return;
    }

    const defaultLeftWidth = el.processPanel.getBoundingClientRect().width;
    if (defaultLeftWidth > 0) {
      applyPaneLayout(defaultLeftWidth);
    }
  };

  const endDrag = (event) => {
    if (!isDragging) {
      return;
    }

    isDragging = false;
    document.body.classList.remove("resizing-panes");

    if (event && typeof event.pointerId === "number" && el.paneDivider.hasPointerCapture(event.pointerId)) {
      el.paneDivider.releasePointerCapture(event.pointerId);
    }
  };

  el.paneDivider.addEventListener("pointerdown", (event) => {
    if (!isSplitViewActive()) {
      return;
    }

    isDragging = true;
    dragStartX = event.clientX;
    dragStartWidth = el.processPanel.getBoundingClientRect().width;
    document.body.classList.add("resizing-panes");
    el.paneDivider.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  el.paneDivider.addEventListener("pointermove", (event) => {
    if (!isDragging) {
      return;
    }

    const nextLeftWidth = dragStartWidth + (event.clientX - dragStartX);
    const clampedWidth = clampPaneWidth(nextLeftWidth);
    applyPaneLayout(clampedWidth);
    writeStoredPaneWidth(clampedWidth);
  });

  el.paneDivider.addEventListener("pointerup", endDrag);
  el.paneDivider.addEventListener("pointercancel", endDrag);

  el.paneDivider.addEventListener("keydown", (event) => {
    if (!isSplitViewActive()) {
      return;
    }

    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    const step = event.shiftKey ? 60 : 24;
    const currentLeftWidth = el.processPanel.getBoundingClientRect().width;
    const nextLeftWidth = event.key === "ArrowLeft" ? currentLeftWidth - step : currentLeftWidth + step;
    const clampedWidth = clampPaneWidth(nextLeftWidth);

    applyPaneLayout(clampedWidth);
    writeStoredPaneWidth(clampedWidth);
    event.preventDefault();
  });

  window.addEventListener("resize", () => {
    const storedWidth = readStoredPaneWidth();
    if (storedWidth) {
      applyPaneLayout(storedWidth);
      return;
    }
    restorePaneWidth();
  });

  restorePaneWidth();
}

function processMatchesQuery(process, query) {
  if (!query) {
    return true;
  }

  const q = query.toLowerCase();
  return (
    process.name.toLowerCase().includes(q) ||
    process.cmd.toLowerCase().includes(q) ||
    String(process.pid).includes(q) ||
    (process.status || "").toLowerCase().includes(q)
  );
}

function compareProcesses(a, b) {
  switch (state.sortBy) {
    case "memory":
      return (b.memoryBytes || 0) - (a.memoryBytes || 0) || a.pid - b.pid;
    case "pid":
      return a.pid - b.pid;
    case "name":
      return a.name.localeCompare(b.name) || a.pid - b.pid;
    case "cpu":
    default:
      return (b.cpuPercent || 0) - (a.cpuPercent || 0) || (b.memoryBytes || 0) - (a.memoryBytes || 0);
  }
}

function buildRows(processes) {
  const sorted = [...processes].sort(compareProcesses);

  if (!state.treeMode) {
    return sorted.map((process) => ({ process, depth: 0 }));
  }

  const byPid = new Map(sorted.map((process) => [process.pid, process]));
  const children = new Map();

  for (const process of sorted) {
    const parentKey = process.parentPid && byPid.has(process.parentPid) ? process.parentPid : null;
    if (!children.has(parentKey)) {
      children.set(parentKey, []);
    }
    children.get(parentKey).push(process);
  }

  for (const list of children.values()) {
    list.sort(compareProcesses);
  }

  const rows = [];
  const visited = new Set();

  function walk(parentPid, depth) {
    const list = children.get(parentPid) || [];
    for (const process of list) {
      if (visited.has(process.pid)) {
        continue;
      }
      visited.add(process.pid);
      rows.push({ process, depth });
      walk(process.pid, depth + 1);
    }
  }

  walk(null, 0);

  for (const process of sorted) {
    if (!visited.has(process.pid)) {
      rows.push({ process, depth: 0 });
    }
  }

  return rows;
}

function renderProcessTable() {
  const visible = state.processes.filter((process) => processMatchesQuery(process, state.processSearch));
  const rows = buildRows(visible);

  if (rows.length === 0) {
    el.processRows.innerHTML = `
      <tr>
        <td colspan="8">No process matches current filters.</td>
      </tr>
    `;
    return;
  }

  el.processRows.innerHTML = rows
    .map(({ process, depth }) => {
      const selected = process.pid === state.selectedPid ? "selected" : "";
      const padding = depth * 18;
      const branch = state.treeMode && depth > 0 ? "↳ " : "";

      return `
        <tr data-pid="${process.pid}" class="${selected}">
          <td>
            <div class="process-name" style="padding-left:${padding}px" title="${escapeHtml(process.cmd || process.name)}">${branch}${escapeHtml(process.name)}</div>
          </td>
          <td class="pid">${process.pid}</td>
          <td>${formatCpu(process.cpuPercent)}</td>
          <td>${formatBytes(process.memoryBytes)}</td>
          <td>${formatBytes(process.readBytes)}</td>
          <td>${formatBytes(process.writtenBytes)}</td>
          <td>${escapeHtml(process.status)}</td>
          <td>
            <div class="row-actions">
              <button data-action="kill" data-pid="${process.pid}">Kill</button>
              <button data-action="kill-tree" data-pid="${process.pid}">Kill Tree</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderPortTable() {
  const query = state.portSearch.trim().toLowerCase();

  const visible = state.ports.filter((port) => {
    if (!query) {
      return true;
    }

    return (
      String(port.port).includes(query) ||
      (port.protocol || "").toLowerCase().includes(query) ||
      (port.localAddress || "").toLowerCase().includes(query) ||
      String(port.pid ?? "").includes(query) ||
      (port.processName || "").toLowerCase().includes(query)
    );
  });

  if (visible.length === 0) {
    el.portRows.innerHTML = `
      <tr>
        <td colspan="7">No open ports match current filters.</td>
      </tr>
    `;
    return;
  }

  el.portRows.innerHTML = visible
    .map((port) => {
      const pid = port.pid ?? "-";
      const processName = port.processName || "-";
      const focusButton = port.pid
        ? `<button class="port-action" data-action="focus-pid" data-pid="${port.pid}">Select</button>`
        : "";

      return `
        <tr>
          <td class="pid">${port.port}</td>
          <td>${escapeHtml(port.protocol || "")}</td>
          <td>${escapeHtml(port.localAddress || "")}</td>
          <td>${escapeHtml(port.state || "-")}</td>
          <td class="pid">${pid}</td>
          <td>${escapeHtml(processName)}</td>
          <td>${focusButton}</td>
        </tr>
      `;
    })
    .join("");
}

function renderStats(snapshot, ports) {
  el.processCount.textContent = String(snapshot.processCount ?? state.processes.length);
  el.portCount.textContent = String(ports.length);
  el.lastRefresh.textContent = formatEpochMs(snapshot.collectedAtEpochMs);
}

function renderDetails(details) {
  const process = details.process;

  el.detailsBody.innerHTML = `
    <div class="row-actions" style="margin-bottom:10px">
      <button data-action="kill" data-pid="${process.pid}">Kill</button>
      <button data-action="kill-tree" data-pid="${process.pid}">Kill Tree</button>
    </div>
    <div class="details-grid">
      <div class="details-item"><span class="key">Name</span><span class="val">${escapeHtml(process.name)}</span></div>
      <div class="details-item"><span class="key">PID</span><span class="val">${process.pid}</span></div>
      <div class="details-item"><span class="key">Parent PID</span><span class="val">${process.parentPid ?? "-"}</span></div>
      <div class="details-item"><span class="key">Status</span><span class="val">${escapeHtml(process.status)}</span></div>
      <div class="details-item"><span class="key">CPU %</span><span class="val">${formatCpu(process.cpuPercent)}</span></div>
      <div class="details-item"><span class="key">Memory</span><span class="val">${formatBytes(process.memoryBytes)}</span></div>
      <div class="details-item"><span class="key">Virtual Memory</span><span class="val">${formatBytes(process.virtualMemoryBytes)}</span></div>
      <div class="details-item"><span class="key">Open File Handles</span><span class="val">${details.openFileHandles ?? "Unavailable"}</span></div>
      <div class="details-item"><span class="key">I/O Read</span><span class="val">${formatBytes(process.readBytes)}</span></div>
      <div class="details-item"><span class="key">I/O Written</span><span class="val">${formatBytes(process.writtenBytes)}</span></div>
      <div class="details-item"><span class="key">Runtime</span><span class="val">${process.runTimeSeconds}s</span></div>
      <div class="details-item"><span class="key">Executable</span><span class="val">${escapeHtml(process.exe || "-")}</span></div>
      <div class="details-item"><span class="key">Working Directory</span><span class="val">${escapeHtml(details.cwd || "-")}</span></div>
      <div class="details-item"><span class="key">Root</span><span class="val">${escapeHtml(details.root || "-")}</span></div>
      <div class="details-item" style="grid-column: 1 / -1"><span class="key">Command</span><span class="val">${escapeHtml(process.cmd || "-")}</span></div>
    </div>
  `;
}

async function loadDetails(pid) {
  try {
    const details = await call("get_process_details", { pid });
    renderDetails(details);
  } catch (error) {
    el.detailsBody.innerHTML = `<div class="details-empty">Failed to load details: ${escapeHtml(error.message || String(error))}</div>`;
  }
}

async function runKill(pid, includeChildren) {
  const label = includeChildren ? "this process and its child tree" : "this process";
  const confirmed = window.confirm(`Kill ${label}? PID ${pid}`);
  if (!confirmed) {
    return;
  }

  try {
    const result = await call("kill_process", {
      pid,
      includeChildren,
      force: false,
    });

    setStatus(
      `Kill request completed. matched=${result.matched}, attempted=${result.attempted}, killed=${result.killed.length}, failed=${result.failed.length}`,
      result.failed.length > 0 ? "warn" : "info",
    );

    if (state.selectedPid === pid) {
      state.selectedPid = null;
      el.detailsBody.innerHTML = "<div class='details-empty'>Select a process to inspect details.</div>";
    }

    await refreshAll();
  } catch (error) {
    setStatus(`Kill failed: ${error.message || String(error)}`, "warn");
  }
}

async function runBulkKill() {
  const query = el.bulkQuery.value.trim();
  if (!query) {
    setStatus("Enter a bulk query first (example: node).", "warn");
    return;
  }

  const confirmed = window.confirm(`Kill all processes matching "${query}" and their child processes?`);
  if (!confirmed) {
    return;
  }

  try {
    const result = await call("kill_matching_processes", {
      query,
      includeChildren: true,
      force: false,
    });

    setStatus(
      `Bulk kill completed. matched=${result.matched}, attempted=${result.attempted}, killed=${result.killed.length}, failed=${result.failed.length}`,
      result.failed.length > 0 ? "warn" : "info",
    );

    await refreshAll();
  } catch (error) {
    setStatus(`Bulk kill failed: ${error.message || String(error)}`, "warn");
  }
}

async function refreshAll() {
  if (state.isRefreshing) {
    return;
  }

  state.isRefreshing = true;
  try {
    const [snapshot, ports] = await Promise.all([call("get_process_snapshot"), call("list_open_ports")]);

    state.processes = Array.isArray(snapshot.processes) ? snapshot.processes : [];
    state.ports = Array.isArray(ports) ? ports : [];

    if (state.selectedPid && !state.processes.some((process) => process.pid === state.selectedPid)) {
      state.selectedPid = null;
      el.detailsBody.innerHTML = "<div class='details-empty'>Selected process is no longer running.</div>";
    }

    renderStats(snapshot, state.ports);
    renderProcessTable();
    renderPortTable();

    setStatus(`Refreshed ${state.processes.length} processes and ${state.ports.length} ports.`);
  } catch (error) {
    setStatus(`Refresh failed: ${error.message || String(error)}`, "warn");
  } finally {
    state.isRefreshing = false;
  }
}

function activateTab(name) {
  for (const tabButton of document.querySelectorAll(".tab")) {
    const isActive = tabButton.dataset.tab === name;
    tabButton.classList.toggle("active", isActive);
  }

  el.detailsTab.classList.toggle("active", name === "details");
  el.portsTab.classList.toggle("active", name === "ports");
}

function syncRefreshTimer() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }

  if (state.autoRefresh) {
    state.refreshTimer = setInterval(() => {
      refreshAll();
    }, 3000);
  }
}

function bindEvents() {
  el.processSearch.addEventListener("input", (event) => {
    state.processSearch = event.target.value;
    renderProcessTable();
  });

  el.portSearch.addEventListener("input", (event) => {
    state.portSearch = event.target.value;
    renderPortTable();
  });

  el.sortBy.addEventListener("change", (event) => {
    state.sortBy = event.target.value;
    renderProcessTable();
  });

  el.treeMode.addEventListener("change", (event) => {
    state.treeMode = event.target.checked;
    renderProcessTable();
  });

  el.autoRefresh.addEventListener("change", (event) => {
    state.autoRefresh = event.target.checked;
    syncRefreshTimer();
  });

  el.refreshBtn.addEventListener("click", () => {
    refreshAll();
  });

  el.bulkKillBtn.addEventListener("click", () => {
    runBulkKill();
  });

  el.processRows.addEventListener("click", async (event) => {
    const actionButton = event.target.closest("button[data-action]");
    if (actionButton) {
      const pid = Number(actionButton.dataset.pid);
      if (actionButton.dataset.action === "kill") {
        await runKill(pid, false);
      } else if (actionButton.dataset.action === "kill-tree") {
        await runKill(pid, true);
      }
      return;
    }

    const row = event.target.closest("tr[data-pid]");
    if (!row) {
      return;
    }

    const pid = Number(row.dataset.pid);
    state.selectedPid = pid;
    renderProcessTable();
    activateTab("details");
    await loadDetails(pid);
  });

  el.detailsBody.addEventListener("click", async (event) => {
    const actionButton = event.target.closest("button[data-action]");
    if (!actionButton) {
      return;
    }

    const pid = Number(actionButton.dataset.pid);
    if (actionButton.dataset.action === "kill") {
      await runKill(pid, false);
    } else if (actionButton.dataset.action === "kill-tree") {
      await runKill(pid, true);
    }
  });

  el.portRows.addEventListener("click", async (event) => {
    const actionButton = event.target.closest("button[data-action='focus-pid']");
    if (!actionButton) {
      return;
    }

    const pid = Number(actionButton.dataset.pid);
    state.selectedPid = pid;
    activateTab("details");
    renderProcessTable();
    await loadDetails(pid);
  });

  document.querySelectorAll(".tab").forEach((tabButton) => {
    tabButton.addEventListener("click", () => {
      activateTab(tabButton.dataset.tab);
    });
  });
}

function cacheElements() {
  el.mainGrid = document.getElementById("mainGrid");
  el.paneDivider = document.getElementById("paneDivider");
  el.processPanel = document.getElementById("processPanel");
  el.sidePanel = document.getElementById("sidePanel");

  el.processCount = document.getElementById("processCount");
  el.portCount = document.getElementById("portCount");
  el.lastRefresh = document.getElementById("lastRefresh");
  el.statusBar = document.getElementById("statusBar");

  el.processSearch = document.getElementById("processSearch");
  el.portSearch = document.getElementById("portSearch");
  el.bulkQuery = document.getElementById("bulkQuery");

  el.sortBy = document.getElementById("sortBy");
  el.treeMode = document.getElementById("treeMode");
  el.autoRefresh = document.getElementById("autoRefresh");

  el.refreshBtn = document.getElementById("refreshBtn");
  el.bulkKillBtn = document.getElementById("bulkKillBtn");

  el.processRows = document.getElementById("processRows");
  el.portRows = document.getElementById("portRows");

  el.detailsTab = document.getElementById("detailsTab");
  el.portsTab = document.getElementById("portsTab");
  el.detailsBody = document.getElementById("detailsBody");
}

async function init() {
  cacheElements();
  setupPaneResize();
  bindEvents();
  syncRefreshTimer();

  if (!invoke) {
    setStatus("Tauri bridge missing. Launch with `cargo tauri dev` or `cargo run --manifest-path src-tauri/Cargo.toml`.", "warn");
    return;
  }

  await refreshAll();
}

window.addEventListener("DOMContentLoaded", init);
