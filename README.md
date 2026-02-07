# Claw-Kanban

AI Agent Orchestration Kanban Board. Route tasks to **Claude Code**, **Codex CLI**, and **Gemini CLI** with role-based auto-assignment, automatic review, and real-time terminal monitoring.

## Features

- **6-Column Kanban Board**: Inbox → Planned → In Progress → Review/Test → Done → Stopped
- **Multi-Agent Orchestration**: Spawn and manage Claude Code, Codex CLI, and Gemini CLI processes
- **Role-Based Auto-Assignment**: Automatically route tasks to the best agent based on role (DevOps/Backend/Frontend) and task type (New/Modify/Bugfix)
- **Automatic Review**: After implementation completes, auto-trigger review/test cycle
- **Real-time Terminal Viewer**: Stream-json log parser for Claude/Codex/Gemini output
- **Webhook Ingestion**: POST to `/api/inbox` to create cards from Telegram, Slack, or any source
- **OpenClaw Gateway Integration** (optional): Wake notifications on card status changes
- **Modern Dark UI**: React 19, responsive design, glassmorphism aesthetics
- **SQLite Storage**: Zero-config, file-based database via Node.js built-in `node:sqlite`

## Screenshots

> Coming soon

## Prerequisites

- **Node.js 22+** (required for `node:sqlite`)
- **pnpm** (recommended) or npm
- At least one of the following AI CLI tools installed:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
  - [OpenAI Codex CLI](https://github.com/openai/codex) (`codex`)
  - [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) (`gemini`)

## Quick Start

```bash
# Clone the repository
git clone https://github.com/GreenSheep01201/claw-kanban.git
cd claw-kanban

# Install dependencies
pnpm install

# Start development server (LAN/Tailscale accessible)
pnpm dev

# Or start local-only
pnpm dev:local
```

- **UI**: http://127.0.0.1:5173
- **API**: http://127.0.0.1:8787

## Agent Setup (AGENTS.md Integration)

The setup script prepends kanban orchestration rules to your existing `AGENTS.md` file. This is an **update, not an overwrite** - your existing content is preserved.

```bash
# Auto-detect AGENTS.md location
pnpm setup

# Or specify a custom path
pnpm setup -- --agents-path /path/to/your/AGENTS.md
```

This adds rules that teach your AI agent to:
- Recognize `#`-prefixed messages as task requests
- Register them on the kanban board via the API
- Select and spawn the appropriate CLI agent
- Monitor completion and report results

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8787` | API server port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for LAN) |
| `DB_PATH` | `./kanban.sqlite` | SQLite database path |
| `LOGS_DIR` | `./logs` | Agent terminal log directory |
| `OPENCLAW_CONFIG` | *(empty)* | Path to `openclaw.json` for gateway integration |

### Provider Settings

Configure role-based agent assignment via the Settings UI or API:

| Role | Default Provider | Description |
|---|---|---|
| DevOps | Claude Code | General orchestration and logic |
| Backend | Codex CLI | Backend-focused tasks |
| Frontend (New) | Gemini CLI | New UI/feature development |
| Frontend (Modify) | Claude Code | Code modifications |
| Frontend (Bugfix) | Claude Code | Bug fixes |

### OpenClaw Gateway Integration

To enable wake notifications when cards change status:

```bash
# Set the path to your openclaw.json
OPENCLAW_CONFIG=~/.openclaw/openclaw.json
```

When configured, the kanban server sends wake notifications to the OpenClaw gateway on:
- New Inbox card creation
- Card moving from Review/Test to Done

## API Reference

### Cards

```bash
# List all cards
GET /api/cards

# List cards by status
GET /api/cards?status=Inbox

# Search cards
GET /api/cards/search?q=keyword

# Create a card
POST /api/cards
# Body: { title, description?, status?, assignee?, priority?, role?, task_type? }

# Update a card
PATCH /api/cards/:id
# Body: { title?, description?, status?, assignee?, priority?, role?, task_type? }

# Delete a card
DELETE /api/cards/:id

# Purge all cards by status
POST /api/cards/purge?status=Inbox
```

### Agent Control

```bash
# Start agent on a card (spawns CLI process)
POST /api/cards/:id/run

# Stop a running agent
POST /api/cards/:id/stop

# Trigger review/test
POST /api/cards/:id/review

# View terminal output
GET /api/cards/:id/terminal?lines=200&pretty=1
```

### Webhook Ingestion

```bash
# Create Inbox card from external source
POST /api/inbox
# Body: { text, source?, message_id?, author?, chat? }
```

### Settings

```bash
# Get provider settings
GET /api/settings

# Update provider settings
PUT /api/settings
# Body: { roleProviders, stageProviders, autoAssign }
```

## Architecture

```
claw-kanban/
├── server/
│   └── index.ts          # Express API + SQLite + agent process management
├── src/
│   ├── App.tsx            # Main kanban board UI
│   ├── App.css            # Dark theme styles
│   ├── NewCardModal.tsx   # Card creation modal
│   ├── api.ts             # API client + types
│   ├── main.tsx           # React entry point
│   └── index.css          # Base styles
├── templates/
│   └── AGENTS-kanban.md   # Agent orchestration rules template
├── scripts/
│   └── setup.mjs          # AGENTS.md setup script (prepend, not overwrite)
├── package.json
├── vite.config.ts
└── .env.example
```

## How It Works

1. **Task arrives** (via UI, API, or webhook) → creates a card in Inbox
2. **Click "Start"** or agent auto-picks → spawns CLI process (Claude/Codex/Gemini)
3. **Card moves to "In Progress"** → real-time terminal logs available
4. **Agent completes** → card auto-moves to "Review/Test"
5. **Auto-review triggers** → Claude reviews the work
6. **Review passes** → card moves to "Done", wake notification sent
7. **Review fails** → stays in "Review/Test", user notified of issues

## Security Considerations

Claw-Kanban is designed as a **local development tool**. Keep these points in mind:

- **No Authentication**: The API server has no built-in auth. Bind to `127.0.0.1` (default) to restrict access to localhost only. Only use `0.0.0.0` on trusted networks.
- **CORS**: The server enables open CORS to allow the Vite dev server to communicate with the API. This is acceptable for local development but should not be exposed to the public internet.
- **Agent Permission Flags**: Spawned agents use permissive flags (`--dangerously-skip-permissions` for Claude, `--yolo` for Codex/Gemini) to enable autonomous operation. These flags disable confirmation prompts in the respective CLI tools.
- **Environment Inheritance**: Child processes inherit the server's environment variables. Ensure your environment does not contain sensitive variables you don't want exposed to spawned agents.
- **Process Management**: The server spawns and manages child processes. Stopped cards will attempt to terminate their associated processes.
- **Network Binding**: Use `HOST=127.0.0.1` (default) for local-only access. Use `HOST=0.0.0.0` only on trusted LANs behind a firewall or VPN (e.g., Tailscale).

## Platform Support

| Platform | Status | Notes |
|---|---|---|
| macOS | Fully supported | Primary development platform |
| Linux | Fully supported | Tested on Ubuntu/Debian |
| Windows | Supported | Requires AI CLI tools in PATH; uses `taskkill` for process management |

### Windows Notes

- AI CLI tools (`claude`, `codex`, `gemini`) must be installed and available in your system PATH
- Process management uses `taskkill /T /F` for tree-killing on Windows (vs SIGTERM on Unix)
- The `cross-env` package is used for cross-platform environment variable setting in dev scripts
- SQLite database paths use forward slashes or platform-native paths

## License

Apache License 2.0 - see [LICENSE](LICENSE) for details.
