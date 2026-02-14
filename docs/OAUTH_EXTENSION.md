# OAuth Extension (Optional) — v1

Claw-Kanban’s core behavior (CLI detection + running `claude` / `codex` / `gemini`) is unchanged.

This optional module adds **UI-based OAuth Connect** so users without local CLI login can connect accounts via the Settings screen.

> Security model (v1): tokens are stored **server-side in sqlite** and encrypted at rest using `OAUTH_ENCRYPTION_SECRET`.
> Tokens are **never stored in the browser**.

## What’s included

- Settings UI section: **OAuth Connect (optional)**
  - GitHub OAuth connect/disconnect
  - Google OAuth ("Antigravity") connect/disconnect (PKCE + offline refresh token)
  - Copilot PAT save/clear (manual alternative)
- Express endpoints:
  - `GET /api/oauth/connections`
  - `DELETE /api/oauth/:provider` (`github | google_antigravity | copilot_pat`)
  - `GET /api/oauth/github/start` → 302 to GitHub authorize
  - `GET /api/oauth/github/callback`
  - `GET /api/oauth/google-antigravity/start` → 302 to Google authorize (PKCE)
  - `GET /api/oauth/google-antigravity/callback`
  - `POST /api/oauth/copilot/pat`
- sqlite tables:
  - `oauth_states` (temporary state + PKCE verifier)
  - `oauth_credentials` (encrypted tokens)

## Environment variables

Add to `.env` (server reads `.env` without `dotenv`):

```bash
# REQUIRED for token encryption at rest
OAUTH_ENCRYPTION_SECRET="change-me-to-a-long-random-string"

# Optional if you need to override callback host
OAUTH_BASE_URL="http://127.0.0.1:8787"

# GitHub OAuth app (Settings → Developer settings → OAuth Apps)
OAUTH_GITHUB_CLIENT_ID="..."
OAUTH_GITHUB_CLIENT_SECRET="..."
# Callback URL:
#   http://127.0.0.1:8787/api/oauth/github/callback

# Google OAuth app (Google Cloud Console → OAuth consent screen)
OAUTH_GOOGLE_CLIENT_ID="..."
OAUTH_GOOGLE_CLIENT_SECRET="..."
# Authorized redirect URI:
#   http://127.0.0.1:8787/api/oauth/google-antigravity/callback
```

## Copilot note

This v1 stores either:
- a GitHub OAuth access token (from GitHub connect), or
- a manually pasted PAT ("Copilot PAT")

To actually call Copilot APIs, you still need a follow-up server feature:
- exchange GitHub token → Copilot bearer token via:
  - `GET https://api.github.com/copilot_internal/v2/token`
  - header `Authorization: Token <githubToken>`
- then call `https://api.githubcopilot.com` with the bearer token.

(See `opencode-ai/opencode` for reference.)
