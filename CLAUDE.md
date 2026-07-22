# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Electron widget that sits always-on-top in the corner of the desktop and talks to a local, OpenAI-compatible `/v1` chat endpoint (e.g. `llama-server`). No build step, no bundler, no framework — a small set of plain files, one job each.

## Commands

```bash
npm install
npm start          # electron .
npm run build       # electron-builder --win --x64 -> dist/ (NSIS installer)
```

There is no lint or test setup in this repo (no eslint config, no test runner in `package.json`). Verify changes by running `npm start` and exercising the widget manually — there is no automated way to confirm a change works.

## Architecture

| File | Role |
| --- | --- |
| `main.js` | Electron main process: window geometry, tray, click-through toggling, session-store I/O + cross-window change broadcast, workspace tool implementations, MCP client lifecycle, settings/session-manager utility windows |
| `preload.js` | Thin `contextBridge` API (`window.host`) — the only channel between renderer and main; `contextIsolation` stays on. Shared unchanged across all three windows (main widget, settings, sessions) since it holds no window-specific state |
| `renderer/index.html` + `renderer/app.js` | The main widget: bubble/panel UI, session state, chat streaming, tool-call loop, drag/resize, hit-testing |
| `renderer/settings.html` + `renderer/settings.js` | Settings window (categorized sidebar + save) |
| `renderer/sessions.html` + `renderer/sessions.js` | Session-manager window (전체 flat list / 프로젝트 grouped list) |

All UI strings and comments-facing-the-user are Korean; keep new user-facing strings consistent with that.

### Window model: one transparent window, two hit targets

`main.js` sizes the `BrowserWindow` to the *entire* primary display work area, frameless and transparent, and starts it fully click-through (`setIgnoreMouseEvents(true)`). Only two elements should ever intercept the mouse: the floating bubble, and the panel when open. `app.js`'s `hitTest()` runs on every `mousemove` and calls `window.host.setIgnoreMouse()` to flip click-through on/off depending on whether the cursor is over one of those elements — everything else falls through to whatever is behind the widget on the desktop. When touching bubble/panel positioning or adding new interactive UI, this hit-test list (`hitTest()` in `app.js`) must be kept in sync or the new UI will be unclickable.

Bubble drag and panel resize both temporarily force click-through off (`ignoring = false`) for the duration of the gesture; panel placement (`positionPanel()`) always anchors at the corner nearest the bubble and grows away from it, so resize math depends on which corner (`curOriginX`/`curOriginY`) is currently active.

### IPC surface (`preload.js` ↔ `main.js`)

`window.host` is the entire contract: `readStore`/`writeStore`/`storePath` (session persistence), `runTool` (workspace/MCP tool dispatch), `pickWorkspace` (native folder dialog), `listMcpTools`/`reloadMcpServers` (MCP server connections), `openSettings`/`openSessions` (opens the settings/session-manager utility windows), `onStoreChanged` (fires in every *other* window after a `writeStore` — see Session store below), `setIgnoreMouse`, `hide`/`quit`, `onResetBubble`, `onWindowBlur` (fires when a window loses OS focus — e.g. a click outside it, or another window stealing focus — so `app.js` can auto-collapse the panel). Any new capability a renderer needs from Node/OS APIs has to be added here and handled in `main.js` — every renderer has `nodeIntegration: false` and no other way to reach the filesystem. `preload.js` is loaded unchanged by all three windows (main widget, settings, sessions), since it holds no window-specific state.

### Session store

A single JSON file (`sessions.json` in Electron's `userData` dir) holds `{ sessions: [...], activeId, settings: {...}, projects: [...] }`. It's read once per window at startup and rewritten on every mutation (no debouncing — see comment in `main.js`). Each renderer owns its own in-memory `store` object and calls `save()`/`window.host.writeStore()` after any change; `main.js` only knows how to read/write the whole blob, it has no session-level logic.

Since settings and sessions can now be edited from a separate window than the main widget, `main.js`'s `store:write` handler broadcasts a `store:changed` event to every *other* open `BrowserWindow` after a successful write (`main.js`, next to the handler). Each renderer that cares (`app.js`, `sessions.js`) listens via `window.host.onStoreChanged()` and re-reads + re-renders — this is the only cross-window sync mechanism; there's no per-field diffing or targeted events.

Each session's `messages` array is the literal OpenAI chat-message history (`role`, `content`, and for assistant turns `tool_calls`; for tool results `tool_call_id`) — `apiMessages()` in `app.js` maps it almost 1:1 into the request body. Each session may also carry a `projectId` referencing an entry in `store.projects` (`[{id, name, created}]`); no `projectId` (or one pointing at a deleted project) means "미분류" (unclassified) in the session-manager window. Deleting a project clears `projectId` on its sessions rather than deleting them.

### Tool-calling loop

Tools are workspace-scoped, defined in two places that must stay in sync:
- `TOOL_DEFS` in `app.js` — the OpenAI function-calling schema shown to the model, plus per-tool UI (label, enabled/always-allow settings).
- `TOOL_IMPLS` in `main.js` — the actual implementation, run over IPC (`tool:run`), with every path argument resolved and bounds-checked against `workspaceRoot()` via `resolveInWorkspace()` (rejects `../` traversal and absolute paths outside the chosen workspace folder).

All of them are read-only except `write_file` and `run_command`, and that split drives the approval defaults: `TOOL_DEFAULTS` (mirrored in `app.js` and `settings.js`) overrides the usual `{enabled: true, alwaysAllow: true}` with `{false, false}` for `run_command` and `{true, false}` for `write_file`, so both always reach `confirmToolCall()`.

`write_file` exists specifically so the model never builds a file through `run_command`: `exec()` on Windows runs `cmd.exe`, where `echo ... > f` writes the OEM code page (CP949 on this app's target locale) and mangles every non-ASCII character, and cmd's 8191-char command line truncates anything long. `run_command`'s own description in `TOOL_DEFS` carries the rest of the cmd.exe environment facts (no bash syntax, no PowerShell here-strings through `-Command`, exit code 9009 = command not found, 30s timeout) — local models otherwise default to assuming bash and burn whole conversations on shell syntax errors.

One of those rules is enforced in code rather than left to the description: `run_command` rejects any command containing a newline. `cmd.exe /d /s /c` ends the command at the first newline, so a multi-line `python -c "…"` returns exit code 0 with empty stdout *and* empty stderr — a silent no-op that reports as success, which a model cannot diagnose and will retry indefinitely. Description rules can't cover a failure mode that produces no evidence, so the guard returns an error pointing at the `write_file` → script-file → run path instead.

`get_datetime` is the one exception to the IPC path: it needs no filesystem access, so `execTool()` in `app.js` answers it locally instead of going over IPC — don't assume every tool call crosses the IPC boundary.

`send()` in `app.js` drives a bounded loop (`MAX_TOOL_ROUNDS`) of `runCompletionRound()` → if the model emits `tool_calls`, `handleToolCalls()` executes each (subject to per-tool "always allow" vs. an inline approval prompt via `confirmToolCall()`) and appends `tool` role results, then loops back into another completion round. `stop()` (button, `Esc`, or denying a confirmation) aborts via `AbortController` at any point in this loop; partial assistant content is preserved rather than discarded (see `finalizeAbort`).

### MCP servers

User-configured MCP servers (Settings window → MCP 서버 category → `MCP SERVERS (JSON)`, a `{ name: {command, args, env} }` dict — same shape as Claude Desktop's config) are connected over stdio from `main.js` using `@modelcontextprotocol/sdk` (`Client` + `StdioClientTransport`). `main.js` owns the actual `Client` instances (`mcpClients: Map<server, {client, tools, error}>`) and a flat `mcpToolIndex` from qualified tool name → `{server, toolName}`; servers reconnect as a full disconnect-all/reconnect-all (`syncMcpServers()`) at app startup and on every settings save (`mcp:reload`, called from `settings.js`), not diffed.

Each discovered tool is exposed to the model as `mcp__<server>__<tool>`. `app.js` merges it into its `TOOL_DEFS`-shaped list as `mcpTools` (populated via `refreshMcpTools()`, which calls the `listMcpTools` IPC method — the main widget only *reads* the current tool list, it never triggers a reconnect itself; that happens in `settings.js` via `reloadMcpServers`). Everywhere the built-in tool list was iterated (`enabledToolSpecs()`, the tool-exists check in `handleToolCalls()` — now `findToolDef()`) iterates `[...TOOL_DEFS, ...mcpTools]` instead, so approval/execution routing needed no MCP-specific branching. The one asymmetry: MCP tools default to `{enabled: true, alwaysAllow: false}` (built-ins default `alwaysAllow: true`) since they're arbitrary local code the user configured, not the sandboxed read-only tools above. `settings.js` keeps its own small `BUILTIN_TOOLS` array (name+label only, no schema) to render the same enable/always-allow toggles for both tool sources — the request-time schema itself stays in `app.js`'s `TOOL_DEFS` since only the chat loop needs it.

On the execution path, `main.js`'s `tool:run` handler routes any `mcp__`-prefixed name to `runMcpTool()` (looked up via `mcpToolIndex`, never by re-splitting the string) instead of `TOOL_IMPLS`, and normalizes `callTool()`'s `{content, isError}` into the same `{ok, ...}` shape `TOOL_IMPLS` already returns, so `app.js`'s `formatResult()` needs no MCP-specific case.

### Settings & session-manager windows

Settings (categorized sidebar: 일반 / 시스템 프롬프트 / 워크스페이스 & 도구 / MCP 서버) and session management (전체 flat list / 프로젝트 grouped-by-folder) each live in their own frameless `BrowserWindow`, opened via `window.host.openSettings()`/`openSessions()` → `ipcMain.on('settings:open'|'sessions:open', ...)` in `main.js`. Both are singletons — reopening an already-open one just calls `.focus()` (see `openSettingsWindow()`/`openSessionsWindow()` next to `createUtilityWindow()` in `main.js`). They're real focusable/taskbar windows, unlike the always-on-top click-through main widget, but still frameless and dark-themed (`-webkit-app-region: drag` on their title bars) rather than native chrome, to match the rest of the app.

Each window reads the store independently on load and writes back through the same `store:write` IPC as the main widget — there's no separate settings/session API surface. In the settings window, one "저장" button in a fixed footer saves every category at once (matching the single-save behavior this had before it was split out of the main widget's inline panel); tool enable/always-allow checkboxes and the workspace picker still apply immediately, no save needed. In the session window, clicking a session row switches `store.activeId` and re-renders in place — it does not close the window, so you can keep reassigning/switching sessions. Project assignment is a `<select>` dropdown per session row (not drag-and-drop), guarded from the row's own click-to-select handler the same way the delete button is (`e.target.closest(...)`).

### Streaming

`runCompletionRound()` parses an SSE stream (`data: {...}` lines, `[DONE]` sentinel) by hand — no SDK. It accumulates `delta.content` into the visible bubble live, and separately accumulates `delta.tool_calls` by index (tool-call argument strings arrive fragmented across multiple chunks and must be concatenated, not replaced).

Every place that appends to `#messages` calls `autoScrollMessages()` rather than setting `scrollTop` directly, so a stream of deltas doesn't fight the user scrolling up mid-generation — it only auto-follows the bottom when they were already there (`isScrolledNearBottom()`). Pass `autoScrollMessages(true)` only for events that should always jump to the bottom regardless (switching sessions, sending your own message, a connection-error notice).

## Known constraints (from README)

- The full session history is resent on every request — no summarization/truncation, so long sessions will eventually hit the context limit.
- Responses render as Markdown (headers, lists, bold/italic/strikethrough, inline/fenced code, blockquotes, links) via a small hand-rolled renderer (`renderMarkdown()` in `app.js`) — no syntax highlighting inside code blocks yet. User and assistant text is HTML-escaped before any tag is generated, and links are restricted to `http(s)`/`mailto` schemes, since this content is set via `innerHTML`.
- `alwaysOnTop` uses the `screen-saver` level (shows above fullscreen apps); drop to `'floating'` in `main.js` if this conflicts with games or other always-on-top tools.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
