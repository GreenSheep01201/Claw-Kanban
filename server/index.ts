import express from "express";
import cors from "cors";
import path from "path";
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { WebSocket } from "ws";
import { fileURLToPath } from "node:url";

// Load .env file (no dotenv dependency needed)
const __server_dirname = path.dirname(fileURLToPath(import.meta.url));
const envFilePath = path.resolve(__server_dirname, "..", ".env");
try {
  if (fs.existsSync(envFilePath)) {
    const envContent = fs.readFileSync(envFilePath, "utf8");
    for (const line of envContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      // Don't override existing env vars (process env takes precedence)
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
} catch { /* ignore .env read errors */ }

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1"; // set 0.0.0.0 for Tailscale/LAN

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// --- Production static file serving ---
// In production (no VITE_DEV), serve the built React UI from dist/
const distDir = path.resolve(__server_dirname, "..", "dist");
const isProduction = !process.env.VITE_DEV && fs.existsSync(path.join(distDir, "index.html"));

const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), "kanban.sqlite");
const db = new DatabaseSync(dbPath);

const logsDir = process.env.LOGS_DIR ?? path.join(process.cwd(), "logs");
try {
  fs.mkdirSync(logsDir, { recursive: true });
} catch {
  // ignore
}

// Track active child processes for reliable cleanup (in-memory; survives within server lifetime)
const activeProcesses = new Map<string, ChildProcess>();

// Returns [command, ...args] without the prompt.
// Prompt is delivered via stdin piping to avoid shell escaping issues on Windows.
function buildAgentArgs(agent: string): string[] {
  switch (agent) {
    case "codex":
      return ["codex", "--yolo", "exec", "--json"];
    case "claude":
      return ["claude", "--dangerously-skip-permissions", "--print", "--verbose",
              "--output-format=stream-json", "--include-partial-messages"];
    case "gemini":
      return ["gemini", "--yolo", "--output-format=stream-json"];
    default:
      throw new Error(`unsupported agent: ${agent}`);
  }
}

// Spawn an agent process with prompt delivered via stdin (cross-platform safe).
// Prompt is also saved to a temp file for debugging.
function spawnAgent(
  cardId: string,
  agent: string,
  prompt: string,
  projectPath: string,
  logPath: string,
  processKey?: string,
): ChildProcess {
  // Save prompt to temp file for debugging/auditing
  const promptPath = path.join(logsDir, `${cardId}.prompt.txt`);
  fs.writeFileSync(promptPath, prompt, "utf8");

  const args = buildAgentArgs(agent);
  const logStream = fs.createWriteStream(logPath, { flags: "w" });

  const child = spawn(args[0], args.slice(1), {
    cwd: projectPath,
    shell: process.platform === "win32",
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });

  const key = processKey ?? cardId;
  activeProcesses.set(key, child);

  // Handle spawn errors (e.g. ENOENT when binary not found) without crashing server
  child.on("error", (err) => {
    console.error(`[claw-kanban] spawn error for ${agent} (card ${cardId}): ${err.message}`);
    logStream.write(`\n[claw-kanban] SPAWN ERROR: ${err.message}\n`);
    logStream.end();
    activeProcesses.delete(key);
    appendCardLog(cardId, "error", `Agent spawn failed: ${err.message}`);
    appendSystemLog("error", `Spawn failed ${cardId} (${agent}): ${err.message}`);
  });

  // Deliver prompt via stdin (bypasses shell escaping entirely)
  child.stdin?.write(prompt);
  child.stdin?.end();

  // Pipe agent output to log file
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  child.on("close", () => {
    logStream.end();
    // Clean up prompt temp file
    try { fs.unlinkSync(promptPath); } catch { /* ignore */ }
  });

  if (process.platform !== "win32") child.unref();

  return child;
}

db.exec(`
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_message_id TEXT,
  source_author TEXT,
  source_chat TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  assignee TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  role TEXT,
  task_type TEXT
);

CREATE INDEX IF NOT EXISTS idx_cards_status_updated ON cards(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY DEFAULT 'main',
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS card_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  FOREIGN KEY(card_id) REFERENCES cards(id)
);

-- special system log stream
CREATE TABLE IF NOT EXISTS system_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  agent TEXT NOT NULL,
  pid INTEGER,
  status TEXT NOT NULL,
  log_path TEXT,
  cwd TEXT,
  FOREIGN KEY(card_id) REFERENCES cards(id)
);
CREATE INDEX IF NOT EXISTS idx_card_runs_card ON card_runs(card_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_card_logs_card ON card_logs(card_id, created_at DESC);
`);

// --- OpenClaw Gateway integration (optional) ---
// Set OPENCLAW_CONFIG to your openclaw.json path to enable gateway wake notifications.
// Example: OPENCLAW_CONFIG=~/.openclaw/openclaw.json
const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG ?? "";
const GATEWAY_PROTOCOL_VERSION = 3;
const GATEWAY_WS_PATH = "/ws";
const WAKE_DEBOUNCE_DEFAULT_MS = 12_000;
const wakeDebounce = new Map<string, number>();
let cachedGateway: { url: string; token?: string; loadedAt: number } | null = null;

function loadGatewayConfig(): { url: string; token?: string } | null {
  if (!OPENCLAW_CONFIG_PATH) return null;

  const now = Date.now();
  if (cachedGateway && now - cachedGateway.loadedAt < 30_000) {
    return { url: cachedGateway.url, token: cachedGateway.token };
  }
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as {
      gateway?: {
        port?: number;
        auth?: { token?: string };
      };
    };
    const port = Number(parsed?.gateway?.port);
    if (!Number.isFinite(port) || port <= 0) {
      console.warn(`[claw-kanban] invalid gateway.port in ${OPENCLAW_CONFIG_PATH}`);
      return null;
    }
    const token =
      typeof parsed?.gateway?.auth?.token === "string" ? parsed.gateway.auth.token : undefined;
    const url = `ws://127.0.0.1:${port}${GATEWAY_WS_PATH}`;
    cachedGateway = { url, token, loadedAt: now };
    return { url, token };
  } catch (err) {
    console.warn(`[claw-kanban] failed to read gateway config: ${String(err)}`);
    return null;
  }
}

function shouldSendWake(key: string, debounceMs: number): boolean {
  const now = Date.now();
  const last = wakeDebounce.get(key);
  if (last && now - last < debounceMs) {
    return false;
  }
  wakeDebounce.set(key, now);
  if (wakeDebounce.size > 2000) {
    for (const [k, ts] of wakeDebounce) {
      if (now - ts > debounceMs * 4) {
        wakeDebounce.delete(k);
      }
    }
  }
  return true;
}

async function sendGatewayWake(text: string): Promise<void> {
  const config = loadGatewayConfig();
  if (!config) {
    throw new Error("gateway config unavailable");
  }

  const connectId = randomUUID();
  const wakeId = randomUUID();
  const instanceId = randomUUID();

  return await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const ws = new WebSocket(config.url);

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        ws.close();
      } catch {
        // ignore
      }
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    const send = (payload: unknown) => {
      try {
        ws.send(JSON.stringify(payload));
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    };

    const connectParams = {
      minProtocol: GATEWAY_PROTOCOL_VERSION,
      maxProtocol: GATEWAY_PROTOCOL_VERSION,
      client: {
        id: "cli",
        displayName: "claw-kanban",
        version: "claw-kanban",
        platform: process.platform,
        mode: "backend",
        instanceId,
      },
      ...(config.token ? { auth: { token: config.token } } : {}),
      role: "operator",
      scopes: ["operator.admin"],
      caps: [],
    };

    ws.on("open", () => {
      send({ type: "req", id: connectId, method: "connect", params: connectParams });
    });

    ws.on("message", (data: Buffer | string) => {
      const raw = typeof data === "string" ? data : data.toString("utf8");
      if (!raw) return;
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg || msg.type !== "res") return;
      if (msg.id === connectId) {
        if (!msg.ok) {
          finish(new Error(msg.error?.message ?? "gateway connect failed"));
          return;
        }
        send({ type: "req", id: wakeId, method: "wake", params: { mode: "now", text } });
        return;
      }
      if (msg.id === wakeId) {
        if (!msg.ok) {
          finish(new Error(msg.error?.message ?? "gateway wake failed"));
          return;
        }
        finish();
      }
    });

    ws.on("error", () => {
      finish(new Error("gateway socket error"));
    });

    ws.on("close", () => {
      finish(new Error("gateway socket closed"));
    });

    timer = setTimeout(() => {
      finish(new Error("gateway wake timeout"));
    }, 8000);
    (timer as NodeJS.Timeout).unref?.();
  });
}

function queueWake(params: { key: string; text: string; debounceMs?: number }) {
  if (!OPENCLAW_CONFIG_PATH) return; // gateway not configured
  const debounceMs = params.debounceMs ?? WAKE_DEBOUNCE_DEFAULT_MS;
  if (!shouldSendWake(params.key, debounceMs)) return;
  void sendGatewayWake(params.text).catch((err) => {
    console.warn(`[claw-kanban] wake failed (${params.key}): ${String(err)}`);
  });
}

const CardStatus = z.enum(["Inbox", "Planned", "In Progress", "Review/Test", "Done", "Stopped"]);
const Assignee = z.enum(["claude", "codex", "gemini"]).optional();
const Role = z.enum(["devops", "backend", "frontend"]).optional();
const TaskType = z.enum(["new", "modify", "bugfix"]).optional();
const Provider = z.enum(["claude", "codex", "gemini"]);

// Default provider settings
const DEFAULT_PROVIDER_SETTINGS = {
  roleProviders: {
    devops: "claude",
    backend: "codex",
    frontend: {
      new: "gemini",
      modify: "claude",
      bugfix: "claude",
    },
  },
  stageProviders: {
    inProgress: null,
    reviewTest: null,
  },
  autoAssign: true,
};

// Initialize default settings if not exists
const existingSettings = db.prepare("SELECT * FROM settings WHERE id = 'main'").get();
if (!existingSettings) {
  db.prepare("INSERT INTO settings (id, data, updated_at) VALUES (?, ?, ?)").run(
    "main",
    JSON.stringify(DEFAULT_PROVIDER_SETTINGS),
    nowMs()
  );
}

function getProviderSettings() {
  const row = db.prepare("SELECT data FROM settings WHERE id = 'main'").get() as { data: string } | undefined;
  if (!row) return DEFAULT_PROVIDER_SETTINGS;
  try {
    return JSON.parse(row.data);
  } catch {
    return DEFAULT_PROVIDER_SETTINGS;
  }
}

function determineProvider(role: string | null, taskType: string | null): string {
  const settings = getProviderSettings();
  if (!settings.autoAssign || !role) return "claude";

  const roleProviders = settings.roleProviders;
  if (role === "devops") return roleProviders.devops || "claude";
  if (role === "backend") return roleProviders.backend || "codex";
  if (role === "frontend") {
    const frontendSettings = roleProviders.frontend;
    if (taskType === "new") return frontendSettings.new || "gemini";
    if (taskType === "modify") return frontendSettings.modify || "claude";
    if (taskType === "bugfix") return frontendSettings.bugfix || "claude";
    return frontendSettings.new || "gemini"; // default to new
  }
  return "claude";
}

function nowMs() {
  return Date.now();
}

function uuid() {
  return "c_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
}

function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "string");
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function extractProjectPath(description: string): string | null {
  const lines = description.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "## Project Path" || lines[i].trim() === "## 프로젝트 경로") {
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const v = lines[j].trim();
        if (!v) continue;
        if (v.startsWith("## ")) break;
        // Accept Unix absolute paths (/...) and Windows drive paths (C:\...)
        if (v.startsWith("/") || /^[A-Za-z]:[/\\]/.test(v)) return v;
        return v;
      }
    }
  }
  return null;
}

function appendSystemLog(kind: string, message: string) {
  const t = nowMs();
  db.prepare("INSERT INTO system_logs (created_at, kind, message) VALUES (?, ?, ?)").run(t, kind, message);
}

function appendCardLog(cardId: string, kind: string, message: string) {
  const t = nowMs();
  db.prepare("INSERT INTO card_logs (card_id, created_at, kind, message) VALUES (?, ?, ?, ?)").run(cardId, t, kind, message);
}

const createCardSchema = z.object({
  source: z.string().default("manual"),
  source_message_id: z.string().optional(),
  source_author: z.string().optional(),
  source_chat: z.string().optional(),
  title: z.string().min(1),
  description: z.string().default(""),
  status: CardStatus.default("Inbox"),
  assignee: Assignee,
  priority: z.number().int().min(0).max(5).default(0),
  role: Role,
  task_type: TaskType,
});

const buildHealthPayload = () => ({
  ok: true,
  dbPath,
  gateway: OPENCLAW_CONFIG_PATH ? "configured" : "not configured",
});

app.get("/health", (_req, res) => res.json(buildHealthPayload()));
app.get("/healthz", (_req, res) => res.json(buildHealthPayload()));
app.get("/api/health", (_req, res) => res.json(buildHealthPayload()));

// Settings endpoints
app.get("/api/settings", (_req, res) => {
  const settings = getProviderSettings();
  res.json({ settings });
});

app.put("/api/settings", (req, res) => {
  const settingsSchema = z.object({
    roleProviders: z.object({
      devops: Provider,
      backend: Provider,
      frontend: z.object({
        new: Provider,
        modify: Provider,
        bugfix: Provider,
      }),
    }),
    stageProviders: z.object({
      inProgress: Provider.nullable(),
      reviewTest: Provider.nullable(),
    }),
    autoAssign: z.boolean(),
  });

  const settings = settingsSchema.parse(req.body);
  const t = nowMs();

  db.prepare("UPDATE settings SET data = ?, updated_at = ? WHERE id = 'main'").run(
    JSON.stringify(settings),
    t
  );

  appendSystemLog("system", "Settings updated");
  res.json({ ok: true });
});

// --- CLI Provider Status Detection ---
interface CliToolStatus {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  authHint: string;
}

type CliStatusResult = Record<string, CliToolStatus>;

let cachedCliStatus: { data: CliStatusResult; loadedAt: number } | null = null;
const CLI_STATUS_TTL = 30_000;

const CLI_TOOLS = [
  {
    name: "claude",
    authFiles: [".claude.json", ".claude/auth.json"],
    authHint: "Run: claude login",
  },
  {
    name: "codex",
    authFiles: [".codex/auth.json"],
    authHint: "Run: codex auth login",
  },
  {
    name: "gemini",
    authFiles: [".gemini/oauth_creds.json"],
    authHint: "Run: gemini auth login",
  },
] as const;

function execWithTimeout(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
    child.unref?.();
  });
}

function checkAuthFiles(toolName: string, authFiles: readonly string[]): boolean {
  const home = os.homedir();
  for (const f of authFiles) {
    const fullPath = path.join(home, f);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isFile() && stat.size > 2) return true;
    } catch {
      // file doesn't exist
    }
  }
  return false;
}

async function detectCliTool(tool: typeof CLI_TOOLS[number]): Promise<CliToolStatus> {
  let installed = false;
  let version: string | null = null;

  // Check if binary exists via `which` (Unix) or `where` (Windows)
  const whichCmd = process.platform === "win32" ? "where" : "which";
  try {
    await execWithTimeout(whichCmd, [tool.name], 3000);
    installed = true;
  } catch {
    return { installed: false, version: null, authenticated: false, authHint: tool.authHint };
  }

  // Get version
  try {
    version = await execWithTimeout(tool.name, ["--version"], 3000);
    // Some CLIs output multi-line; take first line
    if (version.includes("\n")) version = version.split("\n")[0].trim();
  } catch {
    // binary found but --version failed; still counts as installed
  }

  const authenticated = checkAuthFiles(tool.name, tool.authFiles);
  return { installed, version, authenticated, authHint: tool.authHint };
}

async function detectAllCli(): Promise<CliStatusResult> {
  const results = await Promise.all(CLI_TOOLS.map((t) => detectCliTool(t)));
  const out: CliStatusResult = {};
  for (let i = 0; i < CLI_TOOLS.length; i++) {
    out[CLI_TOOLS[i].name] = results[i];
  }
  return out;
}

app.get("/api/cli-status", async (_req, res) => {
  const refresh = _req.query.refresh === "1";
  const now = Date.now();

  if (!refresh && cachedCliStatus && now - cachedCliStatus.loadedAt < CLI_STATUS_TTL) {
    return res.json({ providers: cachedCliStatus.data });
  }

  try {
    const data = await detectAllCli();
    cachedCliStatus = { data, loadedAt: Date.now() };
    res.json({ providers: data });
  } catch (err) {
    res.status(500).json({ error: "cli_detection_failed", message: String(err) });
  }
});

app.get("/api/cards", (req, res) => {
  const status = req.query.status ? CardStatus.parse(req.query.status) : undefined;
  const rows = status
    ? db.prepare("SELECT * FROM cards WHERE status = ? ORDER BY updated_at DESC").all(status)
    : db.prepare("SELECT * FROM cards ORDER BY updated_at DESC").all();
  res.json({ cards: rows });
});

app.get("/api/cards/search", (req, res) => {
  const queryRaw = firstQueryValue(req.query.q) ?? firstQueryValue(req.query.query) ?? "";
  const query = queryRaw.trim();
  if (!query) return res.status(400).json({ error: "missing_query" });

  const statusValue = firstQueryValue(req.query.status);
  const status = statusValue ? CardStatus.parse(statusValue) : undefined;
  const limit = clampNumber(firstQueryValue(req.query.limit), 200, 1, 500);
  const offset = clampNumber(firstQueryValue(req.query.offset), 0, 0, 50_000);

  const tokens = query.split(/\s+/).filter(Boolean).slice(0, 8);
  const fields = [
    "title",
    "description",
    "id",
    "source",
    "source_message_id",
    "source_author",
    "source_chat",
    "assignee",
    "role",
    "task_type",
  ];

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (status) {
    conditions.push("status = ?");
    params.push(status);
  }

  for (const token of tokens) {
    const like = `%${escapeLike(token)}%`;
    const tokenConditions = fields.map((field) => `${field} LIKE ? ESCAPE '\\'`);
    conditions.push(`(${tokenConditions.join(" OR ")})`);
    for (let i = 0; i < fields.length; i++) {
      params.push(like);
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT * FROM cards ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params);
  res.json({ cards: rows });
});

app.post("/api/cards", (req, res) => {
  const input = createCardSchema.parse(req.body ?? {});
  const t = nowMs();

  // Deduplication: check for same title within last 30 seconds
  const duplicateWindow = 30_000;
  const existing = db.prepare(
    `SELECT id FROM cards WHERE title = ? AND created_at > ? LIMIT 1`
  ).get(input.title, t - duplicateWindow) as { id: string } | undefined;

  if (existing) {
    return res.json({ id: existing.id, duplicate: true });
  }

  const id = uuid();

  // Auto-assign provider based on role if autoAssign is enabled
  let assignee = input.assignee;
  if (!assignee && input.role) {
    const settings = getProviderSettings();
    if (settings.autoAssign) {
      assignee = determineProvider(input.role, input.task_type || null) as "claude" | "codex" | "gemini";
    }
  }

  db.prepare(
    `INSERT INTO cards (id, created_at, updated_at, source, source_message_id, source_author, source_chat, title, description, status, assignee, priority, role, task_type)
     VALUES (@id, @created_at, @updated_at, @source, @source_message_id, @source_author, @source_chat, @title, @description, @status, @assignee, @priority, @role, @task_type)`
  ).run({
    id,
    created_at: t,
    updated_at: t,
    ...input,
    assignee,
  });

  db.prepare(
    "INSERT INTO card_logs (card_id, created_at, kind, message) VALUES (?, ?, ?, ?)"
  ).run(id, t, "system", `Card created (${input.status})`);
  db.prepare(
    "INSERT INTO system_logs (created_at, kind, message) VALUES (?, ?, ?)"
  ).run(t, "system", `Card created ${id} (${input.status})`);

  // Send wake notification for new Inbox cards
  if (input.status === "Inbox") {
    queueWake({
      key: `inbox:${id}`,
      text: `Kanban: Inbox +1 - ${input.title}`,
      debounceMs: 8000,
    });
  }

  res.json({ id });
});

app.patch("/api/cards/:id", (req, res) => {
  const id = String(req.params.id);
  const patchSchema = z
    .object({
      title: z.string().min(1).optional(),
      description: z.string().optional(),
      status: CardStatus.optional(),
      assignee: Assignee,
      priority: z.number().int().min(0).max(5).optional(),
      role: Role,
      task_type: TaskType,
    })
    .strict();

  const patch = patchSchema.parse(req.body ?? {});
  const existing = db.prepare("SELECT * FROM cards WHERE id = ?").get(id) as any;
  if (!existing) return res.status(404).json({ error: "not_found" });

  // Auto-reassign provider if role or task_type changes and assignee not explicitly set
  let assignee = patch.assignee !== undefined ? patch.assignee : existing.assignee;
  const newRole = patch.role !== undefined ? patch.role : existing.role;
  const newTaskType = patch.task_type !== undefined ? patch.task_type : existing.task_type;

  if ((patch.role !== undefined || patch.task_type !== undefined) && patch.assignee === undefined) {
    const settings = getProviderSettings();
    if (settings.autoAssign && newRole) {
      assignee = determineProvider(newRole, newTaskType);
    }
  }

  const t = nowMs();
  const next = { ...existing, ...patch, assignee, updated_at: t };

  db.prepare(
    `UPDATE cards
     SET updated_at=@updated_at, title=@title, description=@description, status=@status, assignee=@assignee, priority=@priority, role=@role, task_type=@task_type
     WHERE id=@id`
  ).run({
    id: next.id,
    updated_at: next.updated_at,
    title: next.title,
    description: next.description,
    status: next.status,
    assignee: next.assignee,
    priority: next.priority,
    role: next.role,
    task_type: next.task_type,
  });

  db.prepare(
    "INSERT INTO card_logs (card_id, created_at, kind, message) VALUES (?, ?, ?, ?)"
  ).run(id, t, "system", `Updated: ${Object.keys(patch).join(", ")}`);
  db.prepare(
    "INSERT INTO system_logs (created_at, kind, message) VALUES (?, ?, ?)"
  ).run(t, "system", `Card updated ${id}: ${Object.keys(patch).join(", ")}`);

  const reviewToDone = existing.status === "Review/Test" && next.status === "Done";
  if (reviewToDone) {
    queueWake({
      key: `done:${id}`,
      text: `Kanban: Review/Test -> Done - ${next.title}`,
      debounceMs: 15_000,
    });
  }

  res.json({ ok: true });
});

app.get("/api/cards/:id/logs", (req, res) => {
  const id = String(req.params.id);
  const rows = db
    .prepare("SELECT * FROM card_logs WHERE card_id = ? ORDER BY created_at DESC LIMIT 500")
    .all(id);
  res.json({ logs: rows });
});

function prettyStreamJson(raw: string): string {
  const chunks: string[] = [];
  const meta: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (!t.startsWith("{")) continue;

    try {
      const j: any = JSON.parse(t);

      // Claude: system init
      if (j.type === "system" && j.subtype === "init") {
        meta.push(`[init] cwd=${j.cwd} model=${j.model}`);
        if (Array.isArray(j.mcp_servers)) {
          const failed = j.mcp_servers.filter((s: any) => s.status && s.status !== "ok");
          if (failed.length) meta.push(`[mcp] ${failed.map((s: any) => `${s.name}:${s.status}`).join(", ")}`);
        }
        continue;
      }

      // Gemini: init
      if (j.type === "init" && j.session_id) {
        meta.push(`[init] session=${j.session_id} model=${j.model}`);
        continue;
      }

      // Claude: stream_event
      if (j.type === "stream_event") {
        const ev = j.event;
        if (ev?.type === "content_block_delta" && ev?.delta?.type === "text_delta") {
          chunks.push(ev.delta.text);
          continue;
        }
        if (ev?.type === "content_block_start" && ev?.content_block?.type === "text" && ev?.content_block?.text) {
          chunks.push(ev.content_block.text);
          continue;
        }
        continue;
      }

      // Claude: assistant message (from --print mode)
      if (j.type === "assistant" && j.message?.content) {
        for (const block of j.message.content) {
          if (block.type === "text" && block.text) {
            chunks.push(block.text);
          }
        }
        continue;
      }

      // Claude: result (final output from --print mode)
      if (j.type === "result" && j.result) {
        chunks.push(j.result);
        continue;
      }

      // Gemini: message with content
      if (j.type === "message" && j.role === "assistant" && j.content) {
        chunks.push(j.content);
        continue;
      }

      // Gemini: tool_use
      if (j.type === "tool_use" && j.tool_name) {
        const params = j.parameters?.file_path || j.parameters?.command || "";
        chunks.push(`\n[tool: ${j.tool_name}] ${params}\n`);
        continue;
      }

      // Gemini: tool_result
      if (j.type === "tool_result" && j.status) {
        if (j.status !== "success") {
          chunks.push(`[result: ${j.status}]\n`);
        }
        continue;
      }

      // Codex: thread.started
      if (j.type === "thread.started" && j.thread_id) {
        meta.push(`[thread] ${j.thread_id}`);
        continue;
      }

      // Codex: item.completed (reasoning or agent_message)
      if (j.type === "item.completed" && j.item) {
        const item = j.item;
        if (item.type === "agent_message" && item.text) {
          chunks.push(item.text);
        } else if (item.type === "reasoning" && item.text) {
          chunks.push(`\n[reasoning] ${item.text}\n`);
        } else if (item.type === "tool_call" && item.name) {
          const args = item.arguments ? JSON.stringify(item.arguments).slice(0, 100) : "";
          chunks.push(`\n[tool: ${item.name}] ${args}\n`);
        } else if (item.type === "tool_output" && item.output) {
          const out = String(item.output);
          if (out.includes("error") || out.length < 200) {
            chunks.push(`[output] ${out.slice(0, 200)}\n`);
          }
        }
        continue;
      }

      // Codex: turn.completed (usage stats)
      if (j.type === "turn.completed" && j.usage) {
        const u = j.usage;
        meta.push(`[usage] in=${u.input_tokens} out=${u.output_tokens} cached=${u.cached_input_tokens || 0}`);
        continue;
      }
    } catch {
      // ignore
    }
  }

  const stitched = chunks.join("");
  const PARA = "\u0000";
  const withPara = stitched.replace(/\n{2,}/g, PARA);
  const singleLine = withPara.replace(/\n/g, " ");
  const normalized = singleLine
    .replace(/\s+/g, " ")
    .replace(new RegExp(PARA, "g"), "\n\n")
    .trim();

  const head = meta.length ? meta.join("\n") + "\n\n" : "";
  return head + normalized;
}

// Basic "terminal log" viewer: reads logs/<cardId>.log (if present)
app.get("/api/cards/:id/terminal", (req, res) => {
  const id = String(req.params.id);
  const lines = Math.min(Math.max(Number(req.query.lines ?? 200), 20), 4000);
  const pretty = String(req.query.pretty ?? "1") === "1";
  const filePath = path.join(logsDir, `${id}.log`);

  if (!fs.existsSync(filePath)) {
    return res.json({ ok: true, exists: false, path: filePath, text: "" });
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const parts = raw.split(/\r?\n/);
  const tail = parts.slice(Math.max(0, parts.length - lines)).join("\n");
  const text = pretty ? prettyStreamJson(tail) : tail;
  res.json({ ok: true, exists: true, path: filePath, text });
});

// Handle review completion logic (used by both in-process handler and callback endpoint)
function handleReviewComplete(cardId: string, exitCode: number) {
  activeProcesses.delete(`${cardId}:review`);
  const reviewStatus = exitCode === 0 ? "completed" : "failed";

  appendCardLog(cardId, "system", `REVIEW ${reviewStatus} (exit code: ${exitCode})`);
  appendSystemLog("system", `Review ${reviewStatus} ${cardId} (exit: ${exitCode})`);

  const card = db.prepare("SELECT * FROM cards WHERE id = ?").get(cardId) as { title: string } | undefined;

  if (exitCode === 0) {
    const reviewLogPath = path.join(logsDir, `${cardId}.review.log`);
    const rawLog = fs.existsSync(reviewLogPath) ? fs.readFileSync(reviewLogPath, "utf8") : "";
    const reviewLog = prettyStreamJson(rawLog);
    const passed = reviewLog.includes("REVIEW_PASSED") || reviewLog.toLowerCase().includes("looks good");

    if (passed) {
      db.prepare("UPDATE cards SET updated_at = ?, status = ? WHERE id = ?")
        .run(nowMs(), "Done", cardId);
      queueWake({ key: `done:${cardId}`, text: `Kanban: Review/Test -> Done - ${card?.title ?? cardId}`, debounceMs: 5000 });
    } else {
      queueWake({ key: `review-issues:${cardId}`, text: `Kanban: Review found issues - ${card?.title ?? cardId}`, debounceMs: 5000 });
    }
  }
}

// Handle run completion logic (used by both in-process handler and callback endpoint)
function handleRunComplete(cardId: string, exitCode: number, projectPath: string) {
  activeProcesses.delete(cardId);
  const status = exitCode === 0 ? "completed" : "failed";

  appendCardLog(cardId, "system", `RUN ${status} (exit code: ${exitCode})`);
  appendSystemLog("system", `Run ${status} ${cardId} (exit: ${exitCode})`);

  const run = db.prepare("SELECT * FROM card_runs WHERE card_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(cardId) as { id: number } | undefined;
  if (run) {
    db.prepare("UPDATE card_runs SET status = ? WHERE id = ?").run("stopped", run.id);
  }

  if (exitCode === 0) {
    db.prepare("UPDATE cards SET updated_at = ?, status = ? WHERE id = ?")
      .run(nowMs(), "Review/Test", cardId);
    setTimeout(() => startReviewTest(cardId, projectPath), 2000);
  }
}

// Auto-start review/test after implementation completes
function startReviewTest(cardId: string, projectPath: string) {
  const card = db.prepare("SELECT * FROM cards WHERE id = ?").get(cardId) as any;
  if (!card || card.status !== "Review/Test") return;

  const reviewLogPath = path.join(logsDir, `${cardId}.review.log`);
  fs.writeFileSync(reviewLogPath, "", "utf8");

  const implLogPath = path.join(logsDir, `${cardId}.log`);
  const implLogExists = fs.existsSync(implLogPath);
  const implLogHint = implLogExists
    ? `\n\nImplementation log available at: ${implLogPath}`
    : "";

  const reviewPrompt = `Task Verification for: ${card.title}

Task Description: ${card.description || "(no description)"}
${implLogHint}

Please verify the task was completed successfully:
1. Check if the requested work was done
2. If code changes were made, review for bugs and issues
3. Verify the result matches the task requirements

IMPORTANT: If the task appears completed successfully, output exactly: REVIEW_PASSED
If there are issues or the task is incomplete, explain clearly.`;

  appendCardLog(cardId, "system", "REVIEW started");
  appendSystemLog("system", `Review start ${cardId}`);

  const reviewChild = spawnAgent(cardId, "claude", reviewPrompt, projectPath, reviewLogPath, `${cardId}:review`);

  reviewChild.on("close", (code) => {
    handleReviewComplete(cardId, code ?? 1);
  });

  db.prepare(
    "INSERT INTO card_runs (card_id, created_at, agent, pid, status, log_path, cwd) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(cardId, nowMs(), "claude-review", reviewChild.pid ?? null, "running", reviewLogPath, projectPath);
}

// Start (or restart) a card run.
app.post("/api/cards/:id/run", (req, res) => {
  const id = String(req.params.id);
  const card = db.prepare("SELECT * FROM cards WHERE id = ?").get(id) as any;
  if (!card) return res.status(404).json({ error: "not_found" });

  const agent = (card.assignee || "claude") as string;
  if (!["claude", "codex", "gemini"].includes(agent)) {
    return res.status(400).json({ error: "unsupported_agent", agent });
  }

  const projectPath = extractProjectPath(card.description) || process.cwd();
  const logPath = path.join(logsDir, `${id}.log`);

  const prompt = `${card.title}

${card.description}`;

  appendCardLog(id, "system", `RUN start requested (agent=${agent})`);
  appendSystemLog("system", `Run start ${id} agent=${agent}`);

  const child = spawnAgent(id, agent, prompt, projectPath, logPath);

  child.on("close", (code) => {
    handleRunComplete(id, code ?? 1, projectPath);
  });

  db.prepare(
    "INSERT INTO card_runs (card_id, created_at, agent, pid, status, log_path, cwd) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, nowMs(), agent, child.pid ?? null, "running", logPath, projectPath);

  // Move card into progress when run starts
  db.prepare(
    "UPDATE cards SET updated_at = ?, status = ? WHERE id = ?"
  ).run(nowMs(), "In Progress", id);

  res.json({ ok: true, pid: child.pid ?? null, logPath, cwd: projectPath });
});

// Stop a running card run
app.post("/api/cards/:id/stop", (req, res) => {
  const id = String(req.params.id);
  const card = db.prepare("SELECT * FROM cards WHERE id = ?").get(id) as any;
  if (!card) return res.status(404).json({ error: "not_found" });

  // Try in-memory process first, fall back to DB pid
  const activeChild = activeProcesses.get(id) ?? activeProcesses.get(`${id}:review`);
  const run = db
    .prepare("SELECT * FROM card_runs WHERE card_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(id) as any;

  const pid = activeChild?.pid ?? run?.pid;
  if (!pid) {
    appendCardLog(id, "system", "STOP requested but no pid found");
    return res.json({ ok: true, stopped: false });
  }

  killPidTree(pid);
  activeProcesses.delete(id);
  activeProcesses.delete(`${id}:review`);

  appendCardLog(id, "system", `STOP sent to pid ${pid}`);
  appendSystemLog("system", `Stop ${id} pid=${pid}`);

  if (run) {
    db.prepare("UPDATE card_runs SET status = ? WHERE id = ?").run("stopped", run.id);
  }
  db.prepare("UPDATE cards SET updated_at = ?, status = ? WHERE id = ?").run(nowMs(), "Stopped", id);

  res.json({ ok: true, stopped: true, pid });
});

// Callback endpoint for CLI process completion (also usable by external tools)
app.post("/api/cards/:id/run-complete", (req, res) => {
  const id = String(req.params.id);
  const exitCodeStr = req.query.exit_code as string | undefined;
  const projectPath = req.query.project_path
    ? decodeURIComponent(req.query.project_path as string)
    : process.cwd();

  const code = exitCodeStr ? parseInt(exitCodeStr, 10) : 0;
  handleRunComplete(id, code, projectPath);
  res.json({ ok: true, status: code === 0 ? "completed" : "failed", code });
});

// Callback endpoint for review process completion (also usable by external tools)
app.post("/api/cards/:id/review-complete", (req, res) => {
  const cardId = String(req.params.id);
  const exitCodeStr = req.query.exit_code as string | undefined;

  const code = exitCodeStr ? parseInt(exitCodeStr, 10) : 0;
  handleReviewComplete(cardId, code);
  res.json({ ok: true, status: code === 0 ? "completed" : "failed", code });
});

// Manually trigger review/test for a card
app.post("/api/cards/:id/review", (req, res) => {
  const id = String(req.params.id);
  const card = db.prepare("SELECT * FROM cards WHERE id = ?").get(id) as any;
  if (!card) return res.status(404).json({ error: "not_found" });

  if (card.status !== "Review/Test") {
    return res.status(400).json({ error: "card_not_in_review_test", status: card.status });
  }

  const projectPath = extractProjectPath(card.description) || process.cwd();
  startReviewTest(id, projectPath);

  res.json({ ok: true, message: "Review started" });
});

function killPidTree(pid: number) {
  if (process.platform === "win32") {
    // Windows: use taskkill with /T (tree) and /F (force)
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // ignore
    }
  } else {
    // Unix: kill process group first, then individual process
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // ignore
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }
  }
}

function deleteCardAndArtifacts(cardId: string) {
  // Kill active processes (in-memory)
  for (const key of [cardId, `${cardId}:review`]) {
    const child = activeProcesses.get(key);
    if (child?.pid) killPidTree(child.pid);
    activeProcesses.delete(key);
  }

  // Kill from DB record (fallback for processes started before server restart)
  const run = db
    .prepare("SELECT * FROM card_runs WHERE card_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(cardId) as any;
  if (run?.pid) {
    killPidTree(Number(run.pid));
    db.prepare("UPDATE card_runs SET status = ? WHERE id = ?").run("stopped", run.id);
  }

  db.prepare("DELETE FROM card_runs WHERE card_id = ?").run(cardId);
  db.prepare("DELETE FROM card_logs WHERE card_id = ?").run(cardId);
  db.prepare("DELETE FROM cards WHERE id = ?").run(cardId);

  for (const suffix of [".log", ".review.log", ".prompt.txt"]) {
    const filePath = path.join(logsDir, `${cardId}${suffix}`);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }
}

app.delete("/api/cards/:id", (req, res) => {
  const id = String(req.params.id);
  const existing = db.prepare("SELECT * FROM cards WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "not_found" });

  const t = nowMs();
  db.prepare("INSERT INTO system_logs (created_at, kind, message) VALUES (?, ?, ?)")
    .run(t, "system", `Card deleted ${id}`);

  deleteCardAndArtifacts(id);
  res.json({ ok: true });
});

// Bulk delete helper
app.post("/api/cards/purge", (req, res) => {
  const status = req.query.status ? CardStatus.parse(req.query.status) : undefined;
  if (!status) return res.status(400).json({ error: "missing_status" });

  const ids = db.prepare("SELECT id FROM cards WHERE status = ?").all(status).map((r: any) => r.id);
  const t = nowMs();
  for (const id of ids) {
    deleteCardAndArtifacts(id);
  }
  db.prepare("INSERT INTO system_logs (created_at, kind, message) VALUES (?, ?, ?)")
    .run(t, "system", `Purged ${ids.length} cards in status ${status}`);

  res.json({ ok: true, deleted: ids.length });
});

// Webhook / Telegram ingestion endpoint
app.post("/api/inbox", (req, res) => {
  const schema = z.object({
    source: z.string().default("telegram"),
    message_id: z.string().optional(),
    author: z.string().optional(),
    chat: z.string().optional(),
    text: z.string().min(1)
  });
  const m = schema.parse(req.body ?? {});

  const raw = m.text.trimStart();
  const normalized = raw.startsWith("#") ? raw.slice(1).trimStart() : raw;

  const title = normalized.length > 80 ? normalized.slice(0, 80) + "\u2026" : normalized;
  const description = normalized;

  const id = uuid();
  const t = nowMs();
  db.prepare(
    `INSERT INTO cards (id, created_at, updated_at, source, source_message_id, source_author, source_chat, title, description, status, assignee, priority)
     VALUES (@id, @created_at, @updated_at, @source, @source_message_id, @source_author, @source_chat, @title, @description, @status, @assignee, @priority)`
  ).run({
    id,
    created_at: t,
    updated_at: t,
    source: m.source,
    source_message_id: m.message_id ?? null,
    source_author: m.author ?? null,
    source_chat: m.chat ?? null,
    title,
    description,
    status: "Inbox",
    assignee: null,
    priority: 0
  });
  db.prepare(
    "INSERT INTO card_logs (card_id, created_at, kind, message) VALUES (?, ?, ?, ?)"
  ).run(id, t, "inbound", `${m.source} inbound message`);

  queueWake({
    key: `inbox:${id}`,
    text: `Kanban: Inbox +1 - ${title}`,
    debounceMs: 8000,
  });

  res.json({ id });
});

// --- Production: serve React UI from dist/ ---
if (isProduction) {
  app.use(express.static(distDir));
  // SPA fallback: serve index.html for non-API routes only
  // Express 5 requires named wildcard params (not bare "*")
  app.get("/{*splat}", (req, res) => {
    if (req.path.startsWith("/api/") || req.path === "/health" || req.path === "/healthz") {
      return res.status(404).json({ error: "not_found" });
    }
    res.sendFile(path.join(distDir, "index.html"));
  });
}

app.listen(PORT, HOST, () => {
  console.log(`[claw-kanban] listening on http://${HOST}:${PORT} (db: ${dbPath})`);
  if (isProduction) {
    console.log(`[claw-kanban] mode: production (serving UI from ${distDir})`);
  } else {
    console.log(`[claw-kanban] mode: development (UI served by Vite on separate port)`);
  }
  if (OPENCLAW_CONFIG_PATH) {
    console.log(`[claw-kanban] OpenClaw gateway integration: enabled (${OPENCLAW_CONFIG_PATH})`);
  } else {
    console.log(`[claw-kanban] OpenClaw gateway integration: disabled (set OPENCLAW_CONFIG to enable)`);
  }
});
