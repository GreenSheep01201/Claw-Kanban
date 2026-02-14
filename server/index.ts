import express from "express";
import cors from "cors";
import path from "path";
import fs from "node:fs";
import os from "node:os";
import { randomUUID, createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
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

const PKG_VERSION: string = JSON.parse(
  fs.readFileSync(path.resolve(__server_dirname, "..", "package.json"), "utf8"),
).version ?? "1.0.0";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1"; // set 0.0.0.0 for Tailscale/LAN

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// --- OAuth extension (optional) ---
// v1 goal: allow UI-based OAuth connect and server-side token storage.
// Security: never store refresh/access tokens in browser localStorage.
const OAUTH_BASE_URL = process.env.OAUTH_BASE_URL || `http://${HOST}:${PORT}`;
const OAUTH_ENCRYPTION_SECRET = process.env.OAUTH_ENCRYPTION_SECRET || process.env.SESSION_SECRET || "";

// Built-in OAuth credentials (same as OpenClaw's built-in values)
const BUILTIN_GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const BUILTIN_GOOGLE_CLIENT_ID = Buffer.from(
  "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
  "base64",
).toString();
const BUILTIN_GOOGLE_CLIENT_SECRET = Buffer.from(
  "R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=",
  "base64",
).toString();

function oauthEncryptionKey(): Buffer {
  // Derive a stable 32-byte key from env secret (minimal v1).
  if (!OAUTH_ENCRYPTION_SECRET) {
    throw new Error("Missing OAUTH_ENCRYPTION_SECRET (required to encrypt OAuth tokens at rest)");
  }
  return createHash("sha256").update(OAUTH_ENCRYPTION_SECRET, "utf8").digest();
}

function encryptSecret(plaintext: string): string {
  const key = oauthEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  // format: v1:<ivb64>:<tagb64>:<ctb64>
  return ["v1", iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

function decryptSecret(payload: string): string {
  const [ver, ivB64, tagB64, ctB64] = payload.split(":");
  if (ver !== "v1" || !ivB64 || !tagB64 || !ctB64) throw new Error("invalid_encrypted_payload");
  const key = oauthEncryptionKey();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
  return dec.toString("utf8");
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pkceVerifier(): string {
  return b64url(randomBytes(32));
}

function pkceChallengeS256(verifier: string): string {
  const hash = createHash("sha256").update(verifier, "utf8").digest();
  return b64url(hash);
}

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
// OAuth provider config stored in settings
interface OAuthProviderConfig {
  model: string;
  via: "opencode" | "openclaw";
}
type OAuthProviderConfigMap = Record<string, OAuthProviderConfig>;

function getOAuthProviderConfig(): OAuthProviderConfigMap {
  const settings = getProviderSettings();
  return settings.oauthProviderConfig ?? {};
}

function buildAgentArgs(agent: string): string[] {
  switch (agent) {
    case "codex":
      return ["codex", "--yolo", "exec", "--json"];
    case "claude":
      return ["claude", "--dangerously-skip-permissions", "--print", "--verbose",
              "--output-format=stream-json", "--include-partial-messages"];
    case "gemini":
      return ["gemini", "--yolo", "--output-format=stream-json"];
    case "opencode":
      return ["opencode", "run", "--format", "json"];
    case "copilot":
    case "antigravity": {
      const config = getOAuthProviderConfig()[agent];
      const model = config?.model || (agent === "copilot" ? "github-copilot/claude-sonnet-4.5" : "gemini-2.5-pro");
      const via = config?.via || "opencode";
      if (via === "opencode") {
        return ["opencode", "run", "--format", "json", "--model", model];
      }
      // openclaw route
      return ["openclaw", "agent", "--message-stdin", "--model", model, "--output-format", "stream-json"];
    }
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
    console.error(`[Claw-Kanban] spawn error for ${agent} (card ${cardId}): ${err.message}`);
    logStream.write(`\n[Claw-Kanban] SPAWN ERROR: ${err.message}\n`);
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

-- OAuth extension tables (optional)
CREATE TABLE IF NOT EXISTS oauth_states (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  verifier_enc TEXT NOT NULL,
  redirect_to TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_provider_created ON oauth_states(provider, created_at DESC);

CREATE TABLE IF NOT EXISTS oauth_credentials (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  email TEXT,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  expires_at INTEGER,
  scope TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_credentials_provider ON oauth_credentials(provider);
`);

// Migration: add project_path column (safe to re-run; silently ignored if column exists)
try { db.exec(`ALTER TABLE cards ADD COLUMN project_path TEXT`); } catch { /* column already exists */ }

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
      console.warn(`[Claw-Kanban] invalid gateway.port in ${OPENCLAW_CONFIG_PATH}`);
      return null;
    }
    const token =
      typeof parsed?.gateway?.auth?.token === "string" ? parsed.gateway.auth.token : undefined;
    const url = `ws://127.0.0.1:${port}${GATEWAY_WS_PATH}`;
    cachedGateway = { url, token, loadedAt: now };
    return { url, token };
  } catch (err) {
    console.warn(`[Claw-Kanban] failed to read gateway config: ${String(err)}`);
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
        displayName: "Claw-Kanban",
        version: PKG_VERSION,
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
    console.warn(`[Claw-Kanban] wake failed (${params.key}): ${String(err)}`);
  });
}

const CardStatus = z.enum(["Inbox", "Planned", "In Progress", "Review/Test", "Done", "Stopped"]);
const Assignee = z.enum(["claude", "codex", "gemini", "opencode", "copilot", "antigravity"]).optional();
const Role = z.enum(["devops", "backend", "frontend"]).optional();
const TaskType = z.enum(["new", "modify", "bugfix"]).optional();
const Provider = z.enum(["claude", "codex", "gemini", "opencode", "copilot", "antigravity"]);

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
  oauthProviderConfig: {} as OAuthProviderConfigMap,
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

// 3-step fallback: card.project_path field → extractProjectPath(description) → cwd
function resolveProjectPath(card: { project_path?: string | null; description: string }): string {
  if (card.project_path) return card.project_path;
  return extractProjectPath(card.description) || process.cwd();
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
  project_path: z.string().optional(),
});

const buildHealthPayload = () => ({
  ok: true,
  version: PKG_VERSION,
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
  const OAuthProviderConfigSchema = z.object({
    model: z.string(),
    via: z.enum(["opencode", "openclaw"]),
  });
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
    oauthProviderConfig: z.record(z.string(), OAuthProviderConfigSchema).optional(),
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

// --- OAuth Connect ---
// Keep CLI provider flow unchanged; OAuth is a separate server-side credential flow.
// Security: tokens are encrypted at rest in sqlite; browser only receives status metadata.

type OAuthCredentialProvider = "github" | "copilot_pat" | "google_antigravity";
type OAuthConnectProvider = "github-copilot" | "antigravity";

const OAuthCredentialProviderSchema = z.enum(["github", "copilot_pat", "google_antigravity"]);
const OAuthConnectProviderSchema = z.enum(["github-copilot", "antigravity"]);
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

type OAuthStateRow = {
  id: string;
  provider: OAuthCredentialProvider;
  created_at: number;
  verifier_enc: string;
  redirect_to: string | null;
};

type OAuthCredentialRow = {
  provider: OAuthCredentialProvider;
  email: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  scope: string | null;
  refresh_token_enc: string | null;
};

function requireOAuthStorageReady() {
  if (!OAUTH_ENCRYPTION_SECRET) {
    throw new Error("missing_OAUTH_ENCRYPTION_SECRET");
  }
}

function cleanupOAuthStates() {
  db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(nowMs() - OAUTH_STATE_TTL_MS);
}

function sanitizeOAuthRedirect(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  const input = raw.trim();
  if (!input) return "/";

  if (input.startsWith("/") && !input.startsWith("//")) return input;

  try {
    const u = new URL(input);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "/";

    const allowedHosts = new Set(["127.0.0.1", "localhost", "0.0.0.0", HOST]);
    const envHosts = (process.env.OAUTH_ALLOWED_REDIRECT_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    for (const h of envHosts) allowedHosts.add(h);
    if (u.hostname.startsWith("127.")) return u.toString();
    if (!allowedHosts.has(u.hostname)) return "/";
    return u.toString();
  } catch {
    return "/";
  }
}

function appendOAuthQuery(redirectTo: string, key: string, value: string): string {
  const isRelative = redirectTo.startsWith("/");
  const target = new URL(redirectTo, OAUTH_BASE_URL);
  target.searchParams.set(key, value);
  if (isRelative) {
    return `${target.pathname}${target.search}${target.hash}`;
  }
  return target.toString();
}

function consumeOAuthState(stateId: string, provider: OAuthCredentialProvider): OAuthStateRow | null {
  const row = db
    .prepare("SELECT * FROM oauth_states WHERE id = ? AND provider = ?")
    .get(stateId, provider) as OAuthStateRow | undefined;
  if (!row) return null;

  db.prepare("DELETE FROM oauth_states WHERE id = ?").run(stateId);
  if (nowMs() - row.created_at > OAUTH_STATE_TTL_MS) return null;
  return row;
}

function upsertOAuthCredential(input: {
  provider: OAuthCredentialProvider;
  email?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null;
  scope?: string | null;
}) {
  requireOAuthStorageReady();
  const t = nowMs();
  const existing = db.prepare("SELECT id, created_at FROM oauth_credentials WHERE provider = ?").get(input.provider) as
    | { id: string; created_at: number }
    | undefined;
  const id = existing?.id ?? randomUUID();
  db.prepare(
    `INSERT INTO oauth_credentials (id, provider, created_at, updated_at, email, access_token_enc, refresh_token_enc, expires_at, scope)
     VALUES (@id, @provider, @created_at, @updated_at, @email, @access_token_enc, @refresh_token_enc, @expires_at, @scope)
     ON CONFLICT(provider) DO UPDATE SET
       updated_at=excluded.updated_at,
       email=excluded.email,
       access_token_enc=excluded.access_token_enc,
       refresh_token_enc=excluded.refresh_token_enc,
       expires_at=excluded.expires_at,
       scope=excluded.scope
    `
  ).run({
    id,
    provider: input.provider,
    created_at: existing?.created_at ?? t,
    updated_at: t,
    email: input.email ?? null,
    access_token_enc: input.accessToken ? encryptSecret(input.accessToken) : null,
    refresh_token_enc: input.refreshToken ? encryptSecret(input.refreshToken) : null,
    expires_at: input.expiresAt ?? null,
    scope: input.scope ?? null,
  });
}

function deleteOAuthCredential(provider: OAuthCredentialProvider) {
  db.prepare("DELETE FROM oauth_credentials WHERE provider = ?").run(provider);
}

function startGitHubOAuth(redirectTo: string, callbackPath: string): string {
  requireOAuthStorageReady();
  const clientId = process.env.OAUTH_GITHUB_CLIENT_ID ?? BUILTIN_GITHUB_CLIENT_ID;
  if (!clientId) throw new Error("missing_OAUTH_GITHUB_CLIENT_ID");

  cleanupOAuthStates();
  const stateId = randomUUID();
  db.prepare(
    "INSERT INTO oauth_states (id, provider, created_at, verifier_enc, redirect_to) VALUES (?, ?, ?, ?, ?)"
  ).run(stateId, "github", nowMs(), "none", redirectTo);

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", `${OAUTH_BASE_URL}${callbackPath}`);
  url.searchParams.set("state", stateId);
  url.searchParams.set("scope", "read:user user:email");
  return url.toString();
}

function startGoogleAntigravityOAuth(redirectTo: string, callbackPath: string): string {
  requireOAuthStorageReady();
  const clientId = process.env.OAUTH_GOOGLE_CLIENT_ID ?? BUILTIN_GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("missing_OAUTH_GOOGLE_CLIENT_ID");

  cleanupOAuthStates();
  const verifier = pkceVerifier();
  const challenge = pkceChallengeS256(verifier);
  const stateId = randomUUID();

  db.prepare(
    "INSERT INTO oauth_states (id, provider, created_at, verifier_enc, redirect_to) VALUES (?, ?, ?, ?, ?)"
  ).run(stateId, "google_antigravity", nowMs(), encryptSecret(verifier), redirectTo);

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", `${OAUTH_BASE_URL}${callbackPath}`);
  url.searchParams.set("scope", [
    "https://www.googleapis.com/auth/cloud-platform",
    "openid",
    "email",
    "profile",
  ].join(" "));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", stateId);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

function getOAuthCredential(provider: OAuthCredentialProvider): OAuthCredentialRow | null {
  const row = db
    .prepare("SELECT provider, email, created_at, updated_at, expires_at, scope, refresh_token_enc FROM oauth_credentials WHERE provider = ?")
    .get(provider) as OAuthCredentialRow | undefined;
  return row ?? null;
}

function buildOAuthStatus() {
  const github = getOAuthCredential("github");
  const copilotPat = getOAuthCredential("copilot_pat");
  const antigravity = getOAuthCredential("google_antigravity");

  const githubSource = github ? "github" : copilotPat ? "copilot_pat" : null;
  const githubRow = github ?? copilotPat;

  return {
    "github-copilot": {
      provider: "github-copilot" as const,
      connected: Boolean(githubRow),
      source: githubSource,
      email: githubRow?.email ?? null,
      createdAt: githubRow?.created_at ?? null,
      updatedAt: githubRow?.updated_at ?? null,
      expiresAt: githubRow?.expires_at ?? null,
      scope: githubRow?.scope ?? null,
      hasRefreshToken: Boolean(githubRow?.refresh_token_enc),
    },
    antigravity: {
      provider: "antigravity" as const,
      connected: Boolean(antigravity),
      source: antigravity ? "google_antigravity" : null,
      email: antigravity?.email ?? null,
      createdAt: antigravity?.created_at ?? null,
      updatedAt: antigravity?.updated_at ?? null,
      expiresAt: antigravity?.expires_at ?? null,
      scope: antigravity?.scope ?? null,
      hasRefreshToken: Boolean(antigravity?.refresh_token_enc),
    },
  };
}

function buildOAuthStartUrl(provider: OAuthConnectProvider, redirectTo: string, callbackMode: "generic" | "legacy"): string {
  if (provider === "github-copilot") {
    const callbackPath = callbackMode === "legacy" ? "/api/oauth/github/callback" : "/api/oauth/callback/github-copilot";
    return startGitHubOAuth(redirectTo, callbackPath);
  }
  const callbackPath = callbackMode === "legacy" ? "/api/oauth/google-antigravity/callback" : "/api/oauth/callback/antigravity";
  return startGoogleAntigravityOAuth(redirectTo, callbackPath);
}

app.get("/api/oauth/status", (_req, res) => {
  cleanupOAuthStates();
  res.json({
    storageReady: Boolean(OAUTH_ENCRYPTION_SECRET),
    providers: buildOAuthStatus(),
  });
});

app.get("/api/oauth/connections", (_req, res) => {
  const rows = db
    .prepare("SELECT provider, email, created_at, updated_at, expires_at, scope FROM oauth_credentials")
    .all() as Array<{ provider: string; email: string | null; created_at: number; updated_at: number; expires_at: number | null; scope: string | null }>;
  const out = rows.map((r) => ({
    provider: r.provider,
    email: r.email,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    expiresAt: r.expires_at,
    scope: r.scope,
  }));
  res.json({ connections: out });
});

app.post("/api/oauth/disconnect", (req, res) => {
  const schema = z.object({ provider: OAuthConnectProviderSchema });
  const { provider } = schema.parse(req.body ?? {});

  if (provider === "github-copilot") {
    deleteOAuthCredential("github");
    deleteOAuthCredential("copilot_pat");
  } else {
    deleteOAuthCredential("google_antigravity");
  }

  appendSystemLog("system", `OAuth disconnected: ${provider}`);
  res.json({ ok: true });
});

app.delete("/api/oauth/:provider", (req, res) => {
  const parsed = OAuthCredentialProviderSchema.safeParse(String(req.params.provider));
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_provider" });
  }
  deleteOAuthCredential(parsed.data);
  appendSystemLog("system", `OAuth disconnected: ${parsed.data}`);
  res.json({ ok: true });
});

app.get("/api/oauth/start", (req, res) => {
  const providerRaw = firstQueryValue(req.query.provider);
  const parsed = OAuthConnectProviderSchema.safeParse(providerRaw);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_provider" });
  }

  const redirectTo = sanitizeOAuthRedirect(firstQueryValue(req.query.redirect_to) ?? "/");
  try {
    const authUrl = buildOAuthStartUrl(parsed.data, redirectTo, "generic");
    res.redirect(302, authUrl);
  } catch (err) {
    res.status(500).json({ error: "oauth_start_failed", message: String(err) });
  }
});

app.get("/api/oauth/github/start", (req, res) => {
  const redirectTo = sanitizeOAuthRedirect(firstQueryValue(req.query.redirect_to) ?? "/");
  try {
    const authUrl = buildOAuthStartUrl("github-copilot", redirectTo, "legacy");
    res.redirect(302, authUrl);
  } catch (err) {
    res.status(500).json({ error: "oauth_start_failed", message: String(err) });
  }
});

app.get("/api/oauth/github-copilot/start", (req, res) => {
  const redirectTo = sanitizeOAuthRedirect(firstQueryValue(req.query.redirect_to) ?? "/");
  try {
    const authUrl = startGitHubOAuth(redirectTo, "/api/oauth/github-copilot/callback");
    res.redirect(302, authUrl);
  } catch (err) {
    res.status(500).json({ error: "oauth_start_failed", message: String(err) });
  }
});

app.get("/api/oauth/google-antigravity/start", (req, res) => {
  const redirectTo = sanitizeOAuthRedirect(firstQueryValue(req.query.redirect_to) ?? "/");
  try {
    const authUrl = buildOAuthStartUrl("antigravity", redirectTo, "legacy");
    res.redirect(302, authUrl);
  } catch (err) {
    res.status(500).json({ error: "oauth_start_failed", message: String(err) });
  }
});

app.get("/api/oauth/antigravity/start", (req, res) => {
  const redirectTo = sanitizeOAuthRedirect(firstQueryValue(req.query.redirect_to) ?? "/");
  try {
    const authUrl = startGoogleAntigravityOAuth(redirectTo, "/api/oauth/antigravity/callback");
    res.redirect(302, authUrl);
  } catch (err) {
    res.status(500).json({ error: "oauth_start_failed", message: String(err) });
  }
});

// Manual Copilot PAT entry (optional alternative to GitHub OAuth).
app.post("/api/oauth/copilot/pat", (req, res) => {
  const schema = z.object({ token: z.string().min(10) });
  const { token } = schema.parse(req.body ?? {});
  upsertOAuthCredential({ provider: "copilot_pat", accessToken: token });
  appendSystemLog("system", "Copilot PAT stored (encrypted)");
  res.json({ ok: true });
});

// --- GitHub Device Code Flow (same as OpenClaw) ---
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

app.post("/api/oauth/github-copilot/device-start", async (_req, res) => {
  try {
    requireOAuthStorageReady();
  } catch {
    return res.status(400).json({ error: "missing_OAUTH_ENCRYPTION_SECRET" });
  }

  const clientId = process.env.OAUTH_GITHUB_CLIENT_ID ?? BUILTIN_GITHUB_CLIENT_ID;
  try {
    const resp = await fetch(GITHUB_DEVICE_CODE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ client_id: clientId, scope: "read:user" }),
    });

    if (!resp.ok) {
      return res.status(502).json({ error: "github_device_code_failed", status: resp.status });
    }

    const json = (await resp.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };

    if (!json.device_code || !json.user_code) {
      return res.status(502).json({ error: "github_device_code_invalid" });
    }

    // Encrypt and store device_code server-side so the browser never sees it
    const stateId = randomUUID();
    cleanupOAuthStates();
    db.prepare(
      "INSERT INTO oauth_states (id, provider, created_at, verifier_enc, redirect_to) VALUES (?, ?, ?, ?, ?)",
    ).run(stateId, "github", nowMs(), encryptSecret(json.device_code), null);

    res.json({
      stateId,
      userCode: json.user_code,
      verificationUri: json.verification_uri,
      expiresIn: json.expires_in,
      interval: json.interval,
    });
  } catch (err) {
    res.status(500).json({ error: "github_device_start_failed", message: String(err) });
  }
});

app.post("/api/oauth/github-copilot/device-poll", async (req, res) => {
  const schema = z.object({ stateId: z.string().uuid() });
  const { stateId } = schema.parse(req.body ?? {});

  const row = db
    .prepare("SELECT * FROM oauth_states WHERE id = ? AND provider = ?")
    .get(stateId, "github") as OAuthStateRow | undefined;
  if (!row) {
    return res.status(400).json({ error: "invalid_state", status: "expired" });
  }
  if (nowMs() - row.created_at > OAUTH_STATE_TTL_MS) {
    db.prepare("DELETE FROM oauth_states WHERE id = ?").run(stateId);
    return res.json({ status: "expired" });
  }

  let deviceCode: string;
  try {
    deviceCode = decryptSecret(row.verifier_enc);
  } catch {
    return res.status(500).json({ error: "decrypt_failed" });
  }

  const clientId = process.env.OAUTH_GITHUB_CLIENT_ID ?? BUILTIN_GITHUB_CLIENT_ID;
  try {
    const resp = await fetch(GITHUB_ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    if (!resp.ok) {
      return res.status(502).json({ error: "github_poll_failed", status: "error" });
    }

    const json = (await resp.json()) as Record<string, unknown>;

    if ("access_token" in json && typeof json.access_token === "string") {
      // Success — store token and clean up state
      db.prepare("DELETE FROM oauth_states WHERE id = ?").run(stateId);
      const accessToken = json.access_token;

      // Fetch user email
      let email: string | null = null;
      try {
        const emailsResp = await fetch("https://api.github.com/user/emails", {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": "claw-kanban",
            Accept: "application/vnd.github+json",
          },
        });
        if (emailsResp.ok) {
          const emails = (await emailsResp.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
          const primary = emails.find((e) => e.primary && e.verified);
          if (primary) email = primary.email;
        }
      } catch {
        // email fetch is best-effort
      }

      upsertOAuthCredential({
        provider: "github",
        email,
        accessToken,
        scope: typeof json.scope === "string" ? json.scope : null,
      });
      appendSystemLog("system", "GitHub/Copilot connected via device code flow");

      return res.json({ status: "complete", email });
    }

    const error = typeof json.error === "string" ? json.error : "unknown";
    if (error === "authorization_pending") {
      return res.json({ status: "pending" });
    }
    if (error === "slow_down") {
      return res.json({ status: "slow_down" });
    }
    if (error === "expired_token") {
      db.prepare("DELETE FROM oauth_states WHERE id = ?").run(stateId);
      return res.json({ status: "expired" });
    }
    if (error === "access_denied") {
      db.prepare("DELETE FROM oauth_states WHERE id = ?").run(stateId);
      return res.json({ status: "denied" });
    }

    return res.json({ status: "error", error });
  } catch (err) {
    return res.status(500).json({ error: "github_poll_error", message: String(err) });
  }
});

async function handleGitHubCallback(req: express.Request, res: express.Response, callbackPath: string) {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (!code || !state) return res.status(400).send("Missing code/state");

  const row = consumeOAuthState(state, "github");
  if (!row) return res.status(400).send("Invalid or expired state");

  const redirectTo = sanitizeOAuthRedirect(row.redirect_to ?? "/");
  const clientId = process.env.OAUTH_GITHUB_CLIENT_ID ?? BUILTIN_GITHUB_CLIENT_ID;
  const clientSecret = process.env.OAUTH_GITHUB_CLIENT_SECRET;
  if (!clientId) {
    const fail = appendOAuthQuery(redirectTo, "oauth_error", "github_env_missing");
    return res.redirect(302, fail);
  }

  try {
    const tokenBody: Record<string, string> = {
      client_id: clientId,
      code,
      redirect_uri: `${OAUTH_BASE_URL}${callbackPath}`,
    };
    if (clientSecret) tokenBody.client_secret = clientSecret;
    const tokenResp = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(tokenBody),
    });
    const tokenJson = await tokenResp.json() as any;
    if (!tokenResp.ok || !tokenJson.access_token) {
      const fail = appendOAuthQuery(redirectTo, "oauth_error", "github_exchange_failed");
      return res.redirect(302, fail);
    }

    const accessToken = String(tokenJson.access_token);

    const emailsResp = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "claw-kanban",
        Accept: "application/vnd.github+json",
      },
    });
    const emails = emailsResp.ok ? (await emailsResp.json() as any[]) : [];
    const primary = Array.isArray(emails) ? emails.find((e) => e?.primary) : null;
    const email = primary?.verified ? String(primary.email) : null;

    upsertOAuthCredential({ provider: "github", email, accessToken, scope: tokenJson.scope ?? null });
    appendSystemLog("system", "GitHub/Copilot OAuth connected");

    const ok = appendOAuthQuery(redirectTo, "oauth", "github_connected");
    return res.redirect(302, ok);
  } catch {
    const fail = appendOAuthQuery(redirectTo, "oauth_error", "github_callback_failed");
    return res.redirect(302, fail);
  }
}

async function handleGoogleAntigravityCallback(req: express.Request, res: express.Response, callbackPath: string) {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (!code || !state) return res.status(400).send("Missing code/state");

  const row = consumeOAuthState(state, "google_antigravity");
  if (!row) return res.status(400).send("Invalid or expired state");

  const redirectTo = sanitizeOAuthRedirect(row.redirect_to ?? "/");
  const clientId = process.env.OAUTH_GOOGLE_CLIENT_ID ?? BUILTIN_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.OAUTH_GOOGLE_CLIENT_SECRET ?? BUILTIN_GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const fail = appendOAuthQuery(redirectTo, "oauth_error", "google_env_missing");
    return res.redirect(302, fail);
  }

  let verifier = "";
  try {
    verifier = decryptSecret(String(row.verifier_enc));
  } catch {
    const fail = appendOAuthQuery(redirectTo, "oauth_error", "google_verifier_invalid");
    return res.redirect(302, fail);
  }

  try {
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: `${OAUTH_BASE_URL}${callbackPath}`,
        code_verifier: verifier,
      }),
    });

    const tokenJson = await tokenResp.json() as any;
    if (!tokenResp.ok || !tokenJson.access_token) {
      const fail = appendOAuthQuery(redirectTo, "oauth_error", "google_exchange_failed");
      return res.redirect(302, fail);
    }

    const accessToken = String(tokenJson.access_token);
    const refreshToken = tokenJson.refresh_token ? String(tokenJson.refresh_token) : null;
    const expiresIn = typeof tokenJson.expires_in === "number" ? tokenJson.expires_in : 3600;
    const expiresAt = Date.now() + expiresIn * 1000;

    let email: string | null = null;
    const userinfoResp = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (userinfoResp.ok) {
      const ui = await userinfoResp.json() as any;
      if (ui?.email) email = String(ui.email);
    }

    upsertOAuthCredential({
      provider: "google_antigravity",
      email,
      accessToken,
      refreshToken,
      expiresAt,
      scope: tokenJson.scope ?? null,
    });
    appendSystemLog("system", "Google Antigravity OAuth connected");

    const ok = appendOAuthQuery(redirectTo, "oauth", "antigravity_connected");
    return res.redirect(302, ok);
  } catch {
    const fail = appendOAuthQuery(redirectTo, "oauth_error", "google_callback_failed");
    return res.redirect(302, fail);
  }
}

app.get("/api/oauth/callback/:provider", async (req, res) => {
  const provider = String(req.params.provider);
  if (provider === "github-copilot") {
    return handleGitHubCallback(req, res, "/api/oauth/callback/github-copilot");
  }
  if (provider === "antigravity") {
    return handleGoogleAntigravityCallback(req, res, "/api/oauth/callback/antigravity");
  }
  return res.status(400).send("Invalid provider");
});

app.get("/api/oauth/github/callback", async (req, res) => {
  return handleGitHubCallback(req, res, "/api/oauth/github/callback");
});

app.get("/api/oauth/github-copilot/callback", async (req, res) => {
  return handleGitHubCallback(req, res, "/api/oauth/github-copilot/callback");
});

app.get("/api/oauth/google-antigravity/callback", async (req, res) => {
  return handleGoogleAntigravityCallback(req, res, "/api/oauth/google-antigravity/callback");
});

app.get("/api/oauth/antigravity/callback", async (req, res) => {
  return handleGoogleAntigravityCallback(req, res, "/api/oauth/antigravity/callback");
});

// --- OpenClaw Auth-Profiles Import ---

type OpenClawProfileType = "oauth" | "token";

interface OpenClawOAuthProfile {
  type: "oauth";
  provider: string;
  access: string;
  refresh?: string;
  expires?: number;
  email?: string;
  accountId?: string;
  projectId?: string;
}

interface OpenClawTokenProfile {
  type: "token";
  provider: string;
  token: string;
}

type OpenClawProfile = OpenClawOAuthProfile | OpenClawTokenProfile;

interface OpenClawAuthProfiles {
  version: number;
  profiles: Record<string, OpenClawProfile>;
  lastGood?: Record<string, string>;
}

function resolveAuthProfilesPath(): string | null {
  if (!OPENCLAW_CONFIG_PATH) return null;
  try {
    const configDir = path.dirname(OPENCLAW_CONFIG_PATH);
    const candidate = path.join(configDir, "agents", "main", "agent", "auth-profiles.json");
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // ignore
  }
  return null;
}

type KanbanOAuthProvider = "google_antigravity" | "github";

interface ImportableProfile {
  profileKey: string;
  openclawProvider: string;
  kanbanProvider: KanbanOAuthProvider;
  label: string;
  email: string | null;
  expiresAt: number | null;
  hasRefreshToken: boolean;
  expired: boolean;
}

function readOpenClawProfiles(): ImportableProfile[] {
  const filePath = resolveAuthProfilesPath();
  if (!filePath) return [];

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw) as OpenClawAuthProfiles;
    if (!data?.profiles || typeof data.profiles !== "object") return [];

    const results: ImportableProfile[] = [];

    for (const [key, profile] of Object.entries(data.profiles)) {
      if (!profile?.provider) continue;

      if (profile.provider === "google-antigravity") {
        const p = profile as OpenClawOAuthProfile;
        results.push({
          profileKey: key,
          openclawProvider: "google-antigravity",
          kanbanProvider: "google_antigravity",
          label: "Google Antigravity",
          email: p.email ?? null,
          expiresAt: p.expires ?? null,
          hasRefreshToken: Boolean(p.refresh),
          expired: p.expires ? p.expires < Date.now() : false,
        });
      } else if (profile.provider === "github-copilot") {
        const isToken = profile.type === "token";
        results.push({
          profileKey: key,
          openclawProvider: "github-copilot",
          kanbanProvider: "github",
          label: "GitHub Copilot",
          email: null,
          expiresAt: isToken ? null : (profile as OpenClawOAuthProfile).expires ?? null,
          hasRefreshToken: isToken ? false : Boolean((profile as OpenClawOAuthProfile).refresh),
          expired: false,
        });
      }
    }

    return results;
  } catch {
    return [];
  }
}

function readOpenClawProfileToken(profileKey: string): { accessToken: string; refreshToken?: string } | null {
  const filePath = resolveAuthProfilesPath();
  if (!filePath) return null;

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw) as OpenClawAuthProfiles;
    const profile = data?.profiles?.[profileKey];
    if (!profile) return null;

    if (profile.type === "token") {
      return { accessToken: (profile as OpenClawTokenProfile).token };
    }
    if (profile.type === "oauth") {
      const p = profile as OpenClawOAuthProfile;
      return { accessToken: p.access, refreshToken: p.refresh };
    }
    return null;
  } catch {
    return null;
  }
}

app.get("/api/oauth/openclaw/profiles", (_req, res) => {
  const profiles = readOpenClawProfiles();
  const authProfilesPath = resolveAuthProfilesPath();
  res.json({
    available: profiles.length > 0,
    authProfilesPath,
    profiles,
  });
});

app.post("/api/oauth/openclaw/import", (req, res) => {
  const schema = z.object({
    providers: z.array(z.enum(["google_antigravity", "github"])).optional(),
    overwrite: z.boolean().optional().default(false),
  });

  const { providers: requestedProviders, overwrite } = schema.parse(req.body ?? {});

  try {
    requireOAuthStorageReady();
  } catch {
    return res.status(400).json({ error: "missing_OAUTH_ENCRYPTION_SECRET" });
  }

  const profiles = readOpenClawProfiles();
  if (profiles.length === 0) {
    return res.json({ ok: true, imported: [], skipped: [], errors: [] });
  }

  const toImport = requestedProviders
    ? profiles.filter((p) => requestedProviders.includes(p.kanbanProvider))
    : profiles;

  const imported: string[] = [];
  const skipped: string[] = [];
  const errors: Array<{ provider: string; error: string }> = [];

  for (const profile of toImport) {
    try {
      // Check if already connected (skip unless overwrite)
      if (!overwrite) {
        const existing = getOAuthCredential(profile.kanbanProvider as OAuthCredentialProvider);
        if (existing) {
          skipped.push(profile.kanbanProvider);
          continue;
        }
      }

      const tokens = readOpenClawProfileToken(profile.profileKey);
      if (!tokens) {
        errors.push({ provider: profile.kanbanProvider, error: "token_read_failed" });
        continue;
      }

      upsertOAuthCredential({
        provider: profile.kanbanProvider as OAuthCredentialProvider,
        email: profile.email,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? null,
        expiresAt: profile.expiresAt,
        scope: null,
      });

      imported.push(profile.kanbanProvider);
      appendSystemLog("system", `OpenClaw import: ${profile.kanbanProvider} (${profile.profileKey})`);
    } catch (err) {
      errors.push({ provider: profile.kanbanProvider, error: String(err) });
    }
  }

  res.json({ ok: true, imported, skipped, errors });
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

interface CliToolDef {
  name: string;
  authHint: string;
  checkAuth: () => boolean;
}

function jsonHasKey(filePath: string, key: string): boolean {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const j = JSON.parse(raw);
    return j != null && typeof j === "object" && key in j && j[key] != null;
  } catch {
    return false;
  }
}

function fileExistsNonEmpty(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 2;
  } catch {
    return false;
  }
}

const CLI_TOOLS: CliToolDef[] = [
  {
    name: "claude",
    authHint: "Run: claude login",
    checkAuth: () => {
      const home = os.homedir();
      // Claude stores auth in oauthAccount key inside ~/.claude.json
      if (jsonHasKey(path.join(home, ".claude.json"), "oauthAccount")) return true;
      // Fallback: some versions use ~/.claude/auth.json
      return fileExistsNonEmpty(path.join(home, ".claude", "auth.json"));
    },
  },
  {
    name: "codex",
    authHint: "Run: codex auth login",
    checkAuth: () => {
      // File-based auth: ~/.codex/auth.json
      const authPath = path.join(os.homedir(), ".codex", "auth.json");
      if (jsonHasKey(authPath, "OPENAI_API_KEY") || jsonHasKey(authPath, "tokens")) return true;
      // Env var fallback (keyring mode or manual config)
      if (process.env.OPENAI_API_KEY) return true;
      return false;
    },
  },
  {
    name: "gemini",
    authHint: "Run: gemini auth login",
    checkAuth: () => {
      // macOS/Linux: ~/.gemini/oauth_creds.json
      if (jsonHasKey(path.join(os.homedir(), ".gemini", "oauth_creds.json"), "access_token")) return true;
      // Windows: %APPDATA%\gcloud\application_default_credentials.json
      const appData = process.env.APPDATA;
      if (appData && jsonHasKey(path.join(appData, "gcloud", "application_default_credentials.json"), "client_id")) return true;
      return false;
    },
  },
  {
    name: "opencode",
    authHint: "Run: opencode auth",
    checkAuth: () => {
      const home = os.homedir();
      // opencode stores auth in ~/.local/share/opencode/auth.json
      if (fileExistsNonEmpty(path.join(home, ".local", "share", "opencode", "auth.json"))) return true;
      // XDG_DATA_HOME fallback
      const xdgData = process.env.XDG_DATA_HOME;
      if (xdgData && fileExistsNonEmpty(path.join(xdgData, "opencode", "auth.json"))) return true;
      // macOS: ~/Library/Application Support/opencode/auth.json
      if (process.platform === "darwin") {
        if (fileExistsNonEmpty(path.join(home, "Library", "Application Support", "opencode", "auth.json"))) return true;
      }
      return false;
    },
  },
];

function execWithTimeout(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
    child.unref?.();
  });
}

async function detectCliTool(tool: CliToolDef): Promise<CliToolStatus> {
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

  const authenticated = tool.checkAuth();
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

// --- OAuth Provider Model Listing ---
let cachedModels: { data: Record<string, string[]>; loadedAt: number } | null = null;
const MODELS_CACHE_TTL = 60_000;

async function fetchOpenCodeModels(): Promise<Record<string, string[]>> {
  const grouped: Record<string, string[]> = {};
  try {
    const output = await execWithTimeout("opencode", ["models"], 10_000);
    for (const line of output.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes("/")) continue;
      const slashIdx = trimmed.indexOf("/");
      const provider = trimmed.slice(0, slashIdx);
      const model = trimmed.slice(slashIdx + 1);
      // Only include OAuth-relevant providers
      if (provider === "github-copilot" || provider === "openai" || provider === "opencode") {
        const key = provider === "github-copilot" ? "copilot" : provider;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(trimmed);
      }
    }
  } catch {
    // opencode not available or failed
  }
  return grouped;
}

async function fetchOpenClawModels(): Promise<Record<string, string[]>> {
  const grouped: Record<string, string[]> = {};
  try {
    const output = await execWithTimeout("openclaw", ["models", "list", "--json"], 10_000);
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) {
      for (const m of parsed) {
        const id = typeof m === "string" ? m : m?.id;
        if (!id) continue;
        if (id.includes("antigravity") || id.includes("google-antigravity")) {
          if (!grouped.antigravity) grouped.antigravity = [];
          grouped.antigravity.push(id);
        }
      }
    }
  } catch {
    // openclaw not available or failed; add well-known antigravity models
    grouped.antigravity = [
      "google-antigravity/gemini-2.5-pro",
      "google-antigravity/gemini-2.5-flash",
      "google-antigravity/claude-sonnet-4-5",
      "google-antigravity/claude-opus-4-5",
    ];
  }
  return grouped;
}

app.get("/api/oauth/models", async (_req, res) => {
  const now = Date.now();
  if (cachedModels && now - cachedModels.loadedAt < MODELS_CACHE_TTL) {
    return res.json({ models: cachedModels.data });
  }

  try {
    const [ocModels, clawModels] = await Promise.all([
      fetchOpenCodeModels(),
      fetchOpenClawModels(),
    ]);

    // Merge results
    const merged: Record<string, string[]> = { ...ocModels };
    for (const [key, models] of Object.entries(clawModels)) {
      if (!merged[key]) merged[key] = [];
      for (const m of models) {
        if (!merged[key].includes(m)) merged[key].push(m);
      }
    }

    cachedModels = { data: merged, loadedAt: Date.now() };
    res.json({ models: merged });
  } catch (err) {
    res.status(500).json({ error: "model_fetch_failed", message: String(err) });
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
    `INSERT INTO cards (id, created_at, updated_at, source, source_message_id, source_author, source_chat, title, description, status, assignee, priority, role, task_type, project_path)
     VALUES (@id, @created_at, @updated_at, @source, @source_message_id, @source_author, @source_chat, @title, @description, @status, @assignee, @priority, @role, @task_type, @project_path)`
  ).run({
    id,
    created_at: t,
    updated_at: t,
    source: input.source,
    source_message_id: input.source_message_id ?? null,
    source_author: input.source_author ?? null,
    source_chat: input.source_chat ?? null,
    title: input.title,
    description: input.description,
    status: input.status,
    assignee: assignee ?? null,
    priority: input.priority,
    role: input.role ?? null,
    task_type: input.task_type ?? null,
    project_path: input.project_path ?? null,
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
      project_path: z.string().nullable().optional(),
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
     SET updated_at=@updated_at, title=@title, description=@description, status=@status, assignee=@assignee, priority=@priority, role=@role, task_type=@task_type, project_path=@project_path
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
    project_path: next.project_path ?? null,
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
  if (!["claude", "codex", "gemini", "opencode", "copilot", "antigravity"].includes(agent)) {
    return res.status(400).json({ error: "unsupported_agent", agent });
  }

  const projectPath = resolveProjectPath(card);

  // Block run if no project_path is resolved (falls back to cwd which is ambiguous)
  if (!card.project_path && !extractProjectPath(card.description)) {
    return res.status(400).json({
      error: "missing_project_path",
      message: "project_path is not set. Please set a project path before running the agent.",
    });
  }
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

  // Block review if no project_path is resolved
  if (!card.project_path && !extractProjectPath(card.description)) {
    return res.status(400).json({
      error: "missing_project_path",
      message: "project_path is not set. Please set a project path before running review.",
    });
  }

  const projectPath = resolveProjectPath(card);
  startReviewTest(id, projectPath);

  res.json({ ok: true, message: "Review started" });
});

function killPidTree(pid: number) {
  if (process.platform === "win32") {
    // Windows: use taskkill /T (tree) /F (force) synchronously
    try {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { timeout: 5000 }, () => {});
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
    text: z.string().min(1),
    project_path: z.string().optional(),
  });
  const m = schema.parse(req.body ?? {});

  const raw = m.text.trimStart();
  const normalized = raw.startsWith("#") ? raw.slice(1).trimStart() : raw;

  const title = normalized.length > 80 ? normalized.slice(0, 80) + "\u2026" : normalized;
  const description = normalized;

  const id = uuid();
  const t = nowMs();
  db.prepare(
    `INSERT INTO cards (id, created_at, updated_at, source, source_message_id, source_author, source_chat, title, description, status, assignee, priority, project_path)
     VALUES (@id, @created_at, @updated_at, @source, @source_message_id, @source_author, @source_chat, @title, @description, @status, @assignee, @priority, @project_path)`
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
    priority: 0,
    project_path: m.project_path ?? null,
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
  console.log(`[Claw-Kanban] v${PKG_VERSION} listening on http://${HOST}:${PORT} (db: ${dbPath})`);
  if (isProduction) {
    console.log(`[Claw-Kanban] mode: production (serving UI from ${distDir})`);
  } else {
    console.log(`[Claw-Kanban] mode: development (UI served by Vite on separate port)`);
  }
  if (OPENCLAW_CONFIG_PATH) {
    console.log(`[Claw-Kanban] OpenClaw gateway integration: enabled (${OPENCLAW_CONFIG_PATH})`);
  } else {
    console.log(`[Claw-Kanban] OpenClaw gateway integration: disabled (set OPENCLAW_CONFIG to enable)`);
  }
});
