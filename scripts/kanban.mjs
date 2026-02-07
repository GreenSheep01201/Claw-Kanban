#!/usr/bin/env node

/**
 * claw-kanban management script
 *
 * Usage:
 *   node scripts/kanban.mjs start   - Start the kanban server (detached)
 *   node scripts/kanban.mjs stop    - Stop the running server
 *   node scripts/kanban.mjs status  - Check if the server is running
 *   node scripts/kanban.mjs restart - Restart the server
 *   node scripts/kanban.mjs uninstall - Stop server + remove AGENTS.md kanban section
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PID_FILE = path.join(ROOT, "kanban.pid");
const LOG_FILE = path.join(ROOT, "kanban-server.log");
const START_MARKER = "<!-- BEGIN claw-kanban orchestration rules -->";
const END_MARKER = "<!-- END claw-kanban orchestration rules -->";

const command = process.argv[2] || "status";

function readPid() {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf8").trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getPort() {
  try {
    const envPath = path.join(ROOT, ".env");
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf8");
      const match = content.match(/^PORT=(\d+)/m);
      if (match) return match[1];
    }
  } catch { /* ignore */ }
  return "8787";
}

function findTsx() {
  // Try local node_modules first
  const localTsx = path.join(ROOT, "node_modules", ".bin", "tsx");
  if (fs.existsSync(localTsx)) return localTsx;

  // Try global tsx
  try {
    execSync("tsx --version", { stdio: "ignore" });
    return "tsx";
  } catch { /* ignore */ }

  // Try npx
  return "npx tsx";
}

async function start() {
  const pid = readPid();
  if (pid && isProcessAlive(pid)) {
    const port = getPort();
    console.log(`[claw-kanban] Already running (PID: ${pid})`);
    console.log(`[claw-kanban] Dashboard: http://127.0.0.1:${port}`);
    return;
  }

  // Clean stale PID file
  if (pid) {
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  }

  const tsxCmd = findTsx();
  const serverPath = path.join(ROOT, "server", "index.ts");
  const logStream = fs.openSync(LOG_FILE, "a");

  let child;
  if (tsxCmd.includes(" ")) {
    // npx tsx case
    const parts = tsxCmd.split(" ");
    child = spawn(parts[0], [...parts.slice(1), serverPath], {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", logStream, logStream],
      env: { ...process.env },
    });
  } else {
    child = spawn(tsxCmd, [serverPath], {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", logStream, logStream],
      env: { ...process.env },
    });
  }

  fs.writeFileSync(PID_FILE, String(child.pid), "utf8");
  child.unref();

  const port = getPort();

  // Wait for server to become healthy (up to 5 seconds)
  let healthy = false;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) { healthy = true; break; }
    } catch { /* not ready yet */ }
  }

  if (healthy) {
    console.log(`[claw-kanban] Server started (PID: ${child.pid})`);
    console.log(`[claw-kanban] Dashboard: http://127.0.0.1:${port}`);
    console.log(`[claw-kanban] Log file:  ${LOG_FILE}`);
  } else {
    console.log(`[claw-kanban] Server spawned (PID: ${child.pid}) but health check did not pass.`);
    console.log(`[claw-kanban] Check the log: ${LOG_FILE}`);
  }
}

function stop() {
  const pid = readPid();
  if (!pid) {
    console.log("[claw-kanban] No PID file found. Server may not be running.");
    return false;
  }

  if (!isProcessAlive(pid)) {
    console.log(`[claw-kanban] Process ${pid} not running (stale PID file). Cleaning up.`);
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    return false;
  }

  try {
    // Kill process group on Unix
    if (process.platform !== "win32") {
      try { process.kill(-pid, "SIGTERM"); } catch { /* ignore */ }
    }
    process.kill(pid, "SIGTERM");
  } catch (err) {
    console.error(`[claw-kanban] Failed to stop process ${pid}: ${err.message}`);
    return false;
  }

  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  console.log(`[claw-kanban] Server stopped (PID: ${pid})`);
  return true;
}

function status() {
  const pid = readPid();
  const port = getPort();

  if (!pid) {
    console.log("[claw-kanban] Server is not running (no PID file).");
    return;
  }

  if (isProcessAlive(pid)) {
    console.log(`[claw-kanban] Server is running`);
    console.log(`  PID:       ${pid}`);
    console.log(`  Dashboard: http://127.0.0.1:${port}`);
    console.log(`  API:       http://127.0.0.1:${port}/api/health`);
    console.log(`  Log:       ${LOG_FILE}`);
    console.log(`  Data:      ${path.join(ROOT, "kanban.sqlite")}`);
  } else {
    console.log(`[claw-kanban] Server is not running (stale PID: ${pid}). Cleaning up.`);
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  }
}

async function restart() {
  console.log("[claw-kanban] Restarting...");
  stop();
  // Brief delay to let port release
  await new Promise((r) => setTimeout(r, 500));
  await start();
}

function removeAutoStartService() {
  const LAUNCHD_LABEL = "ai.openclaw.kanban";
  const LAUNCHD_LEGACY = "com.openclaw.kanban";

  if (process.platform === "darwin") {
    // Remove launchd services
    for (const label of [LAUNCHD_LABEL, LAUNCHD_LEGACY]) {
      const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
      if (fs.existsSync(plist)) {
        try {
          execSync(`launchctl bootout gui/$(id -u)/${label}`, { stdio: "ignore" });
        } catch { /* ignore */ }
        fs.unlinkSync(plist);
        console.log(`[claw-kanban] Removed launchd service: ${label}`);
      }
    }
  } else if (process.platform === "linux") {
    // Remove systemd user service
    const serviceFile = path.join(os.homedir(), ".config", "systemd", "user", "claw-kanban.service");
    if (fs.existsSync(serviceFile)) {
      try {
        execSync("systemctl --user stop claw-kanban.service", { stdio: "ignore" });
        execSync("systemctl --user disable claw-kanban.service", { stdio: "ignore" });
      } catch { /* ignore */ }
      fs.unlinkSync(serviceFile);
      try { execSync("systemctl --user daemon-reload", { stdio: "ignore" }); } catch { /* ignore */ }
      console.log("[claw-kanban] Removed systemd service: claw-kanban");
    }
  }
}

function resolveWorkspaceDir() {
  // Try reading workspace from openclaw.json
  const openclawJson = path.join(os.homedir(), ".openclaw", "openclaw.json");
  if (fs.existsSync(openclawJson)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(openclawJson, "utf8"));
      const w = cfg?.agents?.defaults?.workspace?.trim();
      if (w) return w.replace(/^~/, os.homedir());
    } catch { /* ignore */ }
  }

  // Check OPENCLAW_PROFILE
  const profile = process.env.OPENCLAW_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(os.homedir(), ".openclaw", `workspace-${profile}`);
  }

  return path.join(os.homedir(), ".openclaw", "workspace");
}

function uninstall() {
  console.log("[claw-kanban] Uninstalling...");

  // Stop server
  stop();

  // Remove auto-start service
  removeAutoStartService();

  // Remove kanban section from AGENTS.md
  const workspaceDir = resolveWorkspaceDir();
  const agentsPaths = [
    path.join(workspaceDir, "AGENTS.md"),
    path.join(ROOT, "AGENTS.md"),
  ];
  // Deduplicate
  const uniquePaths = [...new Set(agentsPaths)];

  for (const agentsPath of uniquePaths) {
    if (!fs.existsSync(agentsPath)) continue;

    const content = fs.readFileSync(agentsPath, "utf8");
    if (!content.includes(END_MARKER)) continue;

    const startIdx = content.indexOf(START_MARKER);
    const endIdx = content.indexOf(END_MARKER);

    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
      // Fallback: remove everything up to and including END marker
      const afterEnd = content.slice(endIdx + END_MARKER.length).replace(/^\n{1,3}/, "");
      fs.writeFileSync(agentsPath, afterEnd, "utf8");
    } else {
      // Remove only the section between BEGIN and END markers
      const before = content.slice(0, startIdx);
      const after = content.slice(endIdx + END_MARKER.length).replace(/^\n{1,3}/, "");
      const result = (before + after).replace(/^\n+/, "");
      fs.writeFileSync(agentsPath, result, "utf8");
    }
    console.log(`[claw-kanban] Removed kanban rules from ${agentsPath}`);
  }

  console.log("");
  console.log("[claw-kanban] To fully remove claw-kanban:");
  console.log(`  rm -rf ${ROOT}`);
  console.log("");
  console.log("[claw-kanban] Your kanban data (kanban.sqlite, logs/) is preserved until you delete the directory.");
}

const commands = { start, stop, status, restart, uninstall };
const fn = commands[command];
if (!fn) {
  console.error(`Unknown command: ${command}`);
  console.error("Usage: kanban.mjs [start|stop|status|restart|uninstall]");
  process.exit(1);
}
await fn();
