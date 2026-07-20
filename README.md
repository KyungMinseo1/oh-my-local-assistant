# Local Assistant

[![Platform](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white)](#requirements)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](#requirements)
[![Electron](https://img.shields.io/badge/electron-31.x-47848F?logo=electron&logoColor=white)](package.json)
[![No build step](https://img.shields.io/badge/build%20step-none-blue)](#directory-layout)
[![Stars](https://img.shields.io/github/stars/KyungMinseo1/oh-my-local-assistant?style=social)](https://github.com/KyungMinseo1/oh-my-local-assistant/stargazers)

[한국어](README.ko.md)

A little bubble that lives in the corner of your screen and talks to whatever OpenAI-compatible `/v1` server you point it at — `llama-server`, `ollama serve --openai`, vLLM, anything. No account, no cloud, no telemetry. It doesn't run the model itself; it's just the window you type into.

Most "AI desktop" tools either lock you into their own backend or ship a full Next.js app to render a chat bubble. This one is a few plain files and a SQLite database. If you already have a local model running somewhere, this is the thin client that sits on top of it and stays out of the way otherwise.

## What it does

The widget is invisible until you need it. The window covers your whole screen but is fully click-through except for two spots — the bubble, and the panel when it's open — so it never steals a click meant for something behind it.

Beyond that:

- Conversations live in separate sessions, and sessions can be grouped into projects (a folder-like concept, not a filesystem folder). Everything is kept in a local SQLite file, so closing the app doesn't lose anything.
- Point it at a folder and the model can read files in it, search filenames by glob, and grep contents — each capability toggled independently, each either auto-approved or gated behind a one-off confirmation, your call.
- Any MCP server you'd configure for Claude Desktop works here too — drop the same JSON in and its tools show up in the same approval flow as the built-in ones.

## Requirements

- Windows (the packaged build targets win/x64; `npm start` may work elsewhere but hasn't been tested there)
- Node.js 18+
- Something serving an OpenAI-compatible `/v1/chat/completions` endpoint — [llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server` is what this was built against

This repo is only the client half. Get a model server running first, then point the widget at it.

## Getting started

```bash
git clone https://github.com/KyungMinseo1/oh-my-local-assistant.git
cd oh-my-local-assistant
npm install
npm start
```

It parks itself in the system tray. `Ctrl+Shift+Space` toggles the widget on and off.

To produce a Windows installer instead of running from source:

```bash
npm run build     # → dist/*.exe (NSIS)
```

## Configuring it

There are no environment variables to set for the app itself — everything lives behind the gear icon:

| Category | What's there |
| --- | --- |
| General | Base URL (defaults to `http://127.0.0.1:8080/v1`), model name, max tokens |
| System prompt | Prepended to every request; not saved into session history |
| Workspace & tools | Which folder the model can touch, and per-tool enable / always-allow toggles |
| MCP servers | A JSON blob of `{ "name": { "command": ..., "args": [...] } }` — global, not per-session |

Everything you set gets written straight to a local database:

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%/local-assistant/sessions.db` |
| macOS | `~/Library/Application Support/local-assistant/sessions.db` |
| Linux | `~/.config/local-assistant/sessions.db` |

### Launching the model server alongside it

If you're tired of starting `llama-server` and the widget separately, `start_all.ps1` does both in one shot:

```powershell
copy .env.example .env
# edit .env — fill in LLAMA_CPP_DIR and MODEL_PATH

./start_all.ps1
```

The GPU/CPU tuning flags (`-ngl`, `--threads`, `-c`, cache types, ...) live directly in the script rather than in `.env` — they're specific to whatever hardware you're running on, so open the file and adjust them rather than expecting sane defaults.

## Directory layout

```
local-assistant/
├─ main.js              # Electron main process: window/tray/click-through, IPC, workspace tools, MCP client
├─ preload.js            # The one bridge the renderer has to Node — window.host
├─ db.js                 # SQLite-backed sessions/settings/projects
├─ renderer/
│  ├─ index.html, app.js       # the widget itself: bubble/panel, streaming, tool-call loop
│  ├─ settings.html, settings.js  # settings window
│  └─ sessions.html, sessions.js  # session manager window
├─ .env.example          # template for start_all.ps1's config
├─ start_all.ps1         # optional launcher for server + widget together
└─ package.json
```

## How it's built

A few things worth knowing before poking around the code:

**One transparent window, two clickable regions.** `main.js` sizes a single `BrowserWindow` to the whole work area and starts it fully click-through. `app.js`'s `hitTest()` runs on every mouse move and flips that on or off depending on whether the cursor is over the bubble or the open panel — everything else falls straight through to the desktop.

**`window.host` is the entire IPC surface.** `preload.js` exposes it once, unchanged across all three windows (widget, settings, session manager), since none of them need window-specific state from it. Session CRUD, tool execution, workspace picking, MCP reconnects — it all goes through there.

**Tool calls loop until the model stops asking for them.** `send()` in `app.js` drives a bounded number of completion rounds; when the model responds with `tool_calls`, `handleToolCalls()` runs each one (through a confirmation prompt unless it's marked always-allow) and feeds the results back in before looping again.

**Workspace tools can't leave the folder you picked.** Every path argument passed to `main.js`'s `TOOL_IMPLS` goes through `resolveInWorkspace()`, which rejects anything that would resolve outside the configured root — no `../`, no absolute paths pointing elsewhere.

**MCP servers connect over stdio via the official SDK**, and each tool they expose gets namespaced as `mcp__<server>__<tool>` and merged into the same tool list the built-ins live in. Saving settings (or starting the app) reconnects all of them from scratch rather than diffing what changed.

**SQLite, not a JSON blob.** `db.js` owns every read and write; whichever window changes something broadcasts `store:changed` over IPC so the others pick it up immediately instead of going stale until you switch focus.

Want more detail than that? `CLAUDE.md` in the repo root goes considerably deeper.

## Shortcuts

| Key | Does what |
| --- | --- |
| `Ctrl+Shift+Space` | Show / hide the widget |
| `Enter` | Send — or stop, if it's already generating |
| `Shift+Enter` | Newline |
| `Esc` | Stop generating |

## Rough edges

- Full session history gets resent on every request. There's no summarization or truncation, so a long-running session will eventually hit whatever context limit your server enforces.
- Markdown rendering is hand-rolled (headings, lists, bold/italic/strikethrough, code, blockquotes, links) — no syntax highlighting inside code fences yet.
- `alwaysOnTop` runs at the `screen-saver` level, so it floats above fullscreen apps too. If that fights with a game or another always-on-top tool, drop it to `'floating'` in `main.js`.
- This was never designed for remote use. Workspace tools only ever see the filesystem of whichever machine is actually running the Electron process.
