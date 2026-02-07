<p align="center">
  <img src="public/kanban-claw.svg" width="80" alt="Claw Kanban" />
</p>

<h1 align="center">Claw-Kanban</h1>

<p align="center">
  <strong>AI 에이전트 오케스트레이션 칸반 보드</strong><br>
  <b>Claude Code</b>, <b>Codex CLI</b>, <b>Gemini CLI</b>에 역할 기반 자동 배정과 실시간 모니터링으로 태스크를 라우팅합니다.
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

### 선택: AGENTS.md 설정

AI 에이전트가 채팅 메시지에서 칸반 태스크를 자동 등록하도록 하려면:

```bash
pnpm setup
# 워크스페이스 AGENTS.md에 오케스트레이션 규칙을 추가합니다
```

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

## 주요 기능

- **6단계 칸반 보드** — Inbox, Planned, In Progress, Review/Test, Done, Stopped
- **멀티 에이전트 오케스트레이션** — Claude Code, Codex CLI, Gemini CLI 프로세스를 생성하고 관리
- **역할 기반 자동 배정** — 역할(DevOps / Backend / Frontend)과 태스크 유형(New / Modify / Bugfix)에 따라 자동으로 에이전트 라우팅
- **AI 프로바이더 감지** — Settings에서 각 CLI 도구의 설치/인증 상태를 표시하고, 미인증 프로바이더는 드롭다운에서 비활성화
- **자동 리뷰** — 구현 완료 후 Claude가 자동으로 리뷰/테스트 수행
- **실시간 터미널 뷰어** — Claude / Codex / Gemini 출력을 파싱하는 Stream-JSON 로그 뷰어
- **웹훅 수집** — `POST /api/inbox`로 Telegram, Slack 등 외부 소스에서 카드 생성
- **OpenClaw 게이트웨이 연동** — 카드 상태 변경 시 웨이크 알림 (선택사항)
- **모던 다크 UI** — React 19, 반응형 디자인, 글래스모피즘
- **SQLite 저장소** — Node.js 내장 `node:sqlite`로 설정 없이 파일 기반 DB 사용
- **크로스 플랫폼** — macOS, Linux, Windows 지원

## 사전 요구 사항

- **Node.js 22+** (`node:sqlite` 사용을 위해 필수)
- **pnpm** (권장) 또는 npm
- 아래 AI CLI 도구 중 하나 이상 설치 및 인증 필요:

| 도구 | 설치 | 인증 |
|------|------|------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `npm i -g @anthropic-ai/claude-code` | `claude login` |
| [OpenAI Codex CLI](https://github.com/openai/codex) | `npm i -g @openai/codex` | `codex auth login` |
| [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm i -g @google/gemini-cli` | `gemini auth login` |

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
2. "Start" 클릭 또는 자동 배정       ──>  CLI 프로세스 생성 (Claude/Codex/Gemini)
3. 카드가 "In Progress"로 이동       ──>  실시간 터미널 로그 확인 가능
4. 에이전트 완료 (exit 0)            ──>  카드가 자동으로 "Review/Test"로 이동
5. 자동 리뷰 시작                    ──>  Claude가 작업 결과 검토
6. 리뷰 통과                        ──>  카드가 "Done"으로 이동 + 웨이크 알림
7. 리뷰 실패                        ──>  "Review/Test"에 유지, 문제점 보고
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
| AI 에이전트 | Claude Code CLI, Codex CLI, Gemini CLI |
| 프로세스 관리 | Node `child_process` (spawn + stdin 파이핑) |

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

## 플랫폼 지원

| 플랫폼 | 상태 | 비고 |
|--------|------|------|
| macOS | 완전 지원 | 주 개발 플랫폼. launchd 자동 시작. |
| Linux | 완전 지원 | systemd 사용자 서비스 자동 시작. |
| Windows | 지원 | PowerShell 설치 스크립트. `taskkill /T /F`로 프로세스 관리. |

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

## 라이선스

Apache License 2.0 — 자세한 내용은 [LICENSE](LICENSE)를 참조하세요.

Copyright 2025 GreenSheep01201
