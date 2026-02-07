# ─────────────────────────────────────────────────────────────
# claw-kanban one-click installer (Windows PowerShell)
#
# Usage:
#   irm https://raw.githubusercontent.com/GreenSheep01201/claw-kanban/main/install.ps1 | iex
#
# Environment variables:
#   CLAW_KANBAN_DIR  - Custom install path
# ─────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

$Repo = "https://github.com/GreenSheep01201/claw-kanban.git"
$DefaultDir = Join-Path $env:USERPROFILE ".openclaw\workspace\kanban-dashboard"
$InstallDir = if ($env:CLAW_KANBAN_DIR) { $env:CLAW_KANBAN_DIR } else { $DefaultDir }
$Port = if ($env:CLAW_KANBAN_PORT) { $env:CLAW_KANBAN_PORT } else { "8787" }

function Write-Info  { param($Msg) Write-Host "[claw-kanban] $Msg" -ForegroundColor Cyan }
function Write-Ok    { param($Msg) Write-Host "[claw-kanban] $Msg" -ForegroundColor Green }
function Write-Warn  { param($Msg) Write-Host "[claw-kanban] $Msg" -ForegroundColor Yellow }
function Write-Fail  { param($Msg) Write-Host "[claw-kanban] $Msg" -ForegroundColor Red; exit 1 }

# ─── Prerequisites ──────────────────────────────────────────

Write-Info "Checking prerequisites..."

# Node.js
try {
    $nodeVersion = (node -v) -replace '^v', ''
    $major = [int]($nodeVersion.Split('.')[0])
    if ($major -lt 22) {
        Write-Fail "Node.js 22+ is required (found: v$nodeVersion). Please upgrade."
    }
    Write-Ok "Node.js v$nodeVersion"
} catch {
    Write-Fail "Node.js is required but not found. Install Node 22+ from https://nodejs.org"
}

# Git
try {
    $gitVersion = (git --version) -replace 'git version ', ''
    Write-Ok "git $gitVersion"
} catch {
    Write-Fail "git is required but not found. Install git from https://git-scm.com"
}

# Package manager
$PkgMgr = $null
try {
    pnpm --version | Out-Null
    $PkgMgr = "pnpm"
} catch {
    try {
        npm --version | Out-Null
        $PkgMgr = "npm"
    } catch {
        Write-Fail "pnpm or npm is required but not found."
    }
}
Write-Ok "Package manager: $PkgMgr"

# tsx
try {
    tsx --version | Out-Null
} catch {
    Write-Warn "tsx not found globally. Installing tsx..."
    if ($PkgMgr -eq "pnpm") {
        pnpm add -g tsx
    } else {
        npm install -g tsx
    }
    Write-Ok "tsx installed"
}

# ─── Clone / Update ─────────────────────────────────────────

if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Info "Existing installation found at $InstallDir"
    Write-Info "Pulling latest changes..."
    Push-Location $InstallDir
    try {
        git pull --rebase origin main
    } catch {
        Write-Warn "git pull failed, continuing with existing code"
    }
} else {
    Write-Info "Cloning claw-kanban to $InstallDir..."
    $parent = Split-Path -Parent $InstallDir
    if (-not (Test-Path $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    git clone $Repo $InstallDir
    Push-Location $InstallDir
}

try {

# ─── Install dependencies ───────────────────────────────────

Write-Info "Installing dependencies..."
if ($PkgMgr -eq "pnpm") {
    try {
        pnpm install --frozen-lockfile
    } catch {
        pnpm install
    }
} else {
    npm install
}
Write-Ok "Dependencies installed"

# ─── Build ───────────────────────────────────────────────────

Write-Info "Building production UI..."
& $PkgMgr run build
Write-Ok "Build complete"

# ─── Generate .env ───────────────────────────────────────────

$EnvFile = Join-Path $InstallDir ".env"
if (-not (Test-Path $EnvFile)) {
    Write-Info "Generating .env..."

    $envContent = @"
PORT=$Port
HOST=127.0.0.1
"@

    $openclawJson = Join-Path $env:USERPROFILE ".openclaw\openclaw.json"
    if (Test-Path $openclawJson) {
        $envContent += "`nOPENCLAW_CONFIG=$openclawJson"
        Write-Ok "OpenClaw gateway integration: enabled"
    } else {
        $envContent += "`n# OPENCLAW_CONFIG=$openclawJson"
        Write-Info "OpenClaw gateway integration: disabled (config not found)"
    }

    Set-Content -Path $EnvFile -Value $envContent -Encoding UTF8
    Write-Ok ".env generated"
} else {
    Write-Ok "Existing .env preserved"
}

# ─── Setup AGENTS.md ────────────────────────────────────────

Write-Info "Setting up AGENTS.md orchestration rules..."
& $PkgMgr run setup
Write-Ok "AGENTS.md configured"

# ─── Start server ────────────────────────────────────────────

Write-Info "Starting kanban server..."

try { node scripts/kanban.mjs stop 2>$null } catch {}
node scripts/kanban.mjs start

} finally {
    Pop-Location
}

Write-Host ""
Write-Host "=================================================" -ForegroundColor Green
Write-Host "    claw-kanban installed successfully!" -ForegroundColor Green
Write-Host "=================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Dashboard:  http://127.0.0.1:$Port" -ForegroundColor White
Write-Host "  API:        http://127.0.0.1:${Port}/api/health" -ForegroundColor White
Write-Host "  Install:    $InstallDir" -ForegroundColor White
Write-Host ""
Write-Host "  Management commands:" -ForegroundColor White
Write-Host "    cd $InstallDir"
Write-Host "    $PkgMgr run kanban status"
Write-Host "    $PkgMgr run kanban stop"
Write-Host "    $PkgMgr run kanban start"
Write-Host "    $PkgMgr run kanban restart"
Write-Host ""
Write-Host "  Usage: Open your chatbot and type '# Fix the login bug'" -ForegroundColor Cyan
Write-Host "  The task will appear on your kanban board automatically." -ForegroundColor Cyan
Write-Host ""
