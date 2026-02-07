<p align="center">
  <img src="public/kanban-claw.svg" width="80" alt="Claw Kanban" />
</p>

<h1 align="center">Claw Kanban</h1>

<p align="center">
  <strong>AI Agent Orchestration Kanban Board</strong><br>
  Route tasks to <b>Claude Code</b>, <b>Codex CLI</b>, and <b>Gemini CLI</b> with role-based auto-assignment and real-time monitoring.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#features">Features</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="#api-reference">API</a> &middot;
  <a href="README.ko.md">한국어</a>
</p>

---

## Features

- **6-Column Kanban Board** — Inbox, Planned, In Progress, Review/Test, Done, Stopped
- **Multi-Agent Orchestration** — Spawn and manage Claude Code, Codex CLI, and Gemini CLI processes
- **Role-Based Auto-Assignment** — Automatically route tasks by role (DevOps / Backend / Frontend) and task type (New / Modify / Bugfix)
- **AI Provider Detection** — Settings panel shows install and auth status for each CLI tool; unauthenticated providers are disabled in dropdowns
- **Automatic Review** — After implementation completes, auto-trigger a review/test cycle via Claude
- **Real-time Terminal Viewer** — Stream-JSON log parser for Claude / Codex / Gemini output
- **Webhook Ingestion** — `POST /api/inbox` to create cards from Telegram, Slack, or any source
- **OpenClaw Gateway Integration** — Optional wake notifications on card status changes
- **Modern Dark UI** — React 19, responsive, glassmorphism design
- **SQLite Storage** — Zero-config, file-based database via Node.js built-in `node:sqlite`
- **Cross-Platform** — macOS, Linux, and Windows

## Prerequisites

- **Node.js 22+** (required for `node:sqlite`)
- **pnpm** (recommended) or npm
- At least one AI CLI tool installed and authenticated:

| Tool | Install | Authenticate |
|------|---------|-------------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `npm i -g @anthropic-ai/claude-code` | `claude login` |
| [OpenAI Codex CLI](https://github.com/openai/codex) | `npm i -g @openai/codex` | `codex auth login` |
| [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm i -g @anthropic-ai/gemini-cli` | `gemini auth login` |

## Quick Start

### One-Line Install

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/GreenSheep01201/claw-kanban/main/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/GreenSheep01201/claw-kanban/main/install.ps1 | iex
```

The installer clones the repo, installs dependencies, builds the UI, configures `.env` and `AGENTS.md`, and registers an auto-start service (launchd on macOS, systemd on Linux).

### Manual Install

```bash
git clone https://github.com/GreenSheep01201/claw-kanban.git
cd claw-kanban
pnpm install
pnpm build
```

### Running

```bash
# Production (serves built UI)
pnpm start

# Development (Vite HMR + API with hot reload, LAN accessible)
pnpm dev

# Development (localhost only)
pnpm dev:local
```

| | URL |
|---|---|
| **UI** | http://127.0.0.1:5173 (dev) or http://127.0.0.1:8787 (prod) |
| **API** | http://127.0.0.1:8787 |

## How It Works

```
1. Task arrives (UI / API / webhook)  ──>  Card created in Inbox
2. Click "Start" or auto-assign      ──>  CLI process spawned (Claude/Codex/Gemini)
3. Card moves to "In Progress"       ──>  Real-time terminal logs available
4. Agent completes (exit 0)           ──>  Card auto-moves to "Review/Test"
5. Auto-review triggers               ──>  Claude reviews the work
6. Review passes                      ──>  Card moves to "Done" + wake notification
7. Review fails                       ──>  Stays in "Review/Test", issues reported
```

### Task Flow Diagram

```
               ┌─────────┐
  UI / API ──> │  Inbox   │
  Webhook  ──> │         │
               └────┬────┘
                    │ Start (manual or auto)
               ┌────▼────┐
               │ Planned  │  (optional staging)
               └────┬────┘
                    │
               ┌────▼─────────┐
               │ In Progress   │  <── CLI agent running
               │ (terminal log)│
               └────┬─────────┘
                    │ exit 0
               ┌────▼─────────┐
               │ Review/Test   │  <── Claude auto-review
               └──┬────────┬──┘
          pass    │        │  issues found
          ┌───────▼┐   ┌───▼────┐
          │  Done   │   │Stopped │
          └────────┘   └────────┘
```

## Configuration

### Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8787` | API server port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for LAN/Tailscale) |
| `DB_PATH` | `./kanban.sqlite` | SQLite database file path |
| `LOGS_DIR` | `./logs` | Agent terminal log directory |
| `OPENCLAW_CONFIG` | *(empty)* | Path to `openclaw.json` for gateway wake integration |

### Provider Settings (UI)

Open **Settings** in the UI to configure:

| Section | Description |
|---------|-------------|
| **AI Providers** | Shows install/auth status for Claude, Codex, Gemini. Re-check button refreshes detection. |
| **Auto-assign** | Toggle role-based provider auto-assignment on/off |
| **Role-based Providers** | Map DevOps / Backend roles to a default provider |
| **FrontEnd Providers** | Map New / Modify / Bugfix task types to providers |
| **Stage-based Providers** | Optional overrides for In Progress and Review/Test stages |

Default mapping:

| Role | Task Type | Default Provider |
|------|-----------|-----------------|
| DevOps | — | Claude Code |
| Backend | — | Codex CLI |
| Frontend | New | Gemini CLI |
| Frontend | Modify | Claude Code |
| Frontend | Bugfix | Claude Code |

### AGENTS.md Integration

The setup script prepends kanban orchestration rules to your workspace `AGENTS.md`:

```bash
pnpm setup                                     # auto-detect location
pnpm setup -- --agents-path /path/to/AGENTS.md  # custom path
```

This teaches your AI agent to recognize `#`-prefixed messages as task requests and register them on the board.

### OpenClaw Gateway

Set `OPENCLAW_CONFIG` in `.env` to enable wake notifications:

```bash
OPENCLAW_CONFIG=~/.openclaw/openclaw.json
```

Wake notifications fire on:
- New Inbox card creation
- Card moving from Review/Test to Done

## Architecture

```
claw-kanban/
├── server/
│   └── index.ts            # Express 5 API server
│                            #   - SQLite storage (node:sqlite)
│                            #   - Agent process spawn/kill
│                            #   - CLI detection (GET /api/cli-status)
│                            #   - Gateway wake integration
├── src/
│   ├── App.tsx              # Kanban board + Settings modal
│   ├── App.css              # Dark theme (CSS variables)
│   ├── api.ts               # Frontend API client + TypeScript types
│   ├── main.tsx             # React 19 entry point
│   └── index.css            # Base/reset styles
├── public/
│   └── kanban-claw.svg      # App icon (OpenClaw lobster + kanban box)
├── templates/
│   └── AGENTS-kanban.md     # AGENTS.md orchestration rules template
├── scripts/
│   ├── setup.mjs            # AGENTS.md setup (prepend, not overwrite)
│   └── kanban.mjs           # Process management (start/stop/status)
├── install.sh               # One-line installer (macOS/Linux)
├── install.ps1              # One-line installer (Windows)
├── .env.example             # Environment variable template
├── vite.config.ts           # Vite config (dev proxy to API)
└── package.json
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + TypeScript + Vite |
| Backend | Express 5 + Node.js 22+ |
| Database | SQLite (via `node:sqlite`, zero dependencies) |
| AI Agents | Claude Code CLI, Codex CLI, Gemini CLI |
| Process Mgmt | Node `child_process` (spawn + stdin piping) |

## API Reference

### Cards

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/cards` | List all cards (optional `?status=Inbox`) |
| `GET` | `/api/cards/search?q=keyword` | Search cards across all fields |
| `POST` | `/api/cards` | Create a card |
| `PATCH` | `/api/cards/:id` | Update card fields |
| `DELETE` | `/api/cards/:id` | Delete card and all artifacts |
| `POST` | `/api/cards/purge?status=Done` | Bulk delete by status |

### Agent Control

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/cards/:id/run` | Start agent (spawns CLI process) |
| `POST` | `/api/cards/:id/stop` | Stop running agent (kill process tree) |
| `POST` | `/api/cards/:id/review` | Manually trigger review |
| `GET` | `/api/cards/:id/terminal` | Stream terminal output (`?lines=200&pretty=1`) |
| `GET` | `/api/cards/:id/logs` | Get card event logs |

### Settings & Status

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/settings` | Get provider settings |
| `PUT` | `/api/settings` | Save provider settings |
| `GET` | `/api/cli-status` | Detect CLI install/auth status (30s cache, `?refresh=1` to bypass) |

### Webhook

```bash
POST /api/inbox
Content-Type: application/json

{ "text": "# Fix the login bug", "source": "telegram", "author": "user123" }
```

### Health

```bash
GET /api/health    # { ok, dbPath, gateway }
```

## CLI Detection

The `/api/cli-status` endpoint checks each tool:

| Check | Method |
|-------|--------|
| **Installed** | `which` (Unix) / `where` (Windows) + `--version` |
| **Claude auth** | `~/.claude.json` contains `oauthAccount` key |
| **Codex auth** | `~/.codex/auth.json` contains `OPENAI_API_KEY` or `tokens`; fallback to `OPENAI_API_KEY` env var |
| **Gemini auth** | `~/.gemini/oauth_creds.json` contains `access_token`; on Windows also checks `%APPDATA%\gcloud\application_default_credentials.json` |

Results are cached for 30 seconds. Use `?refresh=1` to force re-check.

## Security

Claw-Kanban is a **local development tool**. Important notes:

- **No Authentication** — Bind to `127.0.0.1` (default). Only use `0.0.0.0` on trusted networks (VPN/Tailscale).
- **Agent Permission Flags** — `--dangerously-skip-permissions` (Claude), `--yolo` (Codex/Gemini) are used for autonomous operation.
- **Environment Inheritance** — Child processes inherit the server's environment.
- **CORS** — Open CORS enabled for Vite dev proxy. Do not expose to the public internet.

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| macOS | Fully supported | Primary dev platform. launchd auto-start. |
| Linux | Fully supported | systemd user service auto-start. |
| Windows | Supported | PowerShell installer. Uses `taskkill /T /F` for process management. |

## Management

```bash
# Using the management script
node scripts/kanban.mjs status    # Check if server is running
node scripts/kanban.mjs start     # Start in background
node scripts/kanban.mjs stop      # Stop server
node scripts/kanban.mjs restart   # Restart server

# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/ai.openclaw.kanban   # restart
launchctl bootout gui/$(id -u)/ai.openclaw.kanban         # stop

# Linux (systemd)
systemctl --user restart claw-kanban
systemctl --user stop claw-kanban
systemctl --user status claw-kanban
```

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.

Copyright 2025 GreenSheep01201
