# Local Assistant

바탕화면 오른쪽 하단에 상주하는 로컬 LLM 위젯. 별도 서버·빌드 없이 llama-server 같은 OpenAI 호환 `/v1` 엔드포인트에 붙어서 쓰는 Electron 앱이다.

## 특징

- **상주형 위젯** — 프레임 없는 투명 창이 화면 우하단에 고정되어, 버블과 패널을 뺀 나머지 영역은 뒤쪽 창으로 클릭이 그대로 통과된다.
- **세션 · 프로젝트 관리** — 대화가 세션별로 완전히 분리되고, 프로젝트 폴더로 묶어서 관리할 수 있다. 전부 로컬 SQLite에 저장.
- **워크스페이스 도구** — 폴더 하나를 지정하면 모델이 그 안에서 파일 읽기 · 이름 검색 · 내용 검색(grep)을 스스로 호출할 수 있다. 도구별로 항상 허용 / 승인 팝업을 고를 수 있음.
- **MCP 서버 연동** — Claude Desktop과 같은 형식의 `mcpServers` 설정으로 외부 MCP 서버를 붙이면, 그 도구들도 동일한 승인 체계 안에서 모델이 쓸 수 있다.
- **빌드 없는 구조** — 번들러·프레임워크 없이 평범한 파일들로만 구성. 코드를 읽는 데 별도 지식이 필요 없다.

## 요구 사항

- Windows (현재 빌드 타깃은 win/x64 NSIS 인스톨러 기준. `npm start`로 개발 실행은 다른 OS에서도 가능할 수 있으나 검증되지 않음)
- [Node.js](https://nodejs.org/) 18 이상
- OpenAI 호환 `/v1/chat/completions` 엔드포인트를 제공하는 로컬(또는 원격) LLM 서버 — 예: [llama.cpp](https://github.com/ggml-org/llama.cpp)의 `llama-server`

이 앱 자체는 LLM을 구동하지 않는다. 어딘가에서 `/v1` 엔드포인트를 이미 띄워두고, 그 주소를 앱 설정에 입력해서 쓰는 클라이언트다.

## 시작하기

```bash
git clone <이 저장소 URL>
cd local-assistant
npm install
npm start
```

트레이 아이콘으로 상주하며, `Ctrl+Shift+Space`로 위젯을 표시/숨김할 수 있다.

### Windows 설치 파일 빌드

```bash
npm run build     # dist/ 에 NSIS 인스톨러 생성
```

## 설정

앱 실행에 별도의 환경 변수는 필요 없다. 모든 설정은 위젯의 톱니바퀴 아이콘을 눌러 여는 **설정 창**에서 관리되고, 곧바로 로컬 DB에 저장된다.

- **일반**: BASE URL(기본값 `http://127.0.0.1:8080/v1`) / MODEL / MAX TOKENS
- **시스템 프롬프트**: 모든 세션 요청에 공통으로 붙는 프롬프트 (세션 히스토리엔 저장 안 됨)
- **워크스페이스 & 도구**: 모델이 파일을 다룰 폴더 지정, 도구별 사용 여부 · 항상 허용 토글
- **MCP 서버**: `{ "서버이름": { "command": "...", "args": [...] } }` 형태의 JSON을 입력하면 stdio로 연결해 도구를 가져온다 (전역 설정, 세션과 무관)

설정·세션·프로젝트는 전부 SQLite 파일 하나에 저장된다:

| OS | 경로 |
| --- | --- |
| Windows | `%APPDATA%/local-assistant/sessions.db` |
| macOS | `~/Library/Application Support/local-assistant/sessions.db` |
| Linux | `~/.config/local-assistant/sessions.db` |

### llama-server까지 한 번에 띄우기 (`start_all.ps1`)

llama-server와 이 앱을 매번 따로 켜는 게 번거로우면 `.env`를 채우고 스크립트 하나로 같이 띄울 수 있다.

```powershell
copy .env.example .env
# .env를 열어 LLAMA_CPP_DIR / MODEL_PATH를 본인 경로로 수정

./start_all.ps1
```

`-ngl`, `--threads`, `-c` 등 llama-server 성능 관련 인자는 `start_all.ps1` 안에 직접 적혀 있다 — GPU/CPU 사양에 맞춰 스크립트를 열어 조정하면 된다.

## 디렉터리 구조

```
local-assistant/
├─ main.js              # Electron 메인 프로세스: 창/트레이/클릭통과, IPC, 워크스페이스 도구, MCP 클라이언트
├─ preload.js            # contextBridge로 노출되는 유일한 렌더러↔메인 채널 (window.host)
├─ db.js                 # SQLite 기반 세션/설정/프로젝트 저장소
├─ renderer/
│  ├─ index.html, app.js       # 메인 위젯: 버블/패널 UI, 세션, 스트리밍, 도구 호출 루프
│  ├─ settings.html, settings.js  # 설정 창 (카테고리별 사이드바)
│  └─ sessions.html, sessions.js  # 세션 관리 창 (전체 목록 / 프로젝트별 그룹)
├─ .env.example          # start_all.ps1 전용 설정 템플릿
├─ start_all.ps1         # llama-server + 위젯 동시 실행 스크립트 (선택 사항)
└─ package.json
```

## 아키텍처 개요

- **창 모델**: `main.js`가 주 디스플레이 작업 영역 전체 크기의 투명 창을 하나 만들고 기본적으로 클릭 통과 상태로 둔다. `app.js`의 `hitTest()`가 마우스 위치를 보고 버블/패널 위에 있을 때만 클릭을 받도록 매번 전환한다.
- **IPC 표면**: `window.host`(`preload.js`)가 렌더러가 Node/OS에 접근하는 유일한 통로다 — 세션 CRUD, 도구 실행(`runTool`), 워크스페이스 폴더 선택, MCP 도구 목록/재연결, 설정·세션 창 열기 등.
- **도구 호출 루프**: `app.js`의 `send()`가 `MAX_TOOL_ROUNDS`만큼 완성 라운드를 반복한다. 모델이 `tool_calls`를 내면 `handleToolCalls()`가 (필요시 승인 팝업을 거쳐) 실행하고 결과를 다시 히스토리에 붙여 다음 라운드로 넘어간다.
- **워크스페이스 도구**: `main.js`의 `TOOL_IMPLS`가 실제 구현이고, 모든 경로 인자는 `resolveInWorkspace()`로 지정된 워크스페이스 루트 밖으로 못 나가게 검증한다(`../` 탈출·절대경로 차단).
- **MCP 서버**: 설정에 등록된 서버들을 `@modelcontextprotocol/sdk`로 stdio 연결하고, 각 도구를 `mcp__<서버>__<도구>` 이름으로 내장 도구 목록에 합친다. 설정 저장/앱 시작 시 전체 재연결.
- **세션 저장**: `db.js`가 SQLite(`better-sqlite3`)로 설정 · 세션 · 메시지 · 프로젝트를 관리한다. 창 하나에서 저장하면 다른 열린 창들도 `store:changed` IPC 브로드캐스트로 즉시 갱신된다.

더 자세한 내부 동작은 `CLAUDE.md`를 참고.

## 단축키

| 키 | 동작 |
| --- | --- |
| `Ctrl+Shift+Space` | 위젯 표시/숨김 |
| `Enter` | 전송 / 생성 중이면 중지 |
| `Shift+Enter` | 줄바꿈 |
| `Esc` | 생성 중지 |

## 알려진 제약

- 세션 히스토리 전체를 매 요청마다 다시 보낸다 — 요약/절삭 로직이 없어서 대화가 길어지면 컨텍스트 한도에 걸릴 수 있다.
- 응답은 자체 구현한 마크다운 렌더러로 표시된다(제목·목록·굵게/기울임/취소선·코드·인용·링크). 코드 블록 구문 강조는 아직 없다.
- `alwaysOnTop`이 `screen-saver` 레벨이라 전체화면 앱 위에도 뜬다. 게임 등과 충돌하면 `main.js`에서 `'floating'`으로 낮추면 된다.
- 원격 사용을 염두에 둔 앱이 아니다 — 워크스페이스 도구는 Electron 프로세스가 돌아가는 컴퓨터의 로컬 파일시스템만 다룬다.
