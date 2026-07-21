(() => {
  const DEFAULT_BASE = 'http://127.0.0.1:8080/v1';
  const $ = (id) => document.getElementById(id);
  const t = window.I18N.t;

  // Mirrors TOOL_DEFS in app.js (name + label only — the request-time schema
  // lives with the chat loop in the main widget, not here). Labels are
  // resolved through I18N so this list stays language-independent.
  const BUILTIN_TOOLS = [
    { name: 'get_datetime', labelKey: 'toolLabelDatetime' },
    { name: 'read_file', labelKey: 'toolLabelReadFile' },
    { name: 'file_glob_search', labelKey: 'toolLabelGlobSearch' },
    { name: 'grep_search', labelKey: 'toolLabelGrepSearch' },
    { name: 'tool_search', labelKey: 'toolLabelToolSearch' }
  ];

  const baseUrlInput = $('base-url'), modelInput = $('model-name'), maxTokensInput = $('max-tokens');
  const maxToolRoundsInput = $('max-tool-rounds');
  const languageSelect = $('language');
  const systemPromptInput = $('system-prompt');
  const workspacePathInput = $('workspace-path'), pickWorkspaceBtn = $('pick-workspace'), toolsListEl = $('tools-list');
  const mcpServersInput = $('mcp-servers'), mcpStatusEl = $('mcp-status'), mcpErrorEl = $('mcp-error'), mcpToolsListEl = $('mcp-tools-list');
  const saveBtn = $('save-settings'), saveStatusEl = $('save-status'), closeBtn = $('close-btn');
  const maximizeBtn = $('maximize-btn'), titlebarEl = $('titlebar');

  let settings = null;
  let mcpToolList = [];   // raw window.host.listMcpTools() shape: [{server,name,toolName,description,inputSchema,error?}]
  let connectingServers = new Set();   // server names whose (re)connect attempt hasn't settled yet — see onMcpStatusChanged

  function ensureToolDefaults() {
    if (!settings.tools) settings.tools = {};
    BUILTIN_TOOLS.forEach(t => {
      if (!settings.tools[t.name]) settings.tools[t.name] = { enabled: true, alwaysAllow: true };
    });
    mcpToolList.filter(t => !t.error).forEach(t => {
      if (!settings.tools[t.name]) settings.tools[t.name] = { enabled: true, alwaysAllow: false };
    });
  }

  function renderToolRow(container, name, label) {
    const cfg = settings.tools[name];
    const row = document.createElement('div');
    row.className = 'tool-row';
    row.innerHTML = `
      <span class="tool-name"></span>
      <label class="switch" title="${t('toolSwitchEnabledTitle')}"><input type="checkbox" class="opt-enabled"><span class="track"></span></label>
      <label class="switch" title="${t('toolSwitchAlwaysTitle')}"><input type="checkbox" class="opt-always"><span class="track"></span></label>`;
    const nameEl = row.querySelector('.tool-name');
    nameEl.textContent = label;
    nameEl.title = label;
    const enabledCb = row.querySelector('.opt-enabled');
    const alwaysCb = row.querySelector('.opt-always');
    enabledCb.checked = !!cfg.enabled;
    alwaysCb.checked = !!cfg.alwaysAllow;
    alwaysCb.disabled = !cfg.enabled;
    enabledCb.addEventListener('change', () => {
      cfg.enabled = enabledCb.checked;
      alwaysCb.disabled = !cfg.enabled;
      window.host.updateSettings({ tools: settings.tools });
    });
    alwaysCb.addEventListener('change', () => {
      cfg.alwaysAllow = alwaysCb.checked;
      window.host.updateSettings({ tools: settings.tools });
    });
    container.appendChild(row);
  }

  function renderToolsList() {
    toolsListEl.innerHTML = '';
    BUILTIN_TOOLS.forEach(bt => renderToolRow(toolsListEl, bt.name, t(bt.labelKey)));
  }

  // Servers stay open across a re-render (e.g. after saving) unless the user
  // explicitly collapses one — tracked by server name here since the DOM is
  // rebuilt from scratch each time.
  const openMcpServers = new Set();

  function renderMcpToolsList() {
    mcpToolsListEl.innerHTML = '';
    const ok = mcpToolList.filter(t => !t.error);
    // Servers still connecting (broadcast by main.js as soon as a reload
    // starts — see onMcpStatusChanged) haven't produced a tool/error entry
    // yet, so without this they'd just be silently absent from the list
    // until the whole batch settles, which reads as "did this not work?"
    // rather than "still connecting".
    const settled = new Set(mcpToolList.map(t => t.server));
    const stillConnecting = [...connectingServers].filter(name => !settled.has(name));
    if (!ok.length && !stillConnecting.length) {
      const e = document.createElement('div');
      e.style.cssText = 'font-size:11px;color:var(--text-muted);';
      e.textContent = t('mcpNoToolsFound');
      mcpToolsListEl.appendChild(e);
      return;
    }
    const byServer = new Map();
    ok.forEach(t => {
      if (!byServer.has(t.server)) byServer.set(t.server, []);
      byServer.get(t.server).push(t);
    });
    byServer.forEach((tools, server) => {
      const group = document.createElement('div');
      group.className = 'mcp-server-group' + (openMcpServers.has(server) ? ' open' : '');
      group.innerHTML = `
        <div class="mcp-server-header">
          <span class="caret">›</span>
          <span class="server-name"></span>
          <span class="count"></span>
        </div>
        <div class="mcp-server-tools"></div>`;
      group.querySelector('.server-name').textContent = server;
      group.querySelector('.count').textContent = tools.length;
      group.querySelector('.mcp-server-header').addEventListener('click', () => {
        const nowOpen = group.classList.toggle('open');
        if (nowOpen) openMcpServers.add(server); else openMcpServers.delete(server);
      });
      const toolsEl = group.querySelector('.mcp-server-tools');
      tools.forEach(t => renderToolRow(toolsEl, t.name, t.toolName));
      mcpToolsListEl.appendChild(group);
    });
    stillConnecting.forEach(server => {
      const group = document.createElement('div');
      group.className = 'mcp-server-group connecting';
      group.innerHTML = `
        <div class="mcp-server-header">
          <span class="server-name"></span>
          <span class="count">${t('mcpConnectingCount')}</span>
        </div>`;
      group.querySelector('.server-name').textContent = server;
      mcpToolsListEl.appendChild(group);
    });
  }

  function renderMcpStatus() {
    mcpStatusEl.innerHTML = '';
    const servers = Object.keys(settings.mcpServers || {});
    if (!servers.length) return;
    const errMap = {};
    mcpToolList.filter(t => t.error).forEach(t => { errMap[t.server] = t.error; });
    servers.forEach(name => {
      const row = document.createElement('div');
      if (connectingServers.has(name)) {
        row.className = 'mcp-status-row';
        row.textContent = '… ' + t('mcpStatusConnecting', { name });
      } else {
        const err = errMap[name];
        row.className = 'mcp-status-row' + (err ? ' err' : ' ok');
        row.textContent = (err ? '✗ ' : '✓ ') + name + (err ? ': ' + err : '');
      }
      mcpStatusEl.appendChild(row);
    });
  }

  // ---- JSON textarea editing helpers ---------------------------------------
  // Plain <textarea> gives Tab to focus-navigation and no auto-indent, which
  // makes hand-editing the mcpServers JSON painful. Tab/Shift+Tab indent or
  // outdent the current line (or every line touched by a selection) by two
  // spaces — matching the two-space indent JSON.stringify(..., null, 2)
  // already uses when populating this field — and Enter continues the
  // current line's indent, adding a level after `{`/`[` and, when the cursor
  // sits directly between a bracket pair, splitting it onto three lines with
  // the closing bracket pushed down.
  function lineStart(value, pos) {
    return value.lastIndexOf('\n', pos - 1) + 1;
  }
  function lineEnd(value, pos) {
    const idx = value.indexOf('\n', pos);
    return idx === -1 ? value.length : idx;
  }

  function indentSelection(el, indent) {
    const { value, selectionStart, selectionEnd } = el;
    if (selectionStart === selectionEnd) {
      if (indent) {
        el.value = value.slice(0, selectionStart) + '  ' + value.slice(selectionStart);
        el.selectionStart = el.selectionEnd = selectionStart + 2;
      } else {
        const before = value.slice(0, selectionStart);
        const m = before.match(/ {1,2}$/);
        if (!m) return;
        el.value = before.slice(0, -m[0].length) + value.slice(selectionStart);
        el.selectionStart = el.selectionEnd = selectionStart - m[0].length;
      }
      return;
    }

    const startLine = lineStart(value, selectionStart);
    const endLine = lineEnd(value, selectionEnd);
    const lines = value.slice(startLine, endLine).split('\n');
    let firstLineDelta = 0, totalDelta = 0;
    const newLines = lines.map((line, i) => {
      if (indent) {
        if (i === 0) firstLineDelta = 2;
        totalDelta += 2;
        return '  ' + line;
      }
      const m = line.match(/^ {1,2}/);
      if (!m) return line;
      if (i === 0) firstLineDelta = -m[0].length;
      totalDelta -= m[0].length;
      return line.slice(m[0].length);
    });
    el.value = value.slice(0, startLine) + newLines.join('\n') + value.slice(endLine);
    el.selectionStart = Math.max(startLine, selectionStart + firstLineDelta);
    el.selectionEnd = Math.max(el.selectionStart, selectionEnd + totalDelta);
  }

  function autoIndentNewline(el) {
    const { value, selectionStart, selectionEnd } = el;
    const sLine = lineStart(value, selectionStart);
    const currentIndent = (value.slice(sLine, selectionStart).match(/^[ \t]*/) || [''])[0];
    const prevChar = value[selectionStart - 1];
    const nextChar = value[selectionEnd];
    const opensBlock = prevChar === '{' || prevChar === '[';
    const closesBlock = nextChar === '}' || nextChar === ']';

    let insertText, cursorOffset;
    if (opensBlock && closesBlock) {
      const inner = currentIndent + '  ';
      insertText = '\n' + inner + '\n' + currentIndent;
      cursorOffset = 1 + inner.length;
    } else if (opensBlock) {
      insertText = '\n' + currentIndent + '  ';
      cursorOffset = insertText.length;
    } else {
      insertText = '\n' + currentIndent;
      cursorOffset = insertText.length;
    }

    el.value = value.slice(0, selectionStart) + insertText + value.slice(selectionEnd);
    el.selectionStart = el.selectionEnd = selectionStart + cursorOffset;
  }

  function attachSmartIndent(el) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        indentSelection(el, !e.shiftKey);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        autoIndentNewline(el);
      }
    });
  }
  attachSmartIndent(mcpServersInput);

  function populateFields() {
    baseUrlInput.value = settings.baseUrl || DEFAULT_BASE;
    modelInput.value = settings.model || '';
    maxTokensInput.value = settings.maxTokens || '';
    maxToolRoundsInput.value = settings.maxToolRounds || '';
    systemPromptInput.value = settings.systemPrompt || '';
    workspacePathInput.value = settings.workspace || '';
    mcpServersInput.value = JSON.stringify(settings.mcpServers || {}, null, 2);
    mcpErrorEl.textContent = '';
    languageSelect.value = settings.language || 'ko';
  }

  // ---- category switching --------------------------------------------------
  const catBtns = [...document.querySelectorAll('.cat-btn')];
  const panes = [...document.querySelectorAll('.pane')];
  function showCategory(cat) {
    catBtns.forEach(b => b.classList.toggle('active', b.dataset.cat === cat));
    panes.forEach(p => p.classList.toggle('active', p.dataset.cat === cat));
  }
  catBtns.forEach(b => b.addEventListener('click', () => showCategory(b.dataset.cat)));

  // ---- save -----------------------------------------------------------------
  // One button saves every category at once (base URL/model/max tokens/system
  // prompt/mcpServers) — matches the single-save behavior this panel had
  // inline before it became a separate window.
  saveBtn.addEventListener('click', async () => {
    let mcpServers;
    try {
      mcpServers = JSON.parse(mcpServersInput.value.trim() || '{}');
      if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) throw new Error(t('mcpJsonTopLevelError'));
    } catch (e) {
      mcpErrorEl.textContent = t('mcpJsonError', { msg: e.message });
      showCategory('mcp');
      return;
    }
    mcpErrorEl.textContent = '';

    const mt = parseInt(maxTokensInput.value.trim(), 10);
    const mtr = parseInt(maxToolRoundsInput.value.trim(), 10);

    saveBtn.disabled = true;
    saveStatusEl.textContent = t('statusConnectingMcp');
    mcpToolList = await window.host.reloadMcpServers(mcpServers);
    ensureToolDefaults();
    settings = await window.host.updateSettings({
      baseUrl: baseUrlInput.value.trim() || DEFAULT_BASE,
      model: modelInput.value.trim(),
      maxTokens: Number.isFinite(mt) && mt > 0 ? mt : null,
      maxToolRounds: Number.isFinite(mtr) && mtr > 0 ? mtr : null,
      systemPrompt: systemPromptInput.value.trim(),
      mcpServers,
      tools: settings.tools
    });
    saveBtn.disabled = false;
    saveStatusEl.textContent = t('statusSaved');
    renderToolsList();
    renderMcpToolsList();
    renderMcpStatus();
    setTimeout(() => { saveStatusEl.textContent = ''; }, 1500);
  });

  // Applies immediately, like the workspace picker below — no need to wait
  // for the save button. Re-renders this window's own dynamic text right
  // away; other open windows pick it up via the store:changed broadcast.
  languageSelect.addEventListener('change', () => {
    settings.language = languageSelect.value;
    window.host.updateSettings({ language: settings.language });
    window.I18N.setLang(settings.language);
    window.I18N.applyDom(document);
    renderToolsList();
    renderMcpToolsList();
    renderMcpStatus();
  });

  // Applies immediately (native picker), like the other checkboxes here —
  // no need to wait for "저장".
  pickWorkspaceBtn.addEventListener('click', async () => {
    const dir = await window.host.pickWorkspace();
    if (dir) {
      workspacePathInput.value = dir;
      settings.workspace = dir;
      window.host.updateSettings({ workspace: dir });
    }
  });

  closeBtn.addEventListener('click', () => window.close());

  // Maximize/restore toggle, plus the icon swap a normal window's titlebar
  // button would show. onMaximizeChanged also fires for state changes this
  // window didn't itself trigger (Win+Up/Down, dragging to a screen edge).
  const MAXIMIZE_ICON = '<rect x="4" y="4" width="16" height="16" rx="1"/>';
  const RESTORE_ICON = '<rect x="4" y="8" width="12" height="12" rx="1"/><path d="M8 8V5a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-3"/>';
  function setMaximizeIcon(isMax) {
    maximizeBtn.querySelector('svg').innerHTML = isMax ? RESTORE_ICON : MAXIMIZE_ICON;
    maximizeBtn.title = isMax ? t('restoreSize') : t('maximize');
  }
  maximizeBtn.addEventListener('click', () => window.host.toggleMaximize());
  titlebarEl.addEventListener('dblclick', (e) => {
    if (e.target.closest('.btns')) return;
    window.host.toggleMaximize();
  });
  if (window.host.onMaximizeChanged) window.host.onMaximizeChanged(setMaximizeIcon);

  // Live "연결 중…" progress while main.js (re)connects MCP servers — fires
  // as soon as a reload starts (all servers marked connecting at once) and
  // again as each one individually settles, not just once the whole batch
  // is done, so an already-open settings window reflects it in real time
  // regardless of which window (if any) triggered the reload.
  if (window.host.onMcpStatusChanged) {
    window.host.onMcpStatusChanged(({ connecting, tools }) => {
      if (!settings) return;   // this window hasn't finished its own init yet
      connectingServers = new Set(connecting);
      mcpToolList = tools;
      ensureToolDefaults();
      renderMcpToolsList();
      renderMcpStatus();
    });
  }

  // ---- init -------------------------------------------------------------
  (async () => {
    settings = await window.host.getSettings();
    if (typeof settings.workspace !== 'string') settings.workspace = '';
    if (typeof settings.systemPrompt !== 'string') settings.systemPrompt = '';
    if (!settings.mcpServers || typeof settings.mcpServers !== 'object') settings.mcpServers = {};
    if (!settings.tools) settings.tools = {};

    mcpToolList = await window.host.listMcpTools();
    ensureToolDefaults();

    window.I18N.setLang(settings.language || 'ko');
    window.I18N.applyDom(document);

    populateFields();
    renderToolsList();
    renderMcpToolsList();
    renderMcpStatus();
    showCategory('general');
  })();
})();
