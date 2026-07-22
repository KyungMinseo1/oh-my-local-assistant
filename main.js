const { app, BrowserWindow, Tray, Menu, ipcMain, screen, globalShortcut, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

// ---- Window geometry ------------------------------------------------------
// The window is a transparent, click-through canvas that covers the whole work
// area of the primary display. The bubble is free to be dragged anywhere inside
// it, and the panel opens toward whichever corner has room — all handled in the
// renderer, so the window itself just tracks the work area.
let win = null;
let tray = null;

// ---- Session storage ------------------------------------------------------
// Sessions persist to a SQLite DB (db.js) in the OS app-data directory, so
// they survive restarts. Every mutation is a targeted row read/write instead
// of rewriting one big blob — see db.js for the schema and the one-time
// migration from the old single-file sessions.json.
const db = require('./db.js');
const skills = require('./skills.js');
const { exec } = require('child_process');

// Every window keeps its own in-memory slice of the store; broadcast so the
// others pick up a change made from elsewhere (e.g. a session created in the
// sessions window should show up in the main widget's drawer immediately).
// `scope` lets a listener refetch only what it actually renders instead of
// reloading everything.
function broadcastChange(sender, scope) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.webContents !== sender) w.webContents.send('store:changed', scope);
  }
}

ipcMain.handle('settings:get', () => db.getSettings());
ipcMain.handle('settings:update', (e, partial) => {
  const next = db.updateSettings(partial || {});
  broadcastChange(e.sender, { scope: 'settings' });
  return next;
});

ipcMain.handle('session:list', () => db.listSessions());
ipcMain.handle('session:get', (_e, id) => db.getSession(id));
ipcMain.handle('session:create', (e) => {
  const session = db.createSession();
  broadcastChange(e.sender, { scope: 'session', id: session.id });
  return session;
});
ipcMain.handle('session:delete', (e, id) => {
  const result = db.deleteSession(id);
  broadcastChange(e.sender, { scope: 'session', id });
  return result;
});
ipcMain.handle('session:rename', (e, id, title) => {
  db.renameSession(id, title);
  broadcastChange(e.sender, { scope: 'session', id });
});
ipcMain.handle('session:setProject', (e, id, projectId) => {
  db.setSessionProject(id, projectId);
  broadcastChange(e.sender, { scope: 'session', id });
});
ipcMain.handle('session:setPreset', (e, id, presetId) => {
  db.setSessionPreset(id, presetId);
  broadcastChange(e.sender, { scope: 'session', id });
});
ipcMain.handle('session:appendMessage', (e, id, message) => {
  const result = db.appendMessage(id, message);
  broadcastChange(e.sender, { scope: 'session', id });
  return result;
});
ipcMain.handle('session:deleteLastMessage', (e, id) => {
  db.deleteLastMessage(id);
  broadcastChange(e.sender, { scope: 'session', id });
});
ipcMain.handle('session:setActive', (e, id) => {
  db.setActiveSession(id);
  broadcastChange(e.sender, { scope: 'settings' });
});

ipcMain.handle('project:list', () => db.listProjects());
ipcMain.handle('project:create', (e, name) => {
  const project = db.createProject(name);
  broadcastChange(e.sender, { scope: 'project' });
  return project;
});
ipcMain.handle('project:delete', (e, id) => {
  db.deleteProject(id);
  broadcastChange(e.sender, { scope: 'project' });
});

ipcMain.handle('preset:list', () => db.listPresets());
ipcMain.handle('preset:create', (e, name, prompt) => {
  const preset = db.createPreset(name, prompt);
  broadcastChange(e.sender, { scope: 'preset' });
  return preset;
});
ipcMain.handle('preset:update', (e, id, partial) => {
  db.updatePreset(id, partial || {});
  broadcastChange(e.sender, { scope: 'preset' });
});
ipcMain.handle('preset:delete', (e, id) => {
  db.deletePreset(id);
  broadcastChange(e.sender, { scope: 'preset' });
});

ipcMain.handle('skill:list', () => skills.listSkills());
ipcMain.handle('skill:get', (_e, id) => skills.getSkill(id));
ipcMain.handle('skill:create', (e, name, description, body) => {
  const skill = skills.createSkill(name, description, body);
  broadcastChange(e.sender, { scope: 'skill' });
  return skill;
});
ipcMain.handle('skill:update', (e, id, partial) => {
  skills.updateSkill(id, partial || {});
  broadcastChange(e.sender, { scope: 'skill' });
});
ipcMain.handle('skill:delete', (e, id) => {
  skills.deleteSkill(id);
  broadcastChange(e.sender, { scope: 'skill' });
});
ipcMain.handle('skill:getFile', (_e, id, relPath) => {
  try { return { ok: true, content: skills.getSkillFile(id, relPath) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('db:path', () => db.dbPath());

// ---- Workspace-scoped tools -------------------------------------------------
// A small, read-only tool surface the local model can call (OpenAI-style
// function calling). Every path argument is resolved against the configured
// workspace root and rejected if it would escape that folder — this is a
// background, always-on-top widget, so tools deliberately can't touch
// anything outside the folder the user picked in Settings.
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', '.venv', '__pycache__']);
const MAX_READ_CHARS = 100_000;
const MAX_SCAN_ENTRIES = 20_000;
const MAX_RESULTS = 200;

function workspaceRoot() {
  const ws = db.getSettings().workspace;
  return ws && fs.existsSync(ws) ? ws : null;
}

// Resolves a workspace-relative path and guarantees the result stays inside
// the workspace root; throws otherwise (covers "../" traversal and absolute
// paths pointing elsewhere).
function resolveInWorkspace(root, relPath) {
  const resolved = path.resolve(root, relPath || '.');
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error('경로가 워크스페이스를 벗어납니다: ' + relPath);
  }
  return resolved;
}

function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^$()[]{}|\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$', 'i');
}

// Depth-first file walk, skipping common heavy/irrelevant directories and
// hidden folders, bounded by MAX_SCAN_ENTRIES so a huge tree can't hang the
// main process.
function walk(dir, budget, onFile) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (budget.count++ >= MAX_SCAN_ENTRIES) return;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(path.join(dir, entry.name), budget, onFile);
    } else if (entry.isFile()) {
      onFile(path.join(dir, entry.name));
    }
    if (budget.count >= MAX_SCAN_ENTRIES) return;
  }
}

// run_command's stdout/stderr: on Windows, cmd.exe and many console programs
// write non-ASCII text in the OS's OEM/ANSI code page (e.g. CP949 on Korean
// Windows), not UTF-8 — decoding that as UTF-8 (Node's default) silently
// replaces every malformed multi-byte sequence with U+FFFD, which is exactly
// the "mojibake" a model would otherwise see instead of the real message.
// A genuine UTF-8 stream (increasingly the default even on Windows for
// modern external tools — git, node, python, npm, ...) never produces U+FFFD
// on its own, so its presence is a reliable signal to redecode the raw bytes
// as Korean (this app's target locale) instead. 'euc-kr' is the WHATWG label
// Node's built-in TextDecoder maps to the windows-949 codec (a superset of
// true EUC-KR) — no extra dependency needed.
function decodeCommandOutput(buf) {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  try { return new TextDecoder('euc-kr').decode(buf); } catch { return utf8; }
}

const TOOL_IMPLS = {
  get_datetime() {
    const now = new Date();
    return { ok: true, iso: now.toISOString(), local: now.toString() };
  },

  read_file(args) {
    const root = workspaceRoot();
    if (!root) return { ok: false, error: '워크스페이스 폴더가 설정되지 않았습니다.' };
    const rel = String(args?.path || '');
    if (!rel) return { ok: false, error: 'path가 필요합니다.' };
    let full;
    try { full = resolveInWorkspace(root, rel); } catch (e) { return { ok: false, error: e.message }; }
    let stat;
    try { stat = fs.statSync(full); } catch { return { ok: false, error: '파일을 찾을 수 없습니다: ' + rel }; }
    if (!stat.isFile()) return { ok: false, error: '파일이 아닙니다: ' + rel };
    let text;
    try { text = fs.readFileSync(full, 'utf-8'); } catch (e) { return { ok: false, error: '읽기 실패: ' + e.message }; }
    let truncated = false;
    if (text.length > MAX_READ_CHARS) { text = text.slice(0, MAX_READ_CHARS); truncated = true; }
    return { ok: true, path: rel, content: text, truncated };
  },

  file_glob_search(args) {
    const root = workspaceRoot();
    if (!root) return { ok: false, error: '워크스페이스 폴더가 설정되지 않았습니다.' };
    const pattern = String(args?.pattern || '').trim();
    if (!pattern) return { ok: false, error: 'pattern이 필요합니다.' };
    let start;
    try { start = resolveInWorkspace(root, args?.path || '.'); } catch (e) { return { ok: false, error: e.message }; }
    const re = globToRegExp(pattern);
    const results = [];
    const budget = { count: 0 };
    walk(start, budget, (full) => {
      if (results.length >= MAX_RESULTS) return;
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (re.test(rel) || re.test(path.basename(full))) results.push(rel);
    });
    return { ok: true, count: results.length, truncated: budget.count >= MAX_SCAN_ENTRIES, files: results };
  },

  grep_search(args) {
    const root = workspaceRoot();
    if (!root) return { ok: false, error: '워크스페이스 폴더가 설정되지 않았습니다.' };
    const pattern = String(args?.pattern || '');
    if (!pattern) return { ok: false, error: 'pattern이 필요합니다.' };
    let start;
    try { start = resolveInWorkspace(root, args?.path || '.'); } catch (e) { return { ok: false, error: e.message }; }
    let re;
    try { re = new RegExp(pattern, args?.ignore_case ? 'i' : ''); } catch (e) { return { ok: false, error: '잘못된 정규식: ' + e.message }; }
    const matches = [];
    const budget = { count: 0 };
    walk(start, budget, (full) => {
      if (matches.length >= MAX_RESULTS) return;
      let stat;
      try { stat = fs.statSync(full); } catch { return; }
      if (stat.size > 1_000_000) return;   // skip large files
      let content;
      try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }
      if (content.indexOf(String.fromCharCode(0)) !== -1) return;   // skip binary (NUL byte)
      const rel = path.relative(root, full).split(path.sep).join('/');
      const lines = content.split('\n');
      let perFile = 0;
      for (let i = 0; i < lines.length && matches.length < MAX_RESULTS && perFile < 20; i++) {
        if (re.test(lines[i])) {
          matches.push({ file: rel, line: i + 1, text: lines[i].slice(0, 300) });
          perFile++;
        }
      }
    });
    return { ok: true, count: matches.length, truncated: budget.count >= MAX_SCAN_ENTRIES, matches };
  },

  // Arbitrary shell execution — unlike every other tool here, this is not
  // sandboxed beyond running with cwd pinned inside the workspace; it can do
  // anything the user's own shell can. That's why it defaults to disabled
  // and non-always-allow in settings (see app.js/settings.js), so every call
  // always goes through the existing confirmToolCall() approval prompt
  // unless the user explicitly opts in.
  run_command(args) {
    const root = workspaceRoot();
    if (!root) return { ok: false, error: '워크스페이스 폴더가 설정되지 않았습니다.' };
    const command = String(args?.command || '').trim();
    if (!command) return { ok: false, error: 'command가 필요합니다.' };
    let cwd;
    try { cwd = resolveInWorkspace(root, args?.cwd || '.'); } catch (e) { return { ok: false, error: e.message }; }

    return new Promise((resolve) => {
      exec(command, { cwd, timeout: 30_000, maxBuffer: 10_000_000, windowsHide: true, encoding: 'buffer' }, (error, stdoutBuf, stderrBuf) => {
        const stdout = decodeCommandOutput(stdoutBuf);
        const stderr = decodeCommandOutput(stderrBuf);
        const truncate = (s) => (s.length <= MAX_READ_CHARS ? { text: s, truncated: false } : { text: s.slice(0, MAX_READ_CHARS), truncated: true });
        const out = truncate(stdout);
        const err = truncate(stderr);
        // A non-zero exit code still comes through as `error` from exec(), but
        // that's a normal command result the model should see (stdout/stderr/
        // exitCode), not a tool failure — only a spawn/timeout failure (no
        // numeric exit code at all) is reported as ok:false.
        if (error && typeof error.code !== 'number') {
          return resolve({
            ok: false,
            error: error.killed ? '명령이 시간 초과로 종료되었습니다 (30초).' : String(error.message || error),
            stdout: out.text,
            stderr: err.text,
            truncated: out.truncated || err.truncated
          });
        }
        resolve({
          ok: true,
          exitCode: error ? error.code : 0,
          stdout: out.text,
          stderr: err.text,
          truncated: out.truncated || err.truncated
        });
      });
    });
  }
};

// ---- MCP servers ------------------------------------------------------------
// User-configured external tool servers (the `mcpServers` dict from Settings),
// connected over stdio via the official SDK. Each server's tools are exposed
// to the model namespaced as `mcp__<server>__<tool>`, alongside the built-in
// TOOL_IMPLS above — this is genuinely arbitrary local code the user chose to
// run (their own command/args), unlike the sandboxed, read-only tools above.
const MCP_PREFIX = 'mcp__';
const mcpClients = new Map();    // server name -> { client, tools, error }
const mcpToolIndex = new Map();  // qualified name -> { server, toolName }
const mcpConnecting = new Set(); // server names whose connect attempt hasn't settled yet
const mcpConfigs = new Map();    // server name -> JSON.stringify(cfg) it's currently connected/attempted with

async function connectMcpServer(name, cfg) {
  try {
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args || [],
      env: { ...process.env, ...(cfg.env || {}) },
      cwd: cfg.cwd
    });
    const client = new Client({ name: 'local-assistant', version: '0.1.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    mcpClients.set(name, { client, tools, error: null });
    for (const t of tools) {
      mcpToolIndex.set(MCP_PREFIX + name + '__' + t.name, { server: name, toolName: t.name });
    }
  } catch (e) {
    mcpClients.set(name, { client: null, tools: [], error: String(e?.message || e) });
  }
}

async function disconnectMcpServer(name) {
  const entry = mcpClients.get(name);
  if (entry?.client) {
    try { await entry.client.close(); } catch { /* already gone */ }
  }
  for (const key of mcpToolIndex.keys()) {
    if (mcpToolIndex.get(key).server === name) mcpToolIndex.delete(key);
  }
  mcpClients.delete(name);
}

function listMcpToolsForRenderer() {
  const out = [];
  for (const [server, entry] of mcpClients) {
    if (entry.error) { out.push({ server, error: entry.error }); continue; }
    for (const t of entry.tools) {
      out.push({
        server,
        name: MCP_PREFIX + server + '__' + t.name,
        toolName: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object', properties: {} }
      });
    }
  }
  return out;
}

// Pushed to every window (not just "the others" — unlike broadcastChange,
// the window that triggered a reload needs these live updates too, since its
// own mcp:reload call doesn't resolve until every server has settled) so the
// settings window can show "연결 중..." for servers still connecting instead
// of just omitting them until the whole batch finishes.
function broadcastMcpStatus() {
  const payload = { connecting: [...mcpConnecting], tools: listMcpToolsForRenderer() };
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('mcp:statusChanged', payload);
}

// Diffed against the currently connected set rather than a full disconnect-
// all/reconnect-all: settings are saved as one blob (see settings.js), so a
// save with no MCP changes would otherwise restart every server — dropping
// live stdio processes and tool state — just because the user tweaked an
// unrelated field. A server is only (re)connected if it's new, its config
// changed, or it isn't currently healthy (never connected / previously
// errored); a server removed from the config is disconnected. Each server's
// result is still broadcast as soon as it settles rather than waiting for
// the whole batch, so a slow server (e.g. a first-run `npx` package fetch)
// doesn't leave every other already-connected server looking like it never
// showed up.
async function syncMcpServers(mcpServers) {
  const entries = Object.entries(mcpServers || {});
  const nextNames = new Set(entries.map(([name]) => name));

  await Promise.all([...mcpClients.keys()].filter(name => !nextNames.has(name)).map(name => {
    mcpConfigs.delete(name);
    return disconnectMcpServer(name);
  }));

  const toConnect = entries.filter(([name, cfg]) => {
    const existing = mcpClients.get(name);
    const unhealthy = !existing || !existing.client;
    return unhealthy || mcpConfigs.get(name) !== JSON.stringify(cfg);
  });

  toConnect.forEach(([name]) => mcpConnecting.add(name));
  broadcastMcpStatus();
  await Promise.all(toConnect.map(async ([name, cfg]) => {
    await disconnectMcpServer(name);   // drop a stale connection for this name before reconnecting
    await connectMcpServer(name, cfg);
    mcpConfigs.set(name, JSON.stringify(cfg));
    mcpConnecting.delete(name);
    broadcastMcpStatus();
  }));
}

// Normalizes callTool()'s {content, isError} into the same {ok, ...} shape
// TOOL_IMPLS already returns, so the renderer's formatResult() needs no
// MCP-specific handling.
async function runMcpTool(qualifiedName, args) {
  const entry = mcpToolIndex.get(qualifiedName);
  if (!entry) return { ok: false, error: '알 수 없는 MCP 도구: ' + qualifiedName };
  const server = mcpClients.get(entry.server);
  if (!server?.client) return { ok: false, error: 'MCP 서버가 연결되어 있지 않습니다: ' + entry.server };
  try {
    const res = await server.client.callTool({ name: entry.toolName, arguments: args || {} });
    const text = (res.content || []).map(c => c.text ?? JSON.stringify(c)).join('\n');
    return { ok: !res.isError, content: text };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

ipcMain.handle('mcp:listTools', () => listMcpToolsForRenderer());
ipcMain.handle('mcp:reload', async (_e, mcpServers) => {
  await syncMcpServers(mcpServers);
  return listMcpToolsForRenderer();
});

ipcMain.handle('tool:run', async (_e, { name, args } = {}) => {
  if (name && name.startsWith(MCP_PREFIX)) return runMcpTool(name, args || {});
  const impl = TOOL_IMPLS[name];
  if (!impl) return { ok: false, error: '알 수 없는 도구: ' + name };
  try { return impl(args || {}); } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});

ipcMain.handle('dialog:pickWorkspace', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

// ---- Click-through --------------------------------------------------------
// The window is bigger than its visible content. Without this, the transparent
// area would swallow clicks meant for whatever is underneath. The renderer
// reports whether the cursor is over real UI, and we flip the flag.
ipcMain.on('window:setIgnoreMouse', (_e, ignore) => {
  if (!win || utilityWindowsOpen > 0) return;
  win.setIgnoreMouseEvents(ignore, { forward: true });
});

ipcMain.on('window:hide', () => { if (win) win.hide(); });
ipcMain.on('window:quit', () => { app.quit(); });

// Maximize/restore toggle for the settings/session-manager utility windows
// (see createUtilityWindow below) — resolved via the sending window rather
// than a fixed reference, since preload.js is shared unchanged across all
// three windows and each needs to control only itself.
ipcMain.on('window:toggleMaximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize(); else w.maximize();
});

function positionWindow() {
  if (!win) return;
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  win.setBounds({ x, y, width, height });
}

function createWindow() {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    x, y, width, height,
    frame: false,
    transparent: true,
    resizable: true,
    movable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // 'screen-saver' keeps it above fullscreen apps too; drop to 'floating' if
  // it fights with games or other always-on-top tools.
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  positionWindow();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Start fully click-through; the renderer turns it off when the cursor is
  // over the bubble or panel.
  win.setIgnoreMouseEvents(true, { forward: true });

  // Clicking outside the (click-through) window hands OS focus to whatever's
  // underneath; the renderer uses this as the "user clicked outside" signal
  // to auto-collapse the panel.
  win.on('blur', () => { win.webContents.send('window:blur'); });

  win.on('closed', () => { win = null; });

  // Follow the work area when displays or the taskbar change; the renderer
  // re-clamps the bubble into the new bounds on its own resize handler.
  screen.on('display-metrics-changed', () => { positionWindow(); });
}

function trayIcon() {
  // A 16x16 dot drawn inline so there's no external asset to ship.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6" fill="#8FA1FF"/></svg>`;
  return nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Local Assistant');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / hide', click: toggleWindow },
    { label: 'Reset position', click: () => {
        if (win) win.webContents.send('bubble:reset');
      }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]));
  tray.on('click', toggleWindow);
}

function toggleWindow() {
  if (!win) return createWindow();
  if (win.isVisible()) win.hide();
  else { win.show(); positionWindow(); }
}

// ---- Settings / session-manager windows ------------------------------------
// Real focusable utility windows (unlike the always-on-top click-through
// canvas above) — but still frameless and dark-themed, matching the rest of
// the app instead of native chrome. Singleton per kind: reopening focuses the
// existing window rather than spawning another.
let settingsWin = null;
let sessionsWin = null;

// The main window's click-through relies on Electron re-hit-testing on every
// mousemove (setIgnoreMouseEvents forward:true), which fights with whatever
// real window is on top of it for cursor ownership and makes the cursor
// flicker over these utility windows' inputs/buttons. Neither needs bubble
// hover-detection while open (opening one blurs the main window, which
// auto-collapses the panel anyway), so forwarding is suspended for as long as
// at least one is open and restored once the last one closes.
let utilityWindowsOpen = 0;

function suspendMainClickThrough() {
  utilityWindowsOpen++;
  if (win && utilityWindowsOpen === 1) win.setIgnoreMouseEvents(true);
}

function resumeMainClickThrough() {
  utilityWindowsOpen = Math.max(0, utilityWindowsOpen - 1);
  if (win && utilityWindowsOpen === 0) win.setIgnoreMouseEvents(true, { forward: true });
}

// Settings/sessions steal OS focus while open, which blurs the main widget
// and auto-collapses its panel (see onWindowBlur in app.js). Closing either
// window should hand focus back and reopen the panel rather than leaving the
// user staring at just the bubble.
function reopenMainPanel() {
  if (!win) return;
  win.show();
  win.focus();
  win.webContents.send('panel:open');
}

function createUtilityWindow(htmlFile, { width, height }) {
  const w = new BrowserWindow({
    width, height,
    minWidth: Math.min(360, width),
    minHeight: Math.min(300, height),
    frame: false,
    resizable: true,
    skipTaskbar: false,
    alwaysOnTop: false,
    backgroundColor: '#0B0D12',
    parent: win || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  w.loadFile(path.join(__dirname, 'renderer', htmlFile));

  // Lets the renderer swap the titlebar's maximize/restore icon in response
  // to state changes it didn't itself trigger (e.g. Windows' own Win+Up/Down
  // shortcuts), not just its own button clicks.
  w.on('maximize', () => w.webContents.send('window:maximizeChanged', true));
  w.on('unmaximize', () => w.webContents.send('window:maximizeChanged', false));

  return w;
}

function openSettingsWindow() {
  if (settingsWin) { settingsWin.focus(); return; }
  suspendMainClickThrough();
  settingsWin = createUtilityWindow('settings.html', { width: 560, height: 480 });
  settingsWin.on('closed', () => { settingsWin = null; resumeMainClickThrough(); reopenMainPanel(); });
}

function openSessionsWindow() {
  if (sessionsWin) { sessionsWin.focus(); return; }
  suspendMainClickThrough();
  sessionsWin = createUtilityWindow('sessions.html', { width: 420, height: 560 });
  sessionsWin.on('closed', () => { sessionsWin = null; resumeMainClickThrough(); reopenMainPanel(); });
}

ipcMain.on('settings:open', () => openSettingsWindow());
ipcMain.on('sessions:open', () => openSessionsWindow());

app.whenReady().then(() => {
  db.init(app.getPath('userData'));
  skills.init(app.getPath('userData'));
  createWindow();
  createTray();
  globalShortcut.register('CommandOrControl+Shift+Space', toggleWindow);
  // Reuses the 'settings' scope of store:changed so every open window's
  // existing onStoreChanged handler (which already re-reads settings and
  // calls refreshMcpTools()) picks up the now-connected tool list — without
  // this, a renderer that queried listMcpTools() before this promise settles
  // (the common case, since spawning/handshaking each MCP server is slower
  // than the renderer's own page load) would be stuck with an empty MCP tool
  // list until the user happened to open and save Settings.
  syncMcpServers(db.getSettings().mcpServers)
    .then(() => broadcastChange(null, { scope: 'settings' }))
    .catch(e => console.error('MCP startup connect failed:', e));
});

app.on('window-all-closed', (e) => {
  // Stay resident in the tray instead of exiting.
  e.preventDefault?.();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  for (const name of [...mcpClients.keys()]) disconnectMcpServer(name);
});
