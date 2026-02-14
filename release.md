# Release Notes

## v1.0.2

### Direct HTTP API for Copilot & Antigravity (No CLI dependency)

Copilot and Antigravity agents now call provider APIs directly from the server, removing the `opencode` CLI dependency entirely. Users no longer need opencode installed to use these agents.

#### New Features

- **GitHub Copilot direct API** — OAuth token exchange → OpenAI-compatible chat completions streaming. No opencode CLI needed.
- **Google Antigravity direct API** — Uses `cloudcode-pa.googleapis.com` endpoint with automatic project discovery (`loadCodeAssist`). Handles token refresh transparently.
- **Dual execution model** — CLI agents (Claude Code, Codex, Gemini) spawn local CLI processes; HTTP agents (Copilot, Antigravity) call APIs directly from the server.

#### How it works

**CLI Agents (Claude Code, Codex CLI, Gemini CLI):**
- Spawn the actual CLI binary installed on your machine
- Inherit your existing CLI configuration — skills, agents, MCP servers, custom instructions, and all settings
- No additional setup: if `claude`, `codex`, or `gemini` works in your terminal, it works in Claw-Kanban
- Your personalized agent environment is used as-is

**HTTP Agents (Copilot, Antigravity):**
- Call provider APIs directly via server-side HTTP requests
- Authenticate through OAuth Connect in Settings
- No CLI installation required — just connect your GitHub or Google account
- Streaming responses with real-time terminal output

#### Technical Details

- **Copilot token flow**: GitHub OAuth → `GET api.github.com/copilot_internal/v2/token` → session token with proxy-ep baseUrl → OpenAI-compatible streaming
- **Antigravity token flow**: Google OAuth → token refresh → `POST cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse` with automatic GCP project discovery
- **Negative PID tracking**: HTTP agents use negative fake PIDs to distinguish from real CLI process PIDs in the activeProcesses map
- **Mock ChildProcess**: HTTP agents register a mock process with `kill()` → `AbortController.abort()` for uniform stop handling
- **Race condition prevention**: DB writes (card_runs INSERT, card status UPDATE) happen synchronously before async HTTP agent launch

#### Bug Fixes

- Fixed race condition where `handleRunComplete` could fire before DB rows were written
- Fixed Copilot token cache using stale credentials after re-authentication (added sourceHash validation)
- Fixed stop handler sending negative PIDs to `killPidTree` (now checks PID sign)
- Fixed SSE buffer losing final chunk when stream ends without trailing newline
- Fixed log stream not being properly awaited before review agent reads output

---

## v1.0.1

- **`project_path` first-class field** — Cards now have a dedicated `project_path` column
- **Run/review guard** — Server blocks `/run` and `/review` when `project_path` is unset
- **3-step fallback chain** — `card.project_path` > description `## Project Path` section > ask user
- **Windows process management fix** — `killPidTree` uses `taskkill` with timeout
- **UI improvements** — Project path input in card creation form and detail panel

## v1.0.0

- Initial release
