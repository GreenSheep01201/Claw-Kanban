<p align="center">
  <img src="public/kanban-claw.svg" width="80" alt="Claw Kanban" />
</p>

<h1 align="center">Claw-Kanban</h1>

<p align="center">
  <strong>AI 에이전트 오케스트레이션 칸반 보드</strong><br>
  <b>Claude Code</b>, <b>Codex CLI</b>, <b>Gemini CLI</b>, <b>OpenCode</b>, <b>GitHub Copilot</b>, <b>Google Antigravity</b>에 역할 기반 자동 배정과 실시간 모니터링으로 태스크를 라우팅합니다.
</p>

<p align="center">
  <a href="#ai로-설치하기">AI로 설치하기</a> &middot;
  <a href="#주요-기능">주요 기능</a> &middot;
  <a href="#아키텍처">아키텍처</a> &middot;
  <a href="#api-레퍼런스">API</a> &middot;
  <a href="README.md">English</a>
</p>

---

## AI로 설치하기

> **AI 코딩 에이전트 (Claude Code, Codex, Gemini CLI, Cursor 등)에 아래 문구를 붙여넣기만 하세요:**
>
> ```
> Claw-Kanban을 설치해줘. 가이드는 여기 참고:
> https://github.com/GreenSheep01201/Claw-Kanban
> ```
>
> AI가 이 README를 읽고 모든 과정을 자동으로 처리합니다.

---

## AI 설치 가이드

> **이 섹션은 AI 코딩 에이전트를 위해 작성되었습니다.**
> AI 어시스턴트로서 사용자가 Claw-Kanban 설치를 요청했다면, 아래 단계를 정확히 따르세요. 각 단계마다 검증 명령어가 포함되어 있으니, 실행 후 성공을 확인한 뒤 다음 단계로 진행하세요.

### Step 0: 사전 요구 사항 확인

```bash
# 1. Node.js 버전 확인 (22 이상 필수)
node -v
# 기대값: v22.x.x 이상. 없거나 v22 미만이면 중단하고 사용자에게 안내:
#   "Node.js 22+가 필요합니다. https://nodejs.org/ 에서 설치하거나 nvm을 사용하세요: nvm install 22"

# 2. pnpm (권장) 또는 npm 확인
pnpm -v || npm -v
# pnpm이 없으면 설치:
#   npm install -g pnpm

# 3. AI CLI 도구가 하나 이상 있는지 확인
which claude || which codex || which gemini
# 하나도 없으면 사용자에게 설치 안내:
#   Claude Code: npm i -g @anthropic-ai/claude-code && claude login
#   Codex CLI:   npm i -g @openai/codex && codex auth login
#   Gemini CLI:  npm i -g @google/gemini-cli && gemini auth login
```

### Step 1: 클론 및 빌드

```bash
git clone https://github.com/GreenSheep01201/Claw-Kanban.git
cd Claw-Kanban
pnpm install    # 또는: npm install
pnpm build      # 또는: npm run build
```

**검증:** `ls dist/index.html` 파일이 존재해야 합니다.

### Step 2: 서버 시작

```bash
pnpm start
# 서버가 http://127.0.0.1:8787 에서 시작됩니다
```

**검증:** `curl -s http://127.0.0.1:8787/api/health` 가 `{"ok":true, ...}` 를 반환해야 합니다.

### Step 3: 대시보드 열기

사용자에게 안내:

```
Claw-Kanban이 설치 완료되어 실행 중입니다!
대시보드: http://127.0.0.1:8787
```

### Step 3.5: AGENTS.md 설정 (필수)

AI 에이전트 오케스트레이션에 **필수** 단계입니다. 이 설정이 없으면 AI 에이전트가 칸반 보드에 태스크를 등록하거나, 작업을 라우팅하거나, 카드를 관리할 수 없습니다.

```bash
pnpm setup
# 워크스페이스 AGENTS.md에 오케스트레이션 규칙을 추가합니다
```

**검증:** 워크스페이스 `AGENTS.md` 상단에 `<!-- BEGIN claw-kanban orchestration rules -->`가 포함되어 있어야 합니다.

### 선택: 개발 모드

핫 리로드로 개발하려면:

```bash
pnpm dev        # LAN 접근 가능 (0.0.0.0)
pnpm dev:local  # localhost만 (127.0.0.1)
# UI: http://127.0.0.1:5173  |  API: http://127.0.0.1:8787
```

### 문제 해결

| 증상 | 원인 | 해결 |
|------|------|------|
| `pnpm build`에서 "node:sqlite" 오류 | Node.js 22 미만 | Node.js 22+로 업그레이드: `nvm install 22 && nvm use 22` |
| 포트 8787 이미 사용 중 | 다른 프로세스가 포트 점유 | `lsof -i :8787`로 확인하거나, `PORT=9999 pnpm start`로 포트 변경 |
| `curl /api/health` 연결 거부 | 서버 미실행 | Claw-Kanban 디렉토리에서 `pnpm start` 실행 |
| Settings에 AI 프로바이더 없음 | CLI 도구 미설치 | 최소 하나 설치: `npm i -g @anthropic-ai/claude-code` |
| 프로바이더 "Not Authenticated" 표시 | CLI 도구 미로그인 | 인증 명령 실행: `claude login`, `codex auth login`, 또는 `gemini auth login` |

---

## 왜 만들었나?

AI 코딩 에이전트(Claude Code, Codex CLI, Gemini CLI, OpenCode, Copilot, Antigravity)를 여러 개 쓰면 터미널 창을 여러 개 열어놓고 번갈아가면서 써야 하고, 태스크마다 어떤 에이전트를 쓸지 수동으로 결정하고, 끝날 때까지 하염없이 기다려야 합니다. Claw-Kanban은 이 문제를 해결합니다:

- **역할별 에이전트 자동 배정** — 터미널 창 여러 개 열고 번갈아 쓸 필요 없음
- **에이전트 작업 실시간 확인** — 끝날 때까지 기다릴 필요 없이 지금 뭐 하고 있는지 바로 확인
- **폰으로 태스크 던지기** — Telegram에서 `# 버그 수정해줘` 보내면 에이전트가 알아서 처리
- **기존 CLI 환경 그대로 사용** — CLI 에이전트는 skills, MCP 서버, 커스텀 지시사항 등 기존 설정을 추가 구성 없이 그대로 가져옴

## 이중 실행 모델

Claw-Kanban은 **6개 AI 에이전트**를 두 가지 실행 방식으로 지원합니다:

### CLI 에이전트 — 내 환경, 내 규칙

| 에이전트 | 실행 방식 | 설정 |
|----------|-----------|------|
| **Claude Code** | CLI spawn | `npm i -g @anthropic-ai/claude-code && claude login` |
| **Codex CLI** | CLI spawn | `npm i -g @openai/codex && codex auth login` |
| **Gemini CLI** | CLI spawn | `npm i -g @google/gemini-cli && gemini auth login` |
| **OpenCode** | CLI spawn | `npm i -g opencode && opencode auth` |

CLI 에이전트는 로컬에 설치된 실제 CLI 바이너리를 실행합니다. 즉 **기존에 구성한 개인화된 환경이 자동으로 그대로 적용**됩니다:

- 직접 설정한 커스텀 skills와 agents
- MCP 서버 연결
- 프로젝트별 지시사항 (CLAUDE.md 등)
- 인증 및 API 키
- 모든 CLI 설정과 환경 변수

**추가 설정 불필요** — 터미널에서 `claude`, `codex`, `gemini`, `opencode`가 작동하면 Claw-Kanban에서도 그대로 작동합니다. 이것이 CLI 에이전트의 핵심 장점입니다: 기존 작업 환경을 그대로 사용합니다.

### HTTP 에이전트 — 설치 없이, OAuth만으로

| 에이전트 | 실행 방식 | 설정 |
|----------|-----------|------|
| **GitHub Copilot** | 직접 API 호출 | Settings > OAuth Connect > GitHub |
| **Google Antigravity** | 직접 API 호출 | Settings > OAuth Connect > Google |

HTTP 에이전트는 서버에서 프로바이더 API를 직접 호출합니다. CLI 설치 불필요 — Settings에서 GitHub 또는 Google 계정을 OAuth로 연결하면 됩니다. 토큰은 AES-256-GCM으로 암호화되어 서버에 저장됩니다.

## 주요 기능

- **6단계 칸반 보드** — Inbox, Planned, In Progress, Review/Test, Done, Stopped
- **멀티 에이전트 오케스트레이션** — 6개 AI 에이전트 관리: Claude Code, Codex CLI, Gemini CLI, OpenCode, GitHub Copilot, Google Antigravity
- **이중 실행 모델** — CLI 에이전트 (로컬 프로세스 생성, 기존 환경 상속) + HTTP 에이전트 (직접 API 호출, OAuth만 필요)
- **역할 기반 자동 배정** — 역할(DevOps / Backend / Frontend)과 태스크 유형(New / Modify / Bugfix)에 따라 자동으로 에이전트 라우팅
- **AI 프로바이더 감지** — Settings에서 각 CLI 도구의 설치/인증 상태를 표시하고, 미인증 프로바이더는 드롭다운에서 비활성화
- **OAuth Connect (선택)** — CLI 인증이 불가능한 환경이거나 Copilot/Antigravity 사용 시; 브라우저로 연결하고 서버에 암호화 저장
- **자동 리뷰** — 구현 완료 후 Claude가 자동으로 리뷰/테스트 수행
- **실시간 터미널 뷰어** — 에이전트가 뭘 하고 있는지 브라우저에서 실시간 확인, 더 이상 하염없이 기다릴 필요 없음
- **채팅으로 카드 생성** — Telegram, Slack 등에서 `# 태스크 설명` 형식으로 보내면 칸반 카드가 즉시 생성
- **OpenClaw 게이트웨이 연동** — 카드 상태 변경 시 웨이크 알림 (선택사항)
- **프로젝트 경로 안전장치** — 카드별 `project_path` 필드; 경로 미설정 시 에이전트 실행 차단
- **모던 다크 UI** — React 19, 반응형 디자인, 글래스모피즘
- **SQLite 저장소** — Node.js 내장 `node:sqlite`로 설정 없이 파일 기반 DB 사용
- **크로스 플랫폼** — macOS, Linux, Windows 지원

## 스크린샷

### 칸반 대시보드

<p align="center">
  <img src="sample_img/dashboard.png" width="800" alt="Claw-Kanban 대시보드" />
</p>

> 6단계 칸반 보드와 카드 상세 패널. 태스크 생성, AI 에이전트 배정, 실시간 진행 상황 모니터링.

### 프로바이더 설정

<p align="center">
  <img src="sample_img/provider_setting.png" width="600" alt="프로바이더 설정" />
</p>

> 설치된 AI CLI 도구(Claude Code, Codex CLI, Gemini CLI)를 자동 감지하고 역할 기반 프로바이더 매핑을 설정합니다.

### 실시간 터미널 뷰어

<p align="center">
  <img src="sample_img/claude_code_tm.png" width="800" alt="터미널 뷰어" />
</p>

> 에이전트가 지금 뭘 하고 있는지 실시간으로 확인. 일을 시키고 끝날 때까지 하염없이 기다릴 필요 없이, 터미널 출력을 직접 확인할 수 있습니다.

### Telegram 연동

<p align="center">
  <img src="sample_img/telegram.png" width="400" alt="Telegram 연동" />
</p>

> Telegram에서 `# 버그 수정해줘` 이렇게 보내면 칸반 카드가 자동 생성되고 에이전트가 알아서 실행. 출퇴근길에 폰으로 태스크 던지면 집에 도착할 때쯤 완료되어 있습니다.

## 사전 요구 사항

- **Node.js 22+** (`node:sqlite` 사용을 위해 필수)
- **pnpm** (권장) 또는 npm
- 아래 중 하나 이상의 AI 에이전트 필요:

**CLI 에이전트** — CLI 도구를 설치하고 인증합니다. 기존에 설정한 skills, agents, MCP 서버, 커스텀 지시사항이 자동으로 적용됩니다.

| 도구 | 설치 | 인증 |
|------|------|------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `npm i -g @anthropic-ai/claude-code` | `claude login` |
| [OpenAI Codex CLI](https://github.com/openai/codex) | `npm i -g @openai/codex` | `codex auth login` |
| [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm i -g @google/gemini-cli` | `gemini auth login` |
| [OpenCode](https://github.com/opencode-ai/opencode) | `npm i -g opencode` | `opencode auth` |

**HTTP 에이전트** — CLI 불필요. 서버 시작 후 Settings에서 OAuth 연결만 하면 됩니다.

| 도구 | 설정 |
|------|------|
| GitHub Copilot | Settings > OAuth Connect > GitHub |
| Google Antigravity | Settings > OAuth Connect > Google |

## 빠른 시작

### 원라인 설치

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/GreenSheep01201/Claw-Kanban/main/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/GreenSheep01201/Claw-Kanban/main/install.ps1 | iex
```

설치 스크립트가 repo 클론, 의존성 설치, UI 빌드, `.env` 및 `AGENTS.md` 설정, 자동 시작 서비스 등록(macOS: launchd, Linux: systemd)을 모두 수행합니다.

### 수동 설치

```bash
git clone https://github.com/GreenSheep01201/Claw-Kanban.git
cd Claw-Kanban
pnpm install
pnpm build
```

### 실행

```bash
# 프로덕션 (빌드된 UI 서빙)
pnpm start

# 개발 모드 (Vite HMR + API 핫리로드, LAN 접근 가능)
pnpm dev

# 개발 모드 (localhost만)
pnpm dev:local
```

| | URL |
|---|---|
| **UI** | http://127.0.0.1:5173 (개발) 또는 http://127.0.0.1:8787 (프로덕션) |
| **API** | http://127.0.0.1:8787 |

## 동작 방식

```
1. 태스크 도착 (UI / API / 웹훅)     ──>  Inbox에 카드 생성
2. "Start" 클릭 또는 자동 배정       ──>  에이전트 실행:
   • CLI (Claude/Codex/Gemini/OpenCode) ──>  CLI 프로세스 생성 (기존 환경 상속)
   • HTTP (Copilot/Antigravity)         ──>  직접 API 호출 (OAuth 토큰)
3. 카드가 "In Progress"로 이동       ──>  실시간 터미널 로그 확인 가능
4. 에이전트 완료 (exit 0)            ──>  카드가 자동으로 "Review/Test"로 이동
5. 자동 리뷰 시작                    ──>  Claude가 작업 결과 검토
6. 리뷰 통과                        ──>  카드가 "Done"으로 이동 + 웨이크 알림
7. 리뷰 실패                        ──>  "Review/Test"에 유지, 문제점 보고
```

### 프로젝트 경로

에이전트가 **어떤 프로젝트 디렉토리**에서 작업할지 알아야 합니다. 카드 설명에 `## Project Path` 또는 `## 프로젝트 경로` 섹션을 포함하세요:

```
로그인 버튼 스타일 수정

## 프로젝트 경로
/Users/me/projects/my-app
```

서버가 이 경로를 파싱해서 해당 디렉토리에서 AI 에이전트를 실행합니다 (`cwd`). 생략하면 Claw-Kanban 서버의 작업 디렉토리가 기본값으로 사용됩니다.

Telegram/웹훅 메시지에서도 동일하게 포함하면 됩니다:

```
# 로그인 버튼 스타일 수정

## 프로젝트 경로
/Users/me/projects/my-app
```

### 태스크 흐름도

```
               ┌─────────┐
  UI / API ──> │  Inbox   │
  웹훅    ──>  │          │
               └────┬────┘
                    │ Start (수동 또는 자동)
               ┌────▼────┐
               │ Planned  │  (선택적 스테이징)
               └────┬────┘
                    │
               ┌────▼─────────┐
               │ In Progress   │  <── CLI 에이전트 실행 중
               │ (터미널 로그)  │
               └────┬─────────┘
                    │ exit 0
               ┌────▼─────────┐
               │ Review/Test   │  <── Claude 자동 리뷰
               └──┬────────┬──┘
          통과    │        │  문제 발견
          ┌───────▼┐   ┌───▼────┐
          │  Done   │   │Stopped │
          └────────┘   └────────┘
```

## 설정

### 환경 변수

`.env.example`을 `.env`로 복사:

```bash
cp .env.example .env
```

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `8787` | API 서버 포트 |
| `HOST` | `127.0.0.1` | 바인드 주소 (LAN/Tailscale 접근 시 `0.0.0.0`) |
| `DB_PATH` | `./kanban.sqlite` | SQLite 데이터베이스 파일 경로 |
| `LOGS_DIR` | `./logs` | 에이전트 터미널 로그 디렉토리 |
| `OPENCLAW_CONFIG` | *(비어있음)* | 게이트웨이 웨이크 연동을 위한 `openclaw.json` 경로 |

### 프로바이더 설정 (UI)

UI에서 **Settings**를 열어 설정:

| 섹션 | 설명 |
|------|------|
| **AI Providers** | Claude, Codex, Gemini의 설치/인증 상태 표시. Re-check 버튼으로 즉시 재감지. |
| **Auto-assign** | 역할 기반 프로바이더 자동 배정 on/off |
| **Role-based Providers** | DevOps / Backend 역할에 기본 프로바이더 매핑 |
| **FrontEnd Providers** | New / Modify / Bugfix 태스크 유형에 프로바이더 매핑 |
| **Stage-based Providers** | In Progress, Review/Test 단계별 프로바이더 오버라이드 (선택사항) |

기본 매핑:

| 역할 | 태스크 유형 | 기본 프로바이더 |
|------|-----------|---------------|
| DevOps | — | Claude Code |
| Backend | — | Codex CLI |
| Frontend | New | Gemini CLI |
| Frontend | Modify | Claude Code |
| Frontend | Bugfix | Claude Code |

### AGENTS.md 연동

설정 스크립트가 워크스페이스의 `AGENTS.md`에 칸반 오케스트레이션 규칙을 추가합니다 (기존 내용은 유지):

```bash
pnpm setup                                     # 위치 자동 감지
pnpm setup -- --agents-path /path/to/AGENTS.md  # 경로 직접 지정
```

AI 에이전트가 `#`으로 시작하는 메시지를 태스크 요청으로 인식하고 칸반 보드에 등록하도록 학습시킵니다.

### OpenClaw 게이트웨이

`.env`에 `OPENCLAW_CONFIG`를 설정하여 웨이크 알림 활성화:

```bash
OPENCLAW_CONFIG=~/.openclaw/openclaw.json
```

웨이크 알림 발동 시점:
- 새 Inbox 카드 생성 시
- Review/Test에서 Done으로 카드 이동 시

## 아키텍처

```
Claw-Kanban/
├── server/
│   └── index.ts            # Express 5 API 서버
│                            #   - SQLite 저장소 (node:sqlite)
│                            #   - 에이전트 프로세스 생성/종료
│                            #   - CLI 감지 (GET /api/cli-status)
│                            #   - 게이트웨이 웨이크 연동
├── src/
│   ├── App.tsx              # 칸반 보드 + Settings 모달
│   ├── App.css              # 다크 테마 (CSS 변수)
│   ├── api.ts               # 프론트엔드 API 클라이언트 + TypeScript 타입
│   ├── main.tsx             # React 19 엔트리 포인트
│   └── index.css            # 기본/리셋 스타일
├── public/
│   └── kanban-claw.svg      # 앱 아이콘 (OpenClaw 랍스터 + 칸반 박스)
├── templates/
│   └── AGENTS-kanban.md     # AGENTS.md 오케스트레이션 규칙 템플릿
├── scripts/
│   ├── setup.mjs            # AGENTS.md 설정 (덮어쓰기 아닌 앞에 추가)
│   └── kanban.mjs           # 프로세스 관리 (start/stop/status)
├── install.sh               # 원라인 설치 스크립트 (macOS/Linux)
├── install.ps1              # 원라인 설치 스크립트 (Windows)
├── .env.example             # 환경 변수 템플릿
├── vite.config.ts           # Vite 설정 (개발용 API 프록시)
└── package.json
```

### 기술 스택

| 계층 | 기술 |
|------|------|
| 프론트엔드 | React 19 + TypeScript + Vite |
| 백엔드 | Express 5 + Node.js 22+ |
| 데이터베이스 | SQLite (`node:sqlite`, 무의존성) |
| CLI 에이전트 | Claude Code, Codex CLI, Gemini CLI, OpenCode (로컬 프로세스 spawn) |
| HTTP 에이전트 | GitHub Copilot, Google Antigravity (직접 API + OAuth) |
| 프로세스 관리 | Node `child_process` (CLI) + `fetch` 스트리밍 (HTTP) |

## API 레퍼런스

### 카드

| 메소드 | 엔드포인트 | 설명 |
|--------|-----------|------|
| `GET` | `/api/cards` | 전체 카드 목록 (선택: `?status=Inbox`) |
| `GET` | `/api/cards/search?q=키워드` | 모든 필드에서 카드 검색 |
| `POST` | `/api/cards` | 카드 생성 |
| `PATCH` | `/api/cards/:id` | 카드 필드 수정 |
| `DELETE` | `/api/cards/:id` | 카드 및 모든 관련 파일 삭제 |
| `POST` | `/api/cards/purge?status=Done` | 상태별 일괄 삭제 |

### 에이전트 제어

| 메소드 | 엔드포인트 | 설명 |
|--------|-----------|------|
| `POST` | `/api/cards/:id/run` | 에이전트 시작 (CLI 프로세스 생성) |
| `POST` | `/api/cards/:id/stop` | 실행 중인 에이전트 중지 (프로세스 트리 종료) |
| `POST` | `/api/cards/:id/review` | 수동으로 리뷰 시작 |
| `GET` | `/api/cards/:id/terminal` | 터미널 출력 스트리밍 (`?lines=200&pretty=1`) |
| `GET` | `/api/cards/:id/logs` | 카드 이벤트 로그 조회 |

### 설정 및 상태

| 메소드 | 엔드포인트 | 설명 |
|--------|-----------|------|
| `GET` | `/api/settings` | 프로바이더 설정 조회 |
| `PUT` | `/api/settings` | 프로바이더 설정 저장 |
| `GET` | `/api/cli-status` | CLI 설치/인증 상태 감지 (30초 캐시, `?refresh=1`로 우회) |

### 웹훅

```bash
POST /api/inbox
Content-Type: application/json

{ "text": "# 로그인 버그 수정", "source": "telegram", "author": "user123" }
```

### 헬스 체크

```bash
GET /api/health    # { ok, version, dbPath, gateway }
```

## CLI 감지

`/api/cli-status` 엔드포인트의 감지 방식:

| 항목 | 방법 |
|------|------|
| **설치 확인** | `which` (Unix) / `where` (Windows) + `--version` |
| **Claude 인증** | `~/.claude.json`에 `oauthAccount` 키 존재 여부 |
| **Codex 인증** | `~/.codex/auth.json`에 `OPENAI_API_KEY` 또는 `tokens` 키 존재; `OPENAI_API_KEY` 환경변수 폴백 |
| **Gemini 인증** | `~/.gemini/oauth_creds.json`에 `access_token` 키 존재; Windows에서는 `%APPDATA%\gcloud\application_default_credentials.json`도 확인 |

결과는 30초간 캐시됩니다. `?refresh=1`로 즉시 재확인 가능합니다.

## 보안

Claw-Kanban은 **로컬 개발 도구**입니다. 주의 사항:

- **인증 없음** — 기본값 `127.0.0.1`로 바인딩. 신뢰할 수 있는 네트워크(VPN/Tailscale)에서만 `0.0.0.0` 사용.
- **에이전트 권한 플래그** — `--dangerously-skip-permissions` (Claude), `--yolo` (Codex/Gemini)로 자율 실행.
- **환경 변수 상속** — 자식 프로세스가 서버의 환경 변수를 상속받음.
- **CORS** — Vite 개발 프록시를 위해 오픈 CORS 활성화. 공개 인터넷에 노출하지 마세요.
- **OAuth 토큰 저장** — OAuth 토큰은 **서버 측 SQLite에만 저장**되며 `OAUTH_ENCRYPTION_SECRET` 환경 변수를 사용해 AES-256-GCM으로 암호화됩니다. 브라우저에는 refresh token이 전달되지 않습니다.
- **내장 OAuth Client ID** — 소스 코드에 포함된 GitHub/Google OAuth client ID와 secret은 **공개 OAuth 앱 자격증명**이며 사용자 비밀이 아닙니다. [Google 문서](https://developers.google.com/identity/protocols/oauth2/native-app)에 따르면 설치형/데스크톱 앱의 client secret은 "secret으로 취급하지 않습니다." VS Code, Thunderbird, GitHub CLI 등 오픈소스 앱도 동일한 방식을 사용합니다. 이 자격증명은 앱 자체를 식별할 뿐 — 사용자 개인 토큰은 항상 별도로 암호화 저장됩니다.
- **소스 코드에 개인 자격증명 없음** — 사용자별 토큰(GitHub, Google OAuth)은 로컬 SQLite에 암호화 저장되며 소스 코드에 포함되지 않습니다. 암호화 키는 `OAUTH_ENCRYPTION_SECRET` 환경 변수에서 생성됩니다.
- **Copilot 토큰 캐싱** — 교환된 Copilot 세션 토큰은 메모리에만 캐시(디스크 미기록)되고 자동 만료됩니다. 재인증 시 캐시가 즉시 무효화됩니다.

## 플랫폼 지원

| 플랫폼 | 상태 | 비고 |
|--------|------|------|
| macOS | 테스트 완료 | 주 개발 플랫폼. 100% 동작 확인. launchd 자동 시작. |
| Linux | 완전 지원 | systemd 사용자 서비스 자동 시작. |
| Windows | 테스트 중 | PowerShell 설치 스크립트 제공. 곧 100% 호환 예정. |

## 서비스 관리

```bash
# 관리 스크립트 사용
node scripts/kanban.mjs status    # 서버 실행 상태 확인
node scripts/kanban.mjs start     # 백그라운드 시작
node scripts/kanban.mjs stop      # 서버 중지
node scripts/kanban.mjs restart   # 서버 재시작

# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/ai.openclaw.kanban   # 재시작
launchctl bootout gui/$(id -u)/ai.openclaw.kanban         # 중지

# Linux (systemd)
systemctl --user restart claw-kanban
systemctl --user stop claw-kanban
systemctl --user status claw-kanban
```

## 변경 이력

### v1.0.2

- **GitHub Copilot 직접 API** — OAuth 토큰 교환 + OpenAI 호환 chat completions 스트리밍, opencode CLI 불필요
- **Google Antigravity 직접 API** — `cloudcode-pa` 엔드포인트로 GCP 프로젝트 자동 탐색 (`loadCodeAssist`), 투명한 토큰 갱신
- **이중 실행 모델** — CLI 에이전트 (Claude/Codex/Gemini/OpenCode)는 로컬 프로세스로 기존 환경 상속; HTTP 에이전트 (Copilot/Antigravity)는 OAuth로 직접 API 호출
- **경합 조건 수정** — DB 쓰기를 비동기 HTTP 에이전트 시작 전에 동기적으로 실행
- **Copilot 토큰 캐시 수정** — 재인증 후 오래된 자격증명 사용 방지 (sourceHash 검증 추가)
- **SSE 스트림 수정** — 최종 버퍼 플러시, 로그 스트림 await 처리, 음수 PID 처리

### v1.0.1

- **`project_path` 전용 필드** — 카드에 전용 `project_path` 컬럼 추가
- **실행/리뷰 가드** — `project_path` 미설정 시 `/run`과 `/review` 차단
- **Windows 프로세스 관리 수정** — `killPidTree`에 `taskkill` + 타임아웃 적용
- **UI 개선** — 카드 생성 및 상세 패널에 프로젝트 경로 입력 추가

### v1.0.0

- 최초 릴리즈

## 라이선스

Apache License 2.0 — 자세한 내용은 [LICENSE](LICENSE)를 참조하세요.

Copyright 2025 GreenSheep01201
