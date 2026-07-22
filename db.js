// SQLite-backed session store (replaces the single sessions.json blob).
// Owns the DB connection and every read/write; main.js only calls the
// functions exported here, never touches better-sqlite3 directly.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db = null;
let currentDbPath = null;

const DEFAULT_SETTINGS = {
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: '',
  maxTokens: null,
  systemPrompt: '',
  workspace: '',
  mcpServers: {},
  tools: {},
  bubble: null,
  panel: null,
  activeId: null,
  language: 'ko',
  fontScale: 1
};

function dbFilePath(userDataDir) {
  return path.join(userDataDir, 'sessions.db');
}

function legacyJsonPath(userDataDir) {
  return path.join(userDataDir, 'sessions.json');
}

function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created INTEGER NOT NULL,
      updated INTEGER NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      preset_id TEXT REFERENCES presets(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_calls TEXT,
      tool_call_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
  `);
  const row = db.prepare('SELECT id FROM settings WHERE id = 1').get();
  if (!row) db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify(DEFAULT_SETTINGS));
}

// One-time import from the old single-file JSON store, run only when this is
// a brand new DB file. Non-destructive: the old file is renamed, not deleted.
function migrateFromJson(userDataDir) {
  const jsonFile = legacyJsonPath(userDataDir);
  if (!fs.existsSync(jsonFile)) return;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
  } catch (e) {
    console.error('Failed to read legacy sessions.json for migration:', e);
    return;
  }
  if (!parsed || !Array.isArray(parsed.sessions)) return;

  const insertProject = db.prepare('INSERT INTO projects (id, name, created) VALUES (?, ?, ?)');
  const insertSession = db.prepare('INSERT INTO sessions (id, title, created, updated, project_id) VALUES (?, ?, ?, ?, ?)');
  const insertMessage = db.prepare('INSERT INTO messages (session_id, seq, role, content, tool_calls, tool_call_id) VALUES (?, ?, ?, ?, ?, ?)');
  const writeSettings = db.prepare('UPDATE settings SET data = ? WHERE id = 1');

  const tx = db.transaction(() => {
    (parsed.projects || []).forEach(p => {
      insertProject.run(p.id, p.name, p.created || Date.now());
    });
    parsed.sessions.forEach(s => {
      insertSession.run(s.id, s.title || '새 세션', s.created || Date.now(), s.updated || Date.now(), s.projectId || null);
      (s.messages || []).forEach((m, i) => {
        insertMessage.run(
          s.id, i, m.role,
          m.content ?? null,
          m.tool_calls ? JSON.stringify(m.tool_calls) : null,
          m.tool_call_id ?? null
        );
      });
    });
    const settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}), activeId: parsed.activeId || null };
    writeSettings.run(JSON.stringify(settings));
  });
  tx();

  try { fs.renameSync(jsonFile, jsonFile + '.bak'); } catch (e) { console.error('Failed to rename legacy sessions.json after migration:', e); }
}

// Adds the preset_id column to a sessions table that predates presets
// (CREATE TABLE IF NOT EXISTS above only applies to brand new DBs).
function ensurePresetColumn() {
  const cols = db.prepare('PRAGMA table_info(sessions)').all();
  if (!cols.some(c => c.name === 'preset_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN preset_id TEXT REFERENCES presets(id) ON DELETE SET NULL');
  }
}

// One-time backfill adding a "[yyyy-mm-dd] " prefix (from each session's
// `created` timestamp) to titles that predate that convention.
function migrateDateTags() {
  const settings = getSettings();
  if (settings.dateTagsMigrated) return;
  const rows = db.prepare('SELECT id, title, created FROM sessions').all();
  const update = db.prepare('UPDATE sessions SET title = ? WHERE id = ?');
  const tx = db.transaction(() => {
    rows.forEach(r => {
      if (/^\[\d{4}-\d{2}-\d{2}\]/.test(r.title)) return;
      const d = new Date(r.created);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      update.run(`[${d.getFullYear()}-${mm}-${dd}] ${r.title}`, r.id);
    });
  });
  tx();
  updateSettings({ dateTagsMigrated: true });
}

function init(userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true });
  currentDbPath = dbFilePath(userDataDir);
  const isNew = !fs.existsSync(currentDbPath);
  db = new Database(currentDbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema();
  ensurePresetColumn();
  if (isNew) migrateFromJson(userDataDir);
  migrateDateTags();
}

function dbPath() {
  return currentDbPath;
}

// ---- settings ---------------------------------------------------------
function getSettings() {
  const row = db.prepare('SELECT data FROM settings WHERE id = 1').get();
  return { ...DEFAULT_SETTINGS, ...JSON.parse(row.data) };
}

function updateSettings(partial) {
  const next = { ...getSettings(), ...partial };
  db.prepare('UPDATE settings SET data = ? WHERE id = 1').run(JSON.stringify(next));
  return next;
}

// ---- sessions -----------------------------------------------------------
function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function listSessions() {
  return db.prepare('SELECT id, title, created, updated, project_id AS projectId FROM sessions ORDER BY updated DESC').all();
}

function rowToMessage(r) {
  const m = { role: r.role, content: r.content };
  if (r.tool_calls !== null) m.tool_calls = JSON.parse(r.tool_calls);
  if (r.tool_call_id !== null) m.tool_call_id = r.tool_call_id;
  return m;
}

function getSession(id) {
  const s = db.prepare('SELECT id, title, created, updated, project_id AS projectId, preset_id AS presetId FROM sessions WHERE id = ?').get(id);
  if (!s) return null;
  const rows = db.prepare('SELECT role, content, tool_calls, tool_call_id FROM messages WHERE session_id = ? ORDER BY seq ASC').all(id);
  s.messages = rows.map(rowToMessage);
  return s;
}

function createSession() {
  const id = newId('sess');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id, title, created, updated, project_id) VALUES (?, ?, ?, ?, NULL)').run(id, '새 세션', now, now);
  updateSettings({ activeId: id });
  return { id, title: '새 세션', created: now, updated: now, projectId: null, messages: [] };
}

// Deletes the session; if it was active, picks a new active session (creating
// a fresh one if that was the last session left) and returns the new activeId.
function deleteSession(id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  const settings = getSettings();
  if (settings.activeId !== id) return { activeId: settings.activeId };

  const remaining = listSessions();
  if (!remaining.length) return { activeId: createSession().id };
  updateSettings({ activeId: remaining[0].id });
  return { activeId: remaining[0].id };
}

function renameSession(id, title) {
  db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id);
}

function setSessionProject(id, projectId) {
  db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(projectId || null, id);
}

function setSessionPreset(id, presetId) {
  db.prepare('UPDATE sessions SET preset_id = ? WHERE id = ?').run(presetId || null, id);
}

// Inserts one message row and bumps the session's updated timestamp.
function appendMessage(id, message) {
  const seqRow = db.prepare('SELECT COALESCE(MAX(seq), -1) AS maxSeq FROM messages WHERE session_id = ?').get(id);
  db.prepare('INSERT INTO messages (session_id, seq, role, content, tool_calls, tool_call_id) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, seqRow.maxSeq + 1, message.role,
    message.content ?? null,
    message.tool_calls ? JSON.stringify(message.tool_calls) : null,
    message.tool_call_id ?? null
  );
  const updated = Date.now();
  db.prepare('UPDATE sessions SET updated = ? WHERE id = ?').run(updated, id);
  return { updated };
}

function setActiveSession(id) {
  updateSettings({ activeId: id });
}

// Rewrites a session's whole message list (delete-all + re-insert with fresh
// seq), used by the transcript's delete/regenerate actions — those remove a
// turn from the middle or truncate the tail, and renumbering from 0 here keeps
// seq contiguous so the renderer's array index always matches its row. Whole
// sessions are bounded by the model's context window, so rewriting all rows is
// cheaper than the bookkeeping a partial delete would need.
function replaceMessages(sessionId, messages) {
  const del = db.prepare('DELETE FROM messages WHERE session_id = ?');
  const ins = db.prepare('INSERT INTO messages (session_id, seq, role, content, tool_calls, tool_call_id) VALUES (?, ?, ?, ?, ?, ?)');
  const touch = db.prepare('UPDATE sessions SET updated = ? WHERE id = ?');
  const updated = Date.now();
  db.transaction(() => {
    del.run(sessionId);
    (messages || []).forEach((m, i) => {
      ins.run(
        sessionId, i, m.role,
        m.content ?? null,
        m.tool_calls ? JSON.stringify(m.tool_calls) : null,
        m.tool_call_id ?? null
      );
    });
    touch.run(updated, sessionId);
  })();
  return { updated };
}

// Removes the most recently appended message in a session — used when an
// aborted request leaves an orphaned user turn with no response attached.
function deleteLastMessage(sessionId) {
  db.prepare('DELETE FROM messages WHERE id = (SELECT id FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1)').run(sessionId);
}

// ---- projects -----------------------------------------------------------
function listProjects() {
  return db.prepare('SELECT id, name, created FROM projects ORDER BY created ASC').all();
}

function createProject(name) {
  const id = newId('proj');
  const created = Date.now();
  db.prepare('INSERT INTO projects (id, name, created) VALUES (?, ?, ?)').run(id, name, created);
  return { id, name, created };
}

// Non-destructive: sessions inside just lose their projectId (ON DELETE SET
// NULL), same as before — deleting a project never deletes its sessions.
function deleteProject(id) {
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

// ---- system prompt presets ----------------------------------------------
function listPresets() {
  return db.prepare('SELECT id, name, prompt, created FROM presets ORDER BY created ASC').all();
}

function createPreset(name, prompt) {
  const id = newId('preset');
  const created = Date.now();
  db.prepare('INSERT INTO presets (id, name, prompt, created) VALUES (?, ?, ?, ?)').run(id, name, prompt, created);
  return { id, name, prompt, created };
}

function updatePreset(id, { name, prompt } = {}) {
  const cur = db.prepare('SELECT name, prompt FROM presets WHERE id = ?').get(id);
  if (!cur) return;
  db.prepare('UPDATE presets SET name = ?, prompt = ? WHERE id = ?').run(
    name !== undefined ? name : cur.name,
    prompt !== undefined ? prompt : cur.prompt,
    id
  );
}

// Non-destructive: sessions using it just lose their presetId (ON DELETE SET
// NULL), falling back to the global default system prompt.
function deletePreset(id) {
  db.prepare('DELETE FROM presets WHERE id = ?').run(id);
}

module.exports = {
  init, dbPath,
  getSettings, updateSettings,
  listSessions, getSession, createSession, deleteSession, renameSession, setSessionProject, setSessionPreset, appendMessage, deleteLastMessage, replaceMessages, setActiveSession,
  listProjects, createProject, deleteProject,
  listPresets, createPreset, updatePreset, deletePreset
};
