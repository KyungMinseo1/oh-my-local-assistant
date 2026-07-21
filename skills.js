// Filesystem-backed Skills store: one folder per skill under
// <userData>/skills/<id>/SKILL.md, each file a small frontmatter block
// (name/description) followed by a Markdown body. Deliberately files, not a
// DB table (see db.js/presets) — skills are meant to be read/authored as
// plain Markdown, and a folder-per-skill leaves room to drop extra reference
// files alongside SKILL.md later, matching the SKILL.md convention this
// project's own Claude Code skills already use.
const fs = require('fs');
const path = require('path');

let skillsDir = null;

function init(userDataDir) {
  skillsDir = path.join(userDataDir, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
}

function newId() {
  return 'skill_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function skillFile(id) {
  return path.join(skillsDir, id, 'SKILL.md');
}

// name/description are kept single-line (frontmatter here is line-based, not
// real YAML) — collapse any newlines a user pastes in.
function oneLine(s) {
  return String(s || '').replace(/\r?\n/g, ' ').trim();
}

function serialize({ name, description, body }) {
  return `---\nname: ${oneLine(name)}\ndescription: ${oneLine(description)}\n---\n${body || ''}`;
}

// Tolerant of a missing/malformed frontmatter block — falls back to an empty
// name/description with the whole file as body rather than throwing, since
// this runs over every skill folder on every list() call.
function parse(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { name: '', description: '', body: text };
  const body = m[2];
  let name = '', description = '';
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w+):\s?(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[1] === 'name') name = kv[2];
    else if (kv[1] === 'description') description = kv[2];
  }
  return { name, description, body };
}

function listSkills() {
  let ids;
  try { ids = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); }
  catch { return []; }
  const out = [];
  for (const id of ids) {
    let text;
    try { text = fs.readFileSync(skillFile(id), 'utf-8'); } catch { continue; }
    const { name, description } = parse(text);
    out.push({ id, name, description });
  }
  return out;
}

function getSkill(id) {
  let text;
  try { text = fs.readFileSync(skillFile(id), 'utf-8'); } catch { return null; }
  const { name, description, body } = parse(text);
  return { id, name, description, body };
}

function createSkill(name, description, body) {
  const id = newId();
  fs.mkdirSync(path.join(skillsDir, id), { recursive: true });
  fs.writeFileSync(skillFile(id), serialize({ name, description, body }), 'utf-8');
  return { id, name: oneLine(name), description: oneLine(description), body: body || '' };
}

function updateSkill(id, { name, description, body } = {}) {
  const cur = getSkill(id);
  if (!cur) return;
  fs.writeFileSync(skillFile(id), serialize({
    name: name !== undefined ? name : cur.name,
    description: description !== undefined ? description : cur.description,
    body: body !== undefined ? body : cur.body
  }), 'utf-8');
}

// Non-destructive would mean nothing here (nothing references a skill by id
// elsewhere), so this just removes the folder outright.
function deleteSkill(id) {
  fs.rmSync(path.join(skillsDir, id), { recursive: true, force: true });
}

module.exports = { init, listSkills, getSkill, createSkill, updateSkill, deleteSkill };
