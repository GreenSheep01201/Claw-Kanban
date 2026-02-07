#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# claw-kanban one-click installer (macOS / Linux)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/GreenSheep01201/claw-kanban/main/install.sh | bash
#
# Environment variables:
#   CLAW_KANBAN_DIR  - Custom install path (default: auto-detect from openclaw workspace)
# ─────────────────────────────────────────────────────────────

REPO="https://github.com/GreenSheep01201/claw-kanban.git"
PORT="${CLAW_KANBAN_PORT:-8787}"
LAUNCHD_LABEL="ai.openclaw.kanban"
LAUNCHD_LEGACY_LABEL="com.openclaw.kanban"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[claw-kanban]${NC} $1"; }
ok()    { echo -e "${GREEN}[claw-kanban]${NC} $1"; }
warn()  { echo -e "${YELLOW}[claw-kanban]${NC} $1"; }
fail()  { echo -e "${RED}[claw-kanban]${NC} $1"; exit 1; }

# ─── Detect openclaw workspace path ─────────────────────────
# Resolution order:
#   1. CLAW_KANBAN_DIR env var (explicit override)
#   2. openclaw.json → agents.defaults.workspace
#   3. OPENCLAW_PROFILE env var → ~/.openclaw/workspace-{profile}
#   4. Default: ~/.openclaw/workspace

detect_workspace_dir() {
  local openclaw_json="$HOME/.openclaw/openclaw.json"

  # Try reading agents.defaults.workspace from openclaw.json
  if [ -f "$openclaw_json" ]; then
    # Use node for reliable JSON parsing (available since we require Node 22+)
    local configured
    configured=$(node -e "
      try {
        const c = JSON.parse(require('fs').readFileSync('$openclaw_json','utf8'));
        const w = c?.agents?.defaults?.workspace?.trim();
        if (w) process.stdout.write(w.replace(/^~/, process.env.HOME));
      } catch {}
    " 2>/dev/null) || true
    if [ -n "$configured" ] && [ -d "$configured" ]; then
      echo "$configured"
      return
    fi
  fi

  # Check OPENCLAW_PROFILE
  local profile="${OPENCLAW_PROFILE:-}"
  if [ -n "$profile" ] && [ "${profile,,}" != "default" ]; then
    local profdir="$HOME/.openclaw/workspace-${profile}"
    if [ -d "$profdir" ]; then
      echo "$profdir"
      return
    fi
  fi

  # Default
  echo "$HOME/.openclaw/workspace"
}

# Always detect the real openclaw workspace for AGENTS.md
WORKSPACE_DIR="$(detect_workspace_dir)"

if [ -n "${CLAW_KANBAN_DIR:-}" ]; then
  INSTALL_DIR="$CLAW_KANBAN_DIR"
else
  INSTALL_DIR="$WORKSPACE_DIR/kanban-dashboard"
fi

# ─── Prerequisites ──────────────────────────────────────────

info "Checking prerequisites..."

# Node.js
if ! command -v node &>/dev/null; then
  fail "Node.js is required but not found. Install Node 22+ from https://nodejs.org"
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 22 ]; then
  fail "Node.js 22+ is required (found: $(node -v 2>/dev/null || echo 'unknown')). Please upgrade."
fi
ok "Node.js $(node -v)"

# Git
if ! command -v git &>/dev/null; then
  fail "git is required but not found. Install git from https://git-scm.com"
fi
ok "git $(git --version | awk '{print $3}')"

# Package manager (prefer pnpm, fall back to npm)
PKG_MGR=""
if command -v pnpm &>/dev/null; then
  PKG_MGR="pnpm"
elif command -v npm &>/dev/null; then
  PKG_MGR="npm"
else
  fail "pnpm or npm is required but not found."
fi
ok "Package manager: $PKG_MGR"

# tsx (will use local node_modules/.bin/tsx as fallback)
if command -v tsx &>/dev/null; then
  ok "tsx $(tsx --version 2>/dev/null || echo 'available')"
else
  info "tsx not found globally (will use local devDependency after install)"
fi

info "Workspace: $WORKSPACE_DIR"
info "Install:   $INSTALL_DIR"

# ─── Clone / Update ─────────────────────────────────────────

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Existing installation found at $INSTALL_DIR"
  info "Pulling latest changes..."
  cd "$INSTALL_DIR"
  git pull --rebase origin main || warn "git pull failed, continuing with existing code"
else
  info "Cloning claw-kanban to $INSTALL_DIR..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# ─── Install dependencies ───────────────────────────────────

info "Installing dependencies..."
if [ "$PKG_MGR" = "pnpm" ]; then
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install
else
  npm install
fi
ok "Dependencies installed"

# ─── Build ───────────────────────────────────────────────────

info "Building production UI..."
$PKG_MGR run build
ok "Build complete"

# ─── Generate .env ───────────────────────────────────────────

ENV_FILE="$INSTALL_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  info "Generating .env..."

  cat > "$ENV_FILE" <<EOF
PORT=${PORT}
HOST=127.0.0.1
EOF

  # Auto-detect openclaw gateway config
  OPENCLAW_JSON="$HOME/.openclaw/openclaw.json"
  if [ -f "$OPENCLAW_JSON" ]; then
    echo "OPENCLAW_CONFIG=$OPENCLAW_JSON" >> "$ENV_FILE"
    ok "OpenClaw gateway integration: enabled"
  else
    echo "# OPENCLAW_CONFIG=$OPENCLAW_JSON" >> "$ENV_FILE"
    info "OpenClaw gateway integration: disabled (config not found)"
  fi

  ok ".env generated"
else
  ok "Existing .env preserved"
fi

# ─── Setup AGENTS.md ────────────────────────────────────────

info "Setting up AGENTS.md orchestration rules..."
# Pass the detected workspace AGENTS.md path explicitly
AGENTS_PATH="$WORKSPACE_DIR/AGENTS.md"
$PKG_MGR run setup -- --agents-path "$AGENTS_PATH"
ok "AGENTS.md configured ($AGENTS_PATH)"

# ─── Clean up legacy launchd services ────────────────────────

cleanup_legacy_launchd() {
  local label="$1"
  local plist="$HOME/Library/LaunchAgents/${label}.plist"

  if [ -f "$plist" ]; then
    info "Removing legacy service: $label"
    launchctl unload "$plist" 2>/dev/null || true
    rm -f "$plist"
    ok "Removed $label"
  fi
}

if [ "$(uname)" = "Darwin" ]; then
  cleanup_legacy_launchd "$LAUNCHD_LEGACY_LABEL"

  # Also clean up old ai.openclaw.kanban if it points to a different path
  OLD_PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
  if [ -f "$OLD_PLIST" ]; then
    OLD_DIR=$(grep -A1 'WorkingDirectory' "$OLD_PLIST" | tail -1 | sed 's/.*<string>//;s/<\/string>.*//' 2>/dev/null || true)
    if [ -n "$OLD_DIR" ] && [ "$OLD_DIR" != "$INSTALL_DIR" ]; then
      info "Updating service (was pointing to $OLD_DIR)"
      launchctl unload "$OLD_PLIST" 2>/dev/null || true
      rm -f "$OLD_PLIST"
    fi
  fi
fi

# ─── Register auto-start service ─────────────────────────────

# Resolve paths for the service
NODE_BIN="$(command -v node)"
NODE_BIN_DIR="$(dirname "$NODE_BIN")"

# Collect extra PATH entries for AI CLI tools (claude, codex, gemini)
EXTRA_PATHS=""
for tool in claude codex gemini; do
  tool_path="$(command -v "$tool" 2>/dev/null || true)"
  if [ -n "$tool_path" ]; then
    tool_dir="$(dirname "$tool_path")"
    case ":${EXTRA_PATHS}:" in
      *":${tool_dir}:"*) ;; # already added
      *) EXTRA_PATHS="${EXTRA_PATHS:+$EXTRA_PATHS:}$tool_dir" ;;
    esac
  fi
done
SERVICE_PATH="${NODE_BIN_DIR}${EXTRA_PATHS:+:$EXTRA_PATHS}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# Find the tsx module for --import (resolve actual package path, not shell wrapper)
resolve_tsx_register_path() {
  local tsx_pkg="$INSTALL_DIR/node_modules/tsx/dist/esm/index.mjs"
  if [ -f "$tsx_pkg" ]; then
    echo "$tsx_pkg"
    return
  fi
  # Older tsx versions
  local tsx_alt="$INSTALL_DIR/node_modules/tsx/esm/index.mjs"
  if [ -f "$tsx_alt" ]; then
    echo "$tsx_alt"
    return
  fi
  echo ""
}

TSX_REGISTER="$(resolve_tsx_register_path)"

register_launchd() {
  local plist_path="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  mkdir -p "$INSTALL_DIR/logs"

  if [ -n "$TSX_REGISTER" ]; then
    # Use node --import tsx for reliable launchd execution
    cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>--import</string>
        <string>${TSX_REGISTER}</string>
        <string>${INSTALL_DIR}/server/index.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${INSTALL_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${INSTALL_DIR}/logs/kanban.log</string>
    <key>StandardErrorPath</key>
    <string>${INSTALL_DIR}/logs/kanban.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${SERVICE_PATH}</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>
</dict>
</plist>
PLIST
  else
    warn "tsx register path not found, using shell wrapper"
    cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>-c</string>
        <string>cd ${INSTALL_DIR} &amp;&amp; ${NODE_BIN_DIR}/npx tsx server/index.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${INSTALL_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${INSTALL_DIR}/logs/kanban.log</string>
    <key>StandardErrorPath</key>
    <string>${INSTALL_DIR}/logs/kanban.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${SERVICE_PATH}</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>
</dict>
</plist>
PLIST
  fi

  # Stop any running PID-based instance first
  node scripts/kanban.mjs stop 2>/dev/null || true

  # Load the service
  launchctl unload "$plist_path" 2>/dev/null || true
  launchctl load "$plist_path"

  ok "macOS auto-start registered (launchd: $LAUNCHD_LABEL)"
  ok "Kanban will auto-start on login and restart on crash"
}

register_systemd() {
  local service_dir="$HOME/.config/systemd/user"
  local service_file="$service_dir/claw-kanban.service"
  mkdir -p "$service_dir"
  mkdir -p "$INSTALL_DIR/logs"

  local exec_start
  if [ -n "$TSX_REGISTER" ]; then
    exec_start="${NODE_BIN} --import ${TSX_REGISTER} ${INSTALL_DIR}/server/index.ts"
  else
    exec_start="${NODE_BIN_DIR}/npx tsx ${INSTALL_DIR}/server/index.ts"
  fi

  cat > "$service_file" <<UNIT
[Unit]
Description=claw-kanban AI Agent Orchestration Kanban Board
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=${exec_start}
Restart=always
RestartSec=5
StandardOutput=append:${INSTALL_DIR}/logs/kanban.log
StandardError=append:${INSTALL_DIR}/logs/kanban.err.log
Environment=PATH=${SERVICE_PATH}
Environment=HOME=${HOME}

[Install]
WantedBy=default.target
UNIT

  # Stop any running PID-based instance first
  node scripts/kanban.mjs stop 2>/dev/null || true

  systemctl --user daemon-reload
  systemctl --user enable claw-kanban.service
  systemctl --user restart claw-kanban.service

  ok "Linux auto-start registered (systemd user service: claw-kanban)"
  ok "Kanban will auto-start on login and restart on crash"
}

info "Registering auto-start service..."

if [ "$(uname)" = "Darwin" ]; then
  register_launchd
elif command -v systemctl &>/dev/null; then
  register_systemd
else
  # Fallback: use PID-based management
  warn "No launchd or systemd found. Using PID-file management (no auto-start on reboot)."
  node scripts/kanban.mjs stop 2>/dev/null || true
  node scripts/kanban.mjs start
fi

# ─── Verify server is running ────────────────────────────────

info "Waiting for server to start..."
HEALTHY=false
for i in $(seq 1 10); do
  sleep 1
  if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    HEALTHY=true
    break
  fi
done

# ─── Done ────────────────────────────────────────────────────

echo ""
if [ "$HEALTHY" = true ]; then
  echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}${BOLD}║         claw-kanban installed successfully!      ║${NC}"
  echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════╝${NC}"
else
  echo -e "${YELLOW}${BOLD}╔══════════════════════════════════════════════════╗${NC}"
  echo -e "${YELLOW}${BOLD}║  claw-kanban installed (server not yet healthy)  ║${NC}"
  echo -e "${YELLOW}${BOLD}╚══════════════════════════════════════════════════╝${NC}"
  echo -e "  Check logs: ${INSTALL_DIR}/logs/kanban.err.log"
fi
echo ""
echo -e "  ${BOLD}Dashboard:${NC}  http://127.0.0.1:${PORT}"
echo -e "  ${BOLD}API:${NC}        http://127.0.0.1:${PORT}/api/health"
echo -e "  ${BOLD}Workspace:${NC}  $WORKSPACE_DIR"
echo -e "  ${BOLD}Install:${NC}    $INSTALL_DIR"
echo ""
if [ "$(uname)" = "Darwin" ]; then
  echo -e "  ${BOLD}Auto-start:${NC} launchd ($LAUNCHD_LABEL)"
  echo -e "  ${BOLD}Service:${NC}"
  echo -e "    launchctl kickstart -k gui/$(id -u)/$LAUNCHD_LABEL  ${CYAN}# restart${NC}"
  echo -e "    launchctl bootout gui/$(id -u)/$LAUNCHD_LABEL       ${CYAN}# stop${NC}"
elif command -v systemctl &>/dev/null; then
  echo -e "  ${BOLD}Auto-start:${NC} systemd (claw-kanban.service)"
  echo -e "  ${BOLD}Service:${NC}"
  echo -e "    systemctl --user restart claw-kanban   ${CYAN}# restart${NC}"
  echo -e "    systemctl --user stop claw-kanban       ${CYAN}# stop${NC}"
  echo -e "    systemctl --user status claw-kanban     ${CYAN}# status${NC}"
fi
echo ""
echo -e "  ${BOLD}Quick test:${NC}"
echo -e "    curl -X POST http://127.0.0.1:${PORT}/api/inbox \\"
echo -e "      -H 'content-type: application/json' \\"
echo -e "      -d '{\"text\":\"# Test task from installer\"}'"
echo ""
echo -e "  ${BOLD}Usage:${NC} Open your chatbot and type ${CYAN}# Fix the login bug${NC}"
echo -e "  The task will appear on your kanban board automatically."
echo ""
