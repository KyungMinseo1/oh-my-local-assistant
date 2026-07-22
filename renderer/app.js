(() => {
  const DEFAULT_BASE = 'http://127.0.0.1:8080/v1';
  const DEFAULT_MAX_TOKENS = 1024;   // caps runaway generation when a model never emits EOS

  const $ = (id) => document.getElementById(id);
  // Named `tr` (not `t`) since `t` is already used pervasively below as a
  // loop variable for tool-def objects (t.name, t.label, ...).
  const tr = window.I18N.t;
  const panel = $('panel'), bubble = $('bubble'), dot = $('dot');
  const sessionsEl = $('sessions'), sessionsBtn = $('sessions-btn');
  const settingsBtn = $('settings-btn');
  const endpointLabel = $('endpoint-label');
  const presetBtn = $('preset-btn'), presetBtnLabel = $('preset-btn-label'), presetMenu = $('preset-menu');
  const messagesEl = $('messages'), inputEl = $('input'), actionBtn = $('action'), actionIcon = $('action-icon');
  const closeBtn = $('close-btn'), resizeHandle = $('resize-handle');
  const ctxRow = $('ctx-row'), ctxFill = $('ctx-bar-fill'), ctxText = $('ctx-text');

  const BUBBLE = 54;         // bubble diameter (keep in sync with CSS)
  const MARGIN = 16;         // keep-away distance from the screen edges
  const GAP = 8;             // space between the bubble and the panel
  const PANEL_W = 380;       // default panel width
  const PANEL_H = 600;       // default panel height
  const PANEL_MIN_W = 300;   // smallest the panel may be resized to
  const PANEL_MIN_H = 260;
  const DRAG_THRESHOLD = 4;  // px of movement before a press becomes a drag

  const SEND_ICON = '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>';
  const STOP_ICON = '<rect x="6" y="6" width="12" height="12" rx="2"/>';

  const DEFAULT_MAX_TOOL_ROUNDS = 6;   // hard cap on model↔tool round-trips per message, to bound runaway loops — overridable via settings.maxToolRounds
  const MAX_ROUND_RETRIES = 2; // local-model stream hiccups (dropped connection mid tool-call, truncated JSON) are usually transient — worth a couple of silent re-tries before surfacing them

  // Read-only tools scoped to a workspace folder the user picks in Settings.
  // get_datetime needs no filesystem access and runs directly in the renderer;
  // the rest are executed in the main process (see main.js) since the renderer
  // has no Node/fs access.
  const TOOL_DEFS = [
    {
      name: 'get_datetime',
      label: '현재 시간 조회',
      schema: {
        type: 'function',
        function: {
          name: 'get_datetime',
          description: '현재 날짜와 시간을 반환합니다.',
          parameters: { type: 'object', properties: {}, additionalProperties: false }
        }
      }
    },
    {
      name: 'read_file',
      label: '파일 읽기',
      schema: {
        type: 'function',
        function: {
          name: 'read_file',
          description: '워크스페이스 폴더 안의 텍스트 파일 내용을 읽습니다.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: '워크스페이스 기준 상대 경로' } },
            required: ['path']
          }
        }
      }
    },
    {
      name: 'file_glob_search',
      label: '파일 이름 검색',
      schema: {
        type: 'function',
        function: {
          name: 'file_glob_search',
          description: '워크스페이스 폴더에서 glob 패턴으로 파일을 찾습니다 (예: **/*.js).',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'glob 패턴 (예: **/*.ts)' },
              path: { type: 'string', description: '검색을 시작할 하위 폴더 (기본값: 루트)' }
            },
            required: ['pattern']
          }
        }
      }
    },
    {
      name: 'grep_search',
      label: '내용 검색 (grep)',
      schema: {
        type: 'function',
        function: {
          name: 'grep_search',
          description: '워크스페이스 폴더의 파일 내용을 정규식으로 검색합니다.',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: '정규식 패턴' },
              path: { type: 'string', description: '검색을 시작할 하위 폴더 (기본값: 루트)' },
              ignore_case: { type: 'boolean', description: '대소문자 무시 여부' }
            },
            required: ['pattern']
          }
        }
      }
    },
    {
      name: 'tool_search',
      label: '도구 검색 (MCP)',
      schema: {
        type: 'function',
        function: {
          name: 'tool_search',
          description: '이름을 모르는 MCP 도구를 찾을 때 사용합니다. 필요한 기능을 자연어로 설명하면 관련된 도구를 찾아 반환하고, 이후 라운드부터 그 도구를 바로 호출할 수 있게 됩니다. 검색은 의미 기반이 아니라 단어 매칭이며 도구 설명은 대부분 영어라 놓칠 수 있으므로, 응답에는 항상 현재 연결된 MCP 서버 이름 목록(available_mcp_servers)도 함께 옵니다 — 검색 결과가 비어 있어도 그 목록에 관련 서버가 있으면 실제로는 도구가 존재하는 것이니 "그런 기능이 없다"고 단정하지 말고 한국어/영어 키워드를 섞어 다시 검색하세요 (예: "캘린더 일정 calendar event schedule").',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: '찾고자 하는 기능 설명. 한국어/영어 키워드를 여러 개 함께 넣으면 더 잘 찾습니다 (예: "이메일 검색 email search", "캘린더 일정 calendar event")' } },
            required: ['query']
          }
        }
      }
    },
    {
      name: 'read_skill',
      label: '스킬 불러오기',
      schema: {
        type: 'function',
        function: {
          name: 'read_skill',
          description: '시스템 프롬프트에 나열된 사용 가능한 스킬 중 하나의 전체 지침을 불러옵니다. 목록의 설명(description)이 현재 작업과 관련 있어 보이면 이 도구로 그 스킬의 본문을 읽고 그 지침을 따르세요.\n\npath를 생략하고 호출하면 메인 지침(SKILL.md 본문)과 함께, 그 스킬 폴더에 딸린 추가 참조 파일 목록(files)이 있으면 그것도 함께 반환됩니다. 본문 내용이나 files 목록에서 현재 작업과 관련된 참조 파일(예: references/xxx.md)이 보이면, 같은 name에 path 인자로 그 파일 경로를 넣어 다시 호출해 내용을 마저 불러오세요 — 필요하지 않은 참조 파일까지 미리 다 불러올 필요는 없습니다.',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '불러올 스킬의 이름 (스킬 목록에 나온 이름과 정확히 일치해야 함)' },
              path: { type: 'string', description: '스킬 폴더 안의 추가 참조 파일 상대 경로 (예: references/playwright-tests.md). 생략하면 메인 지침(SKILL.md 본문)과 참조 파일 목록을 반환합니다.' }
            },
            required: ['name']
          }
        }
      }
    },
    {
      name: 'run_command',
      label: '터미널 명령 실행',
      schema: {
        type: 'function',
        function: {
          name: 'run_command',
          description: '워크스페이스 폴더 안에서 셸 명령을 실행하고 표준출력/표준에러/종료 코드를 반환합니다. 임의의 명령을 실행할 수 있는 강력한 도구이므로 신중하게 사용하세요. 매 호출은 완전히 새로운 셸에서 실행되므로 cd로 이동한 디렉터리나 환경변수 등은 다음 호출로 이어지지 않습니다 — 여러 단계를 한 번에 실행하려면 한 명령 안에서 && 로 연결하거나 cwd 인자를 쓰세요.\n\n바로 실행부터 하지 마세요. 먼저: (1) 파일/폴더 경로가 필요한 작업이면 이름이나 패턴만 보고 위치를 추측하지 말고 이전 도구 결과(file_glob_search, read_file 등)에 실제로 나온 경로를 다시 확인하거나, 확실하지 않으면 dir/ls로 먼저 확인한다. (2) 무엇을 어떤 순서로 실행할지 단계별 계획을 먼저 세운다. (3) 계획대로 한 단계씩 실행하고, 각 결과(특히 stderr와 exitCode)를 확인한 뒤 다음 단계로 넘어간다. "일단 실행해보고 오류 나면 그때 고치기"를 반복하지 말고, 실행 전에 경로와 순서를 먼저 확정하세요.',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: '실행할 셸 명령' },
              cwd: { type: 'string', description: '명령을 실행할 워크스페이스 기준 상대 경로 (기본값: 워크스페이스 루트)' }
            },
            required: ['command']
          }
        }
      }
    }
  ];

  // Per-parameter description patches for specific MCP tools, applied at
  // request time (see applyMcpSchemaPatches). A rule stated only in the
  // system prompt gets diluted across a long conversation; putting it in the
  // parameter's own JSON Schema description means the model sees it right
  // when it's filling in that argument — the way MCP tool schemas are meant
  // to be self-describing in the first place, and it holds up far better in
  // practice. Keyed by MCP server name -> tool name -> parameter name.
  const MCP_SCHEMA_PATCHES = {
    'mcp-email-server': {
      list_emails_metadata: {
        since: (desc) => (desc || '') + ' 반드시 UTC ISO-8601 형식이어야 하며 "Z" 접미사가 필요합니다 (JS의 Date.toISOString() 결과와 동일). 예: "2026-07-19T00:00:00.000Z". 날짜만 쓰거나 "Z"를 빼면 오류가 납니다. 사용자가 말한 시간은 한국 시간(KST, UTC+9)이므로 9시간을 빼서 UTC로 변환하세요 (예: 한국 시간 7/19 오전 9시 → UTC "2026-07-19T00:00:00.000Z").',
        before: (desc) => (desc || '') + ' 반드시 UTC ISO-8601 형식이어야 하며 "Z" 접미사가 필요합니다 (JS의 Date.toISOString() 결과와 동일). 예: "2026-07-19T00:00:00.000Z". 날짜만 쓰거나 "Z"를 빼면 오류가 납니다. 사용자가 말한 시간은 한국 시간(KST, UTC+9)이므로 9시간을 빼서 UTC로 변환하세요 (예: 한국 시간 7/19 오전 9시 → UTC "2026-07-19T00:00:00.000Z").'
      }
    }
  };

  // Returns a copy of inputSchema with any matching MCP_SCHEMA_PATCHES text
  // appended to the relevant parameter descriptions — never mutates the
  // schema object main.js handed us, since that's shared with anything else
  // reading the same mcpTools list.
  function applyMcpSchemaPatches(server, toolName, inputSchema) {
    const patch = MCP_SCHEMA_PATCHES[server]?.[toolName];
    if (!patch || !inputSchema?.properties) return inputSchema;
    const patched = JSON.parse(JSON.stringify(inputSchema));
    for (const [param, fn] of Object.entries(patch)) {
      const prop = patched.properties[param];
      if (prop) prop.description = fn(prop.description);
    }
    return patched;
  }

  // Cross-cutting notes appended to every tool's function-level description
  // for a given MCP server — for instructions that aren't about a single
  // input parameter (e.g. "every date this server returns is UTC, convert
  // it before describing it to the user"). Applied in applyMcpToolList.
  const MCP_SERVER_DESCRIPTION_PATCHES = {
    'mcp-email-server': (desc) => (desc || '') + ' 이 도구가 응답으로 반환하는 모든 날짜/시간 값은 UTC입니다. 사용자에게 설명할 때는 9시간을 더해 한국 시간(KST, UTC+9)으로 환산해서 말하세요 (예: UTC "2026-07-19T00:00:00.000Z" → 한국 시간 7/19 오전 9시).'
  };

  let settings = { baseUrl: DEFAULT_BASE, model: '' };
  let sessionList = [];   // metadata only: {id, title, created, updated, projectId} — feeds the drawer
  let session = null;     // the currently open session, full detail incl. messages
  let presetList = [];    // named system-prompt presets, managed in the settings window
  let skillList = [];     // {id, name, description} index of skills, managed in the settings window — full body loaded on demand via read_skill
  let isOpen = false;
  let controller = null;   // AbortController for the in-flight request
  let pendingConfirmResolve = null;   // resolves the current tool-approval prompt, if any

  let bubbleLeft = 0, bubbleTop = 0;   // bubble top-left within the window
  let dragging = false, dragMoved = false;
  let panelW = PANEL_W, panelH = PANEL_H;      // current (resizable) panel size
  let curOriginX = 'left', curOriginY = 'top'; // which corner the panel is anchored from
  let resizing = false;

  let detectedModel = '';

  // Context-window tracking, driven by the `usage` object llama.cpp/OpenAI-
  // compatible servers report per completion (see runCompletionRound). Since
  // the full history is resent every request (see README), the most recent
  // round's total_tokens is effectively the size of the session's context so
  // far — not persisted across sessions/restarts, just a live read.
  let serverNCtx = null;          // -c value the server was launched with, from /props
  let serverPropsBase = null;     // baseUrl serverNCtx was fetched for, so a settings change re-fetches
  let sessionContextTokens = null;

  // Tools discovered from configured MCP servers, shaped like TOOL_DEFS
  // entries ({name, label, schema}) so both lists can be treated uniformly
  // everywhere below. Repopulated at startup and whenever the store changes
  // elsewhere (e.g. the settings window reconnects servers) — see
  // window.host.onStoreChanged() in the init section below.
  let mcpTools = [];

  // Which MCP tools' full schemas are currently allowed into the request's
  // `tools` array, keyed by session id. Populated by tool_search results
  // (see execTool) and consulted by enabledToolSpecs() — this is the lazy-
  // loading mechanism that keeps unused MCP schemas out of every request.
  // Lives only for the app's lifetime (MCP connections reset on restart too)
  // and is cheap enough (a handful of strings per session) that it's never
  // pruned.
  const activeMcpToolNamesBySession = new Map(); // sessionId -> Set<toolName>
  function activeToolSetFor(sessionId) {
    let set = activeMcpToolNamesBySession.get(sessionId);
    if (!set) { set = new Set(); activeMcpToolNamesBySession.set(sessionId, set); }
    return set;
  }

  function findToolDef(name) {
    return TOOL_DEFS.find(t => t.name === name) || mcpTools.find(t => t.name === name);
  }

  // Skills toggled off in Settings (settings.skillsEnabled[id] === false) are
  // filtered out here so they're invisible to the model both in the system-
  // prompt index (apiMessages) and via read_skill lookup (execTool) — a
  // disabled skill isn't just "discouraged", it doesn't exist as far as the
  // request is concerned.
  function enabledSkillList() {
    return skillList.filter(sk => settings.skillsEnabled?.[sk.id] !== false);
  }

  // Lightweight lexical matching (token overlap, not embeddings) behind
  // tool_search — at the scale of tens/hundreds of MCP tools this is enough,
  // and it needs no embedding model served alongside the chat model.
  function tokenize(s) { return (s || '').toLowerCase().match(/[a-z0-9가-힣]+/g) || []; }

  function searchMcpTools(query, limit = 5) {
    const qTokens = new Set(tokenize(query));
    if (!qTokens.size) return [];
    const enabledMcp = mcpTools.filter(t => settings.tools?.[t.name]?.enabled);
    const scored = enabledMcp
      .map(t => {
        const text = t.name + ' ' + t.label + ' ' + (t.schema.function.description || '');
        const score = tokenize(text).reduce((n, tok) => n + (qTokens.has(tok) ? 1 : 0), 0);
        return { t, score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(x => x.t);
  }

  // Keyword matching alone can miss a real tool entirely (e.g. a Korean
  // query against English-only tool descriptions) and make the model
  // wrongly conclude an integration doesn't exist at all. Server names are
  // few and cheap, so tool_search always includes this list alongside its
  // matches as a cross-check the model can visually scan.
  function availableMcpServers() {
    const enabledMcp = mcpTools.filter(t => settings.tools?.[t.name]?.enabled);
    return [...new Set(enabledMcp.map(t => t.server))].sort();
  }

  function applyMcpToolList(list) {
    mcpTools = list.filter(t => !t.error).map(t => {
      const descPatch = MCP_SERVER_DESCRIPTION_PATCHES[t.server];
      const description = descPatch ? descPatch(t.description) : t.description;
      return {
        name: t.name,
        label: '[' + t.server + '] ' + t.toolName,
        server: t.server,
        schema: { type: 'function', function: { name: t.name, description, parameters: applyMcpSchemaPatches(t.server, t.toolName, t.inputSchema) } }
      };
    });
    mcpTools.forEach(t => {
      if (!settings.tools[t.name]) settings.tools[t.name] = { enabled: true, alwaysAllow: false };
    });
  }

  // Reads whatever main.js currently has connected, without reconnecting —
  // the main widget itself never edits mcpServers or triggers a reconnect
  // (that now happens in the settings window), it just needs the current
  // tool list to build enabledToolSpecs() for the chat loop.
  async function refreshMcpTools() {
    applyMcpToolList(await window.host.listMcpTools());
  }

  // ---- persistence --------------------------------------------------------
  async function load() {
    settings = await window.host.getSettings();
    window.I18N.setLang(settings.language || 'ko');
    window.I18N.applyDom(document);
    document.documentElement.style.setProperty('--font-scale', settings.fontScale || 1);
    if (typeof settings.workspace !== 'string') settings.workspace = '';
    if (typeof settings.systemPrompt !== 'string') settings.systemPrompt = '';
    if (!settings.mcpServers || typeof settings.mcpServers !== 'object') settings.mcpServers = {};
    if (!settings.tools) settings.tools = {};
    TOOL_DEFS.forEach(t => {
      if (!settings.tools[t.name]) {
        // run_command executes arbitrary shell commands — unlike every other
        // built-in here (sandboxed, read-only), it defaults off and, even
        // once enabled, still requires per-call approval until the user
        // explicitly opts into "always allow" themselves.
        settings.tools[t.name] = t.name === 'run_command' ? { enabled: false, alwaysAllow: false } : { enabled: true, alwaysAllow: true };
      }
    });

    sessionList = await window.host.listSessions();
    if (!sessionList.length) {
      await newSession(false);
      return;
    }
    if (!settings.activeId || !sessionList.find(s => s.id === settings.activeId)) {
      settings.activeId = sessionList[0].id;
      window.host.setActiveSession(settings.activeId);
    }
    session = await window.host.getSession(settings.activeId);
    presetList = await window.host.listPresets();
    skillList = await window.host.listSkills();
    resetContextUsage();
  }

  // Keeps a session's updated timestamp (local + drawer list entry) in sync
  // after a message is appended, without re-reading the session back from the DB.
  function touchSession(s) {
    s.updated = Date.now();
    const entry = sessionList.find(x => x.id === s.id);
    if (entry) entry.updated = s.updated;
  }

  function activeSession() {
    return session;
  }

  async function newSession(render = true) {
    const s = await window.host.createSession();
    sessionList.unshift({ id: s.id, title: s.title, created: s.created, updated: s.updated, projectId: s.projectId });
    settings.activeId = s.id;
    session = s;
    resetContextUsage();
    if (render) { renderSessions(); renderMessages(); renderPresetSelect(); }
    return s;
  }

  async function deleteSession(id) {
    const { activeId } = await window.host.deleteSession(id);
    sessionList = sessionList.filter(s => s.id !== id);
    if (!sessionList.length) sessionList = await window.host.listSessions();   // deleteSession() created a fresh one server-side
    settings.activeId = activeId;
    session = await window.host.getSession(activeId);
    resetContextUsage();
    renderSessions(); renderMessages(); renderPresetSelect();
  }

  // Title is derived from the first user message: no naming prompt to dismiss,
  // and it stays recognizable in the list. Prefixed with the session's
  // creation date so entries stay sortable/identifiable at a glance.
  function dateTag(ts) {
    const d = new Date(ts);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `[${d.getFullYear()}-${mm}-${dd}]`;
  }

  function retitle(s) {
    const first = s.messages.find(m => m.role === 'user');
    if (!first) return;
    const t = first.content.trim().replace(/\s+/g, ' ');
    const body = t.length > 34 ? t.slice(0, 34) + '…' : t;
    const title = `${dateTag(s.created)} ${body}`;
    if (title === s.title) return;
    s.title = title;
    window.host.renameSession(s.id, title);
    const entry = sessionList.find(x => x.id === s.id);
    if (entry) entry.title = title;
  }

  // ---- rendering ----------------------------------------------------------
  // Only the 3 most-recently-updated sessions show here — the rest (and
  // project grouping) live in the session-manager window opened via 더보기,
  // so this stays fast/light regardless of how many sessions accumulate.
  function renderSessions() {
    sessionsEl.innerHTML = '';
    const recent = [...sessionList].sort((a, b) => b.updated - a.updated).slice(0, 3);
    recent.forEach(s => {
      const row = document.createElement('div');
      row.className = 'session-row' + (s.id === settings.activeId ? ' active' : '');
      row.innerHTML = `<span class="name"></span><span class="meta"></span>
        <button class="ibtn del" title="${tr('delete')}"><svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>`;
      row.querySelector('.name').textContent = s.title;
      row.querySelector('.meta').textContent = window.I18N.timeAgo(s.updated);
      row.addEventListener('click', async (e) => {
        if (e.target.closest('.del')) return;
        if (controller) return;              // don't swap sessions mid-stream
        settings.activeId = s.id;
        window.host.setActiveSession(s.id);
        session = await window.host.getSession(s.id);
        resetContextUsage();
        renderSessions(); renderMessages(); renderPresetSelect();
      });
      row.querySelector('.del').addEventListener('click', (e) => {
        e.stopPropagation(); deleteSession(s.id);
      });
      sessionsEl.appendChild(row);
    });

    const more = document.createElement('div');
    more.className = 'session-row more';
    more.innerHTML = '<span class="name"></span>';
    more.querySelector('.name').textContent = tr('moreSessions');
    more.addEventListener('click', () => window.host.openSessions());
    sessionsEl.appendChild(more);

    const add = document.createElement('div');
    add.id = 'new-session';
    add.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg><span></span>';
    add.querySelector('span').textContent = tr('newSession');
    add.addEventListener('click', () => { if (!controller) newSession(); });
    sessionsEl.appendChild(add);
  }

  // While a response is streaming in, repeatedly forcing scrollTop to the
  // bottom fights any attempt to scroll up and read earlier messages. Auto-
  // follow only when the user was already at (or near) the bottom; `force`
  // is for events that should always jump there regardless (opening/switching
  // a session, sending a new message of your own).
  function isScrolledNearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
  }
  function autoScrollMessages(force = false) {
    if (force || isScrolledNearBottom()) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderMessages() {
    const s = activeSession();
    messagesEl.innerHTML = '';
    if (!s.messages.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.innerHTML = '<span class="caret">›</span> ' + escapeHtml(tr('emptyState')) + '<br><span class="caret-blink"></span>';
      messagesEl.appendChild(e);
      return;
    }
    const callIndex = {};   // tool_call_id -> {name, arguments}, built as we replay
    s.messages.forEach(m => {
      if (m.role === 'user') { bubbleFor('user', m.content || '', false); return; }
      if (m.role === 'assistant') {
        if (m.content) bubbleFor('assistant', m.content, false);
        (m.tool_calls || []).forEach(tc => {
          callIndex[tc.id] = tc.function;
          toolBubble(formatCall(tc.function.name, tc.function.arguments), false);
        });
        return;
      }
      if (m.role === 'tool') {
        const fn = callIndex[m.tool_call_id];
        toolBubble(formatResult(fn?.name, m.content), false);
      }
    });
    autoScrollMessages(true);
  }

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
  }

  // Inline formatting (bold/italic/strikethrough/links) over already-escaped
  // text. Links are restricted to http(s)/mailto so a crafted `javascript:`
  // URL in model output can't execute when clicked.
  function renderInline(s) {
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/gi, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    s = s.replace(/(?<![\w])_([^_\n]+)_(?![\w])/g, '<em>$1</em>');
    return s;
  }

  // GFM-style pipe table row: splits on unescaped `|`, trims each cell.
  function splitTableRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; }
      else if (s[i] === '|') { cells.push(cur.trim()); cur = ''; }
      else cur += s[i];
    }
    cells.push(cur.trim());
    return cells;
  }

  // Returns a per-column align array (''/'left'/'right'/'center') if `line` is
  // a valid table delimiter row (e.g. `| --- | :---: | ---: |`), else null.
  // Requires a `|` so a lone `---` (horizontal rule) is never mistaken for a
  // single-column table.
  function tableAligns(line) {
    const t = line.trim();
    if (!t.includes('|')) return null;
    if (!/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(t)) return null;
    return splitTableRow(line).map(c => {
      const l = c.startsWith(':'), r = c.endsWith(':');
      return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
    });
  }

  // Small, dependency-free Markdown -> HTML renderer for chat bubbles.
  // Code spans/blocks are pulled out and escaped first (into `stash`, keyed by
  // placeholder tokens) so inline formatting and the later escapeHtml() pass
  // never touch code content; everything else is escaped before any tag is
  // generated, so raw HTML in model/user text can't reach the DOM.
  function renderMarkdown(text) {
    if (!text) return '';
    const stash = [];
    const stashPush = (html) => { stash.push(html); return '@@' + (stash.length - 1) + '@@'; };

    let src = String(text).replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) =>
      stashPush('<pre><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre>')
    );
    src = src.replace(/`([^`\n]+)`/g, (_, code) => stashPush('<code>' + escapeHtml(code) + '</code>'));
    src = escapeHtml(src);

    const lines = src.split('\n');
    const out = [];
    let para = [], list = null;
    const flushPara = () => { if (para.length) { out.push('<p>' + para.join('<br>') + '</p>'); para = []; } };
    const flushList = () => { if (list) { out.push('<' + list.type + '>' + list.items.map(i => '<li>' + i + '</li>').join('') + '</' + list.type + '>'); list = null; } };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) { flushPara(); flushList(); continue; }
      let m;
      if (line.includes('|') && i + 1 < lines.length && tableAligns(lines[i + 1])) {
        flushPara(); flushList();
        const aligns = tableAligns(lines[i + 1]);
        const headCells = splitTableRow(line);
        i++;   // consume the delimiter row
        const bodyRows = [];
        while (i + 1 < lines.length && lines[i + 1].trim() && lines[i + 1].includes('|')) {
          i++;
          bodyRows.push(splitTableRow(lines[i]));
        }
        const rowHtml = (cells, tag) => '<tr>' + cells.map((c, j) => {
          const a = aligns[j];
          return '<' + tag + (a ? ' style="text-align:' + a + '"' : '') + '>' + renderInline(c) + '</' + tag + '>';
        }).join('') + '</tr>';
        out.push('<table><thead>' + rowHtml(headCells, 'th') + '</thead><tbody>' +
          bodyRows.map(r => rowHtml(r, 'td')).join('') + '</tbody></table>');
      } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
        flushPara(); flushList();
        const lvl = m[1].length;
        out.push('<h' + lvl + '>' + renderInline(m[2]) + '</h' + lvl + '>');
      } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
        flushPara(); flushList();
        out.push('<hr>');
      } else if ((m = /^&gt;\s?(.*)$/.exec(line))) {
        flushPara(); flushList();
        out.push('<blockquote>' + renderInline(m[1]) + '</blockquote>');
      } else if ((m = /^[-*+]\s+(.*)$/.exec(line))) {
        flushPara();
        if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
        list.items.push(renderInline(m[1]));
      } else if ((m = /^\d+\.\s+(.*)$/.exec(line))) {
        flushPara();
        if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
        list.items.push(renderInline(m[1]));
      } else if ((m = /^\s*@@(\d+)@@\s*$/.exec(line)) && /^<pre[ >]/.test(stash[+m[1]])) {
        // A line that's just a fenced-code-block placeholder: emit <pre> as its
        // own block instead of paragraph-wrapping it (<pre> isn't valid inside <p>).
        flushPara(); flushList();
        out.push('@@' + m[1] + '@@');
      } else {
        flushList();
        para.push(renderInline(line));
      }
    }
    flushPara(); flushList();

    return out.join('').replace(/@@(\d+)@@/g, (_, i) => stash[+i]);
  }

  function setMsgContent(el, text) {
    el.innerHTML = renderMarkdown(text);
  }

  function bubbleFor(role, content, scroll = true) {
    const empty = messagesEl.querySelector('.empty');
    if (empty) empty.remove();
    const wasNearBottom = isScrolledNearBottom();
    const d = document.createElement('div');
    d.className = 'msg ' + role;
    setMsgContent(d, content);
    messagesEl.appendChild(d);
    if (scroll && wasNearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
    return d;
  }

  // Compact status line for a tool call or its result, shown inline in the
  // message list (both live, as tools run, and on session replay). The
  // near-bottom check must happen *before* the new block is appended — doing
  // it after would measure the distance including the block that was just
  // added, so a tall tool-call/result box can push it past the threshold
  // even though the user was sitting right at the bottom.
  function toolBubble(text, scroll = true) {
    const empty = messagesEl.querySelector('.empty');
    if (empty) empty.remove();
    const wasNearBottom = isScrolledNearBottom();
    const d = document.createElement('div');
    d.className = 'msg tool';
    d.textContent = text;
    messagesEl.appendChild(d);
    if (scroll && wasNearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
    return d;
  }

  // Live "thinking" bubble for reasoning-model streams (delta.reasoning_content /
  // delta.reasoning). Never appended to s.messages — like most chat UIs, reasoning
  // is shown while it happens but not persisted or resent as input on later turns.
  // Starts collapsed; click toggles the body open/closed regardless of streaming state.
  function reasoningBubble() {
    const empty = messagesEl.querySelector('.empty');
    if (empty) empty.remove();
    const d = document.createElement('div');
    d.className = 'msg reasoning';
    d.innerHTML = `<div class="r-head"><span class="caret">›</span><span class="r-label"></span></div>
                   <div class="r-body"></div>`;
    d.querySelector('.r-label').textContent = tr('thinking');
    d.querySelector('.r-head').addEventListener('click', () => d.classList.toggle('open'));
    return d;
  }
  function setReasoningBody(el, text) {
    el.querySelector('.r-body').textContent = text;
  }
  function finalizeReasoning(el, startedAt) {
    if (el.dataset.done) return;
    el.dataset.done = '1';
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    el.querySelector('.r-label').textContent = tr('thoughtFor', { s: secs });
  }

  function formatCall(name, argsJsonStr) {
    let argsStr = argsJsonStr || '';
    try { argsStr = JSON.stringify(JSON.parse(argsJsonStr || '{}')); } catch { /* show raw text */ }
    if (argsStr.length > 160) argsStr = argsStr.slice(0, 160) + '…';
    return '🔧 ' + name + '(' + argsStr + ')';
  }

  function formatResult(name, contentJsonStr) {
    let obj;
    try { obj = JSON.parse(contentJsonStr); } catch { obj = null; }
    if (!obj || typeof obj !== 'object') return '↳ ' + String(contentJsonStr || '').slice(0, 200);
    if (obj.ok === false) return tr('toolErrorPrefix', { msg: obj.error || tr('toolErrorUnknown') });
    switch (name) {
      case 'read_file':
        return tr('readFileResult', {
          path: obj.path,
          n: obj.content ? obj.content.length : 0,
          extra: obj.truncated ? tr('truncatedSuffix') : ''
        });
      case 'file_glob_search':
        return tr('globResult', { n: obj.count, extra: obj.truncated ? tr('moreExistsSuffix') : '' });
      case 'grep_search':
        return tr('grepResult', { n: obj.count, extra: obj.truncated ? tr('moreExistsSuffix') : '' });
      case 'get_datetime':
        return '↳ ' + obj.local;
      default: {
        const j = JSON.stringify(obj);
        return '↳ ' + (j.length > 200 ? j.slice(0, 200) + '…' : j);
      }
    }
  }

  // A tool call whose "Always allow" is off pauses here until the user clicks
  // Approve/Deny. stop() also resolves this (as a denial) so the Stop button
  // works even while a confirmation prompt is showing.
  function confirmToolCall(name, argsObj) {
    return new Promise((resolve) => {
      const empty = messagesEl.querySelector('.empty');
      if (empty) empty.remove();
      const wasNearBottom = isScrolledNearBottom();
      const d = document.createElement('div');
      d.className = 'msg tool-confirm';
      d.innerHTML = `
        <div class="head"></div>
        <div class="args"></div>
        <div class="confirm-btns">
          <button class="deny" type="button"></button>
          <button class="approve" type="button"></button>
        </div>`;
      d.querySelector('.deny').textContent = tr('confirmDeny');
      d.querySelector('.approve').textContent = tr('confirmApprove');
      d.querySelector('.head').textContent = tr('confirmHead', { name });
      d.querySelector('.args').textContent = JSON.stringify(argsObj);
      messagesEl.appendChild(d);
      if (wasNearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;

      const finish = (ok) => {
        d.querySelectorAll('button').forEach(b => b.disabled = true);
        d.remove();
        pendingConfirmResolve = null;
        resolve(ok);
      };
      pendingConfirmResolve = finish;
      d.querySelector('.approve').addEventListener('click', () => finish(true));
      d.querySelector('.deny').addEventListener('click', () => finish(false));
    });
  }

  function shortModel(id) {
    if (!id) return '';
    const base = id.split(/[\\/]/).pop();
    return base.replace(/\.gguf$/i, '');
  }

  function renderEndpoint() {
    const explicit = (settings.model || '').trim();
    const name = shortModel(explicit) || shortModel(detectedModel);
    if (name) {
      endpointLabel.textContent = name;
      endpointLabel.title = settings.baseUrl || DEFAULT_BASE;
      return;
    }
    try {
      const u = new URL(settings.baseUrl || DEFAULT_BASE);
      endpointLabel.textContent = u.host + (u.pathname !== '/' ? u.pathname : '');
    } catch { endpointLabel.textContent = settings.baseUrl; }
  }

  // Lets the current session pick a named system-prompt preset (managed in
  // Settings → 시스템 프롬프트) instead of the global default — apiMessages()
  // reads session.presetId at request time. Rendered as a pill button next to
  // the composer (like a model/persona switcher) that opens a small popup
  // menu upward, rather than a native <select>.
  const CHECK_ICON = '<path d="M5 13l4 4L19 7"/>';
  function activePresetId() {
    return (session && presetList.some(p => p.id === session.presetId)) ? session.presetId : '';
  }

  function closePresetMenu() {
    presetMenu.classList.remove('open');
    presetBtn.classList.remove('open');
  }

  function selectPreset(presetId) {
    if (!session) return;
    session.presetId = presetId || null;
    window.host.setSessionPreset(session.id, session.presetId);
    renderPresetSelect();
    closePresetMenu();
  }

  function renderPresetMenu() {
    presetMenu.innerHTML = '';
    const active = activePresetId();
    const options = [{ id: '', name: tr('presetDefault') }, ...presetList];
    options.forEach(p => {
      const row = document.createElement('div');
      row.className = 'preset-opt' + (p.id === active ? ' active' : '');
      row.innerHTML = `<svg class="check" viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${CHECK_ICON}</svg><span class="name"></span>`;
      row.querySelector('.name').textContent = p.name;
      row.addEventListener('click', () => selectPreset(p.id));
      presetMenu.appendChild(row);
    });
  }

  function renderPresetSelect() {
    const active = activePresetId();
    const activePreset = presetList.find(p => p.id === active);
    presetBtnLabel.textContent = activePreset ? activePreset.name : tr('presetDefault');
    renderPresetMenu();
  }

  presetBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = !presetMenu.classList.contains('open');
    if (opening) renderPresetMenu();
    presetMenu.classList.toggle('open', opening);
    presetBtn.classList.toggle('open', opening);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#composer-top')) closePresetMenu();
  });

  // ---- context / token usage ------------------------------------------------
  // llama.cpp's non-OpenAI /props endpoint exposes the server's -c value, but
  // the exact shape has shifted across versions (top-level n_ctx vs nested
  // under default_generation_settings), so this scans a couple levels deep
  // for the first n_ctx key rather than hardcoding one path.
  function findNCtx(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 3) return null;
    if (typeof obj.n_ctx === 'number' && obj.n_ctx > 0) return obj.n_ctx;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === 'object') {
        const found = findNCtx(v, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  async function fetchServerNCtx() {
    const base = (settings.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    if (base === serverPropsBase && serverNCtx) return;
    const root = base.replace(/\/v1$/, '');
    try {
      const r = await fetch(root + '/props');
      if (!r.ok) return;
      const j = await r.json();
      const n = findNCtx(j);
      serverPropsBase = base;
      if (n) { serverNCtx = n; renderContextBar(); }
    } catch { /* not llama.cpp, or server doesn't expose /props — degrade gracefully */ }
  }

  function formatTokenCount(n) {
    return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K' : String(n);
  }

  function renderContextBar() {
    if (sessionContextTokens == null) { ctxRow.classList.add('hidden'); return; }
    ctxRow.classList.remove('hidden');
    if (serverNCtx) {
      const pct = Math.min(100, Math.round(sessionContextTokens / serverNCtx * 100));
      ctxFill.style.width = pct + '%';
      ctxFill.classList.toggle('warn', pct >= 75 && pct < 90);
      ctxFill.classList.toggle('danger', pct >= 90);
      ctxText.textContent = formatTokenCount(sessionContextTokens) + ' / ' + formatTokenCount(serverNCtx) + ' · ' + pct + '%';
    } else {
      ctxFill.style.width = '0%';
      ctxFill.classList.remove('warn', 'danger');
      ctxText.textContent = tr('ctxTokensSuffix', { n: formatTokenCount(sessionContextTokens) });
    }
  }

  // sessionContextTokens tracks only the currently-open session; switching or
  // reloading a session clears it until its next exchange reports fresh usage.
  function resetContextUsage() {
    sessionContextTokens = null;
    renderContextBar();
  }

  // Text for the small per-round usage note (see runCompletionRound, which
  // owns its element and keeps it updated live as tokens stream in).
  // completion_tokens covers everything the model generated for the round
  // (visible content, reasoning, and tool-call argument JSON alike), since
  // llama.cpp/OpenAI usage accounting doesn't split those out.
  function usageLiveText(n) {
    return tr('usageLive', { n: n.toLocaleString() });
  }
  function usageFinalText(usage, liveTokens) {
    const parts = [];
    if (typeof usage?.prompt_tokens === 'number') parts.push(tr('usagePromptPart', { n: usage.prompt_tokens.toLocaleString() }));
    if (typeof usage?.completion_tokens === 'number') parts.push(tr('usageCompletionPart', { n: usage.completion_tokens.toLocaleString() }));
    if (parts.length) return parts.join(' · ');
    return tr('usageFinalEstimate', { n: liveTokens.toLocaleString() });   // server never reported usage — keep the live estimate
  }

  // Moves a round's (already-live-updating) usage note to the end of the
  // message list — needed for tool-call rounds, where the note is created
  // and starts updating mid-stream (before the round's tool-call/result
  // bubbles exist yet), so by the time handleToolCalls appends those it
  // would otherwise sit above them instead of summarizing after them — and
  // refreshes the header context-progress bar from the round's usage.
  function finalizeUsageNote(result) {
    if (result.usageEl) {
      const wasNearBottom = isScrolledNearBottom();
      messagesEl.appendChild(result.usageEl);
      if (wasNearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    const usage = result.usage;
    if (!usage) return;
    if (typeof usage.total_tokens === 'number') sessionContextTokens = usage.total_tokens;
    else if (typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number') {
      sessionContextTokens = usage.prompt_tokens + usage.completion_tokens;
    }
    renderContextBar();
  }

  // ---- connection ---------------------------------------------------------
  async function ping() {
    if (controller) return;                  // busy state owns the dot
    const base = (settings.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    try {
      const r = await fetch(base + '/models');
      dot.className = r.ok ? 'on' : '';
      if (r.ok) {
        const j = await r.json();
        const id = j?.data?.[0]?.id;
        if (id && id !== detectedModel) { detectedModel = id; renderEndpoint(); }
        fetchServerNCtx();   // no-ops once cached for the current baseUrl
      }
    } catch {
        dot.className = '';
        detectedModel = '';
        renderEndpoint();
    }
  }

  // ---- send / stop --------------------------------------------------------
  function setBusy(busy) {
    if (busy) {
      actionIcon.innerHTML = STOP_ICON;
      actionBtn.classList.add('stopping');
      actionBtn.title = tr('titleStop');
      dot.className = 'busy';
    } else {
      actionIcon.innerHTML = SEND_ICON;
      actionBtn.classList.remove('stopping');
      actionBtn.title = tr('titleSend');
      ping();
    }
  }

  function stop() {
    if (pendingConfirmResolve) pendingConfirmResolve(false);
    if (controller) { controller.abort(); controller = null; }
  }

  // Built-ins stay raw (only 4, not worth lazy-loading). MCP tools are gated
  // behind tool_search: only schemas the model has already discovered via a
  // search in this session are included, so an unused MCP server's schemas
  // never bloat every single request. Turning tool_search off in Settings
  // falls back to the old eager behavior (every enabled MCP schema, always).
  function enabledToolSpecs(s) {
    const specs = TOOL_DEFS
      .filter(t => t.name !== 'tool_search' && settings.tools?.[t.name]?.enabled)
      .map(t => t.schema);
    const enabledMcp = mcpTools.filter(t => settings.tools?.[t.name]?.enabled);
    if (enabledMcp.length) {
      if (settings.tools?.tool_search?.enabled) {
        specs.push(TOOL_DEFS.find(t => t.name === 'tool_search').schema);
        const active = activeToolSetFor(s.id);
        for (const t of enabledMcp) if (active.has(t.name)) specs.push(t.schema);
      } else {
        specs.push(...enabledMcp.map(t => t.schema));
      }
    }
    return specs;
  }

  // get_datetime and tool_search need no filesystem access, so they run
  // directly here; the rest are dispatched to main.js over IPC (see
  // preload.js's runTool).
  async function execTool(name, argsObj, sessionId) {
    if (name === 'get_datetime') {
      const now = new Date();
      return { ok: true, iso: now.toISOString(), local: now.toString() };
    }
    if (name === 'tool_search') {
      const results = searchMcpTools(argsObj?.query || '');
      const active = activeToolSetFor(sessionId);
      results.forEach(r => active.add(r.name));
      return {
        ok: true,
        results: results.map(r => ({ name: r.name, description: r.schema.function.description })),
        available_mcp_servers: availableMcpServers(),
        note: results.length ? undefined : '일치하는 도구를 찾지 못했습니다. available_mcp_servers에 관련 서버가 있는지 먼저 확인하고, 있다면 그 서버 이름이나 다른 키워드로 다시 검색하세요.'
      };
    }
    if (name === 'read_skill') {
      const entry = enabledSkillList().find(s => s.name === (argsObj?.name || ''));
      if (!entry) return { ok: false, error: '해당 이름의 스킬을 찾을 수 없습니다: ' + (argsObj?.name || '') };
      const relPath = argsObj?.path;
      if (relPath) {
        const res = await window.host.getSkillFile(entry.id, relPath);
        if (!res?.ok) return { ok: false, error: res?.error || '참조 파일을 불러오지 못했습니다: ' + relPath };
        return { ok: true, name: entry.name, path: relPath, content: res.content };
      }
      const skill = await window.host.getSkill(entry.id);
      if (!skill) return { ok: false, error: '스킬을 불러오지 못했습니다: ' + entry.name };
      return {
        ok: true,
        name: skill.name,
        content: skill.body,
        files: skill.files && skill.files.length ? skill.files : undefined
      };
    }
    return window.host.runTool(name, argsObj);
  }

  // Some local models fall back to writing their own text-based tool-call
  // dialect (tag/XML-style function-call syntax) as plain content instead of
  // using the request's actual tool_calls channel — usually when the
  // server's chat-template/parser doesn't fully match how the model was
  // fine-tuned. That's primarily a server/template config problem, but a
  // blunt reminder here costs a couple dozen tokens and can bias a model
  // away from that fallback in borderline cases, so it's worth keeping.
  // Deliberately not showing the exact bad syntax verbatim — small models
  // tend to imitate a pattern shown in "don't do this" examples too.
  const TOOL_CALL_FORMAT_REMINDER = '도구가 필요하면 반드시 제공된 function-calling 메커니즘(tool_calls)으로만 호출하세요. 함수 호출 구문이나 태그를 답변 텍스트 안에 직접 적지 마세요 — 그건 실행되지 않고 사용자에게 그대로 텍스트로 보일 뿐입니다.';

  // The system prompt lives in settings (applies to every session), not in
  // session.messages, so it's prepended here at request time rather than
  // being stored/replayed as part of the conversation history.
  function apiMessages(s, toolsActive) {
    const msgs = s.messages.map(m => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
      if (m.role === 'assistant' && m.tool_calls) return { role: 'assistant', content: m.content || null, tool_calls: m.tool_calls };
      return { role: m.role, content: m.content };
    });
    const parts = [];
    const preset = s.presetId ? presetList.find(p => p.id === s.presetId) : null;
    const sys = (preset ? preset.prompt : settings.systemPrompt || '').trim();
    if (sys) parts.push(sys);
    if (toolsActive) parts.push(TOOL_CALL_FORMAT_REMINDER);
    // Lightweight, always-present skill index — only name+description, not
    // each skill's full body. The model loads a skill's actual instructions
    // on demand via read_skill only when one looks relevant, so having many
    // skills costs a few lines here rather than bloating every request.
    const activeSkills = settings.tools?.read_skill?.enabled ? enabledSkillList() : [];
    if (activeSkills.length) {
      const lines = activeSkills.map(sk => `- ${sk.name}: ${sk.description}`).join('\n');
      parts.push(`사용 가능한 스킬 목록 (관련 있어 보이면 read_skill로 전체 지침을 불러오세요):\n${lines}`);
    }
    return parts.length ? [{ role: 'system', content: parts.join('\n\n') }, ...msgs] : msgs;
  }

  // Streams one chat-completion request and accumulates both plain content and
  // any tool_calls the model asks for. Returns without touching s.messages —
  // the caller decides what to do with the result.
  async function runCompletionRound(s) {
    const target = bubbleFor('assistant', '');
    let full = '';
    const toolCallsAcc = [];
    let finishReason = null;
    let reasoningEl = null;
    let reasoningStart = null;
    let reasoning = '';
    let usage = null;
    let usageEl = null;
    let liveTokens = 0;   // approx: llama.cpp emits one SSE chunk per sampled token, so counting chunks is a live stand-in until the real usage totals arrive

    const base = (settings.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    const tools = enabledToolSpecs(s);
    const body = {
      model: (settings.model || '').trim() || 'local',
      stream: true,
      temperature: 0.7,
      max_tokens: settings.maxTokens || DEFAULT_MAX_TOKENS,
      stream_options: { include_usage: true },   // asks for a trailing usage chunk (OpenAI-style); ignored harmlessly if the server doesn't support it
      messages: apiMessages(s, tools.length > 0)
    };
    if (tools.length) body.tools = tools;

    try {
      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!res.ok || !res.body) {
        // The server responded (it's alive) but rejected this generation —
        // e.g. llama.cpp failed to parse the model's own tool-call output as
        // JSON. That's a model/generation hiccup, not a dead connection, so
        // report it as a bad round (see isBadRound) rather than connectionError
        // — runCompletionRoundWithRetry will silently retry it like any other
        // malformed tool-call round instead of giving up immediately.
        let detail = 'HTTP ' + res.status;
        try { const j = await res.json(); if (j?.error?.message) detail = j.error.message; } catch { /* body not JSON */ }
        return { target, content: full, toolCalls: [], finishReason, aborted: false, usage, usageEl, serverError: true, detail };
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            const choice = j.choices?.[0];
            const delta = choice?.delta || {};
            // Measured once, before any DOM mutation below — checking after
            // would include the just-added/just-grown content in the distance
            // calculation, which can push it past the near-bottom threshold
            // even though the user was sitting right at the bottom.
            const wasNearBottom = isScrolledNearBottom();
            const reasoningDelta = delta.reasoning_content || delta.reasoning;
            if (reasoningDelta) {
              if (!reasoningEl) {
                reasoningEl = reasoningBubble();
                messagesEl.insertBefore(reasoningEl, target);
                reasoningStart = Date.now();
              }
              reasoning += reasoningDelta;
              setReasoningBody(reasoningEl, reasoning);
              if (wasNearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
            }
            if (delta.content) {
              if (reasoningEl) finalizeReasoning(reasoningEl, reasoningStart);
              full += delta.content;
              setMsgContent(target, full);
              if (wasNearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
            }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallsAcc[idx]) toolCallsAcc[idx] = { id: '', name: '', arguments: '' };
                if (tc.id) toolCallsAcc[idx].id = tc.id;
                if (tc.function?.name) toolCallsAcc[idx].name += tc.function.name;
                if (tc.function?.arguments) toolCallsAcc[idx].arguments += tc.function.arguments;
              }
            }
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            if (j.usage) usage = j.usage;

            if (reasoningDelta || delta.content || delta.tool_calls) {
              liveTokens++;
              if (!usageEl) {
                usageEl = document.createElement('div');
                usageEl.className = 'msg usage';
                messagesEl.appendChild(usageEl);
              }
              usageEl.textContent = usageLiveText(liveTokens);
              if (wasNearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
            }
          } catch { /* partial chunk */ }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        if (reasoningEl) finalizeReasoning(reasoningEl, reasoningStart);
        if (usageEl) usageEl.textContent = usageFinalText(usage, liveTokens);
        return { target, content: full, toolCalls: [], finishReason, aborted: true, usage, usageEl };
      }
      target.remove();
      if (usageEl) usageEl.remove();
      const n = document.createElement('div');
      n.className = 'msg note';
      n.textContent = tr('connectionFailed', { base });
      messagesEl.appendChild(n);
      autoScrollMessages(true);
      return { connectionError: true };
    }

    if (reasoningEl) finalizeReasoning(reasoningEl, reasoningStart);
    if (usageEl) usageEl.textContent = usageFinalText(usage, liveTokens);

    // A slot with no name means the stream was cut before the tool name ever
    // arrived (dropped connection, server error mid-generation) — drop it here
    // rather than letting a nameless tool_call get committed to session
    // history, where every future request would resend it and could make
    // llama-server reject/mishandle the whole conversation from then on.
    const toolCalls = toolCallsAcc.filter(tc => tc && tc.name).map((tc, i) => ({
      id: tc.id || ('call_' + Date.now().toString(36) + i),
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments }
    }));

    return { target, content: full, toolCalls, finishReason, aborted: false, usage, usageEl };
  }

  // Records the assistant's tool_calls turn, then runs (or asks approval for)
  // each call and appends its result. Returns false if the user aborted
  // (Stop, or denying a confirmation prompt via Stop) partway through.
  async function handleToolCalls(s, result) {
    if (result.content) setMsgContent(result.target, result.content);
    else result.target.remove();
    const assistantMsg = { role: 'assistant', content: result.content || null, tool_calls: result.toolCalls };
    s.messages.push(assistantMsg);
    window.host.appendMessage(s.id, assistantMsg);
    touchSession(s);

    for (const tc of result.toolCalls) {
      let argsObj = {};
      let argsParseError = false;
      try { argsObj = JSON.parse(tc.function.arguments || '{}'); } catch { argsParseError = true; }

      toolBubble(formatCall(tc.function.name, tc.function.arguments));

      const def = findToolDef(tc.function.name);
      const cfg = settings.tools?.[tc.function.name];
      let toolResult;
      if (!def || !cfg?.enabled) {
        toolResult = { ok: false, error: tr('toolDisabled') };
      } else if (argsParseError) {
        // isBadRound()/runCompletionRoundWithRetry() already gave this round
        // a couple of silent re-tries at the completion level; if the model
        // still produced unparseable (often truncated) argument JSON after
        // that, running the tool with a silently-substituted `{}` would feed
        // it a misleading "field required" error instead of the real cause.
        // Telling it plainly that its own JSON was broken gives it something
        // it can actually act on next round.
        toolResult = { ok: false, error: tr('badArgsJson') };
      } else {
        let proceed = true;
        if (!cfg.alwaysAllow) proceed = await confirmToolCall(tc.function.name, argsObj);
        if (!controller) return false;   // aborted while awaiting approval
        toolResult = proceed
          ? await execTool(tc.function.name, argsObj, s.id).catch(e => ({ ok: false, error: String(e?.message || e) }))
          : { ok: false, error: tr('userDenied') };
      }

      toolBubble(formatResult(tc.function.name, JSON.stringify(toolResult)));
      const toolMsg = { role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) };
      s.messages.push(toolMsg);
      window.host.appendMessage(s.id, toolMsg);
      touchSession(s);
    }
    return true;
  }

  // Partial output is kept on abort: it's usually still useful, and dropping
  // text the user already read is more confusing than marking it cut short.
  function finalizeAbort(s, result) {
    if (result.content) {
      setMsgContent(result.target, result.content);
      const msg = { role: 'assistant', content: result.content };
      s.messages.push(msg);
      window.host.appendMessage(s.id, msg);
      const n = document.createElement('div');
      n.className = 'msg note';
      n.textContent = tr('stoppedNote');
      messagesEl.appendChild(n);
    } else {
      result.target.remove();
      if (result.usageEl) result.usageEl.remove();
      // Only the very first round (no tool activity yet) leaves an orphaned
      // user turn with nothing else attached; later rounds have real history.
      if (s.messages[s.messages.length - 1]?.role === 'user') {
        s.messages.pop();
        window.host.deleteLastMessage(s.id);
        renderMessages();
      }
    }
  }

  // True for a round that produced nothing usable: no visible text and no
  // (validly-named, validly-JSON'd) tool call. Local/quantized models
  // occasionally drop mid-stream or emit truncated tool-call argument JSON —
  // that's a transient hiccup worth retrying rather than a deliberate empty
  // answer, so send() retries a few times before accepting it as final.
  function isBadRound(result) {
    if (result.serverError) return true;
    if (result.toolCalls.length) {
      return result.toolCalls.some(tc => {
        try { JSON.parse(tc.function.arguments || '{}'); return false; }
        catch { return true; }
      });
    }
    return !result.content.trim();
  }

  async function runCompletionRoundWithRetry(s) {
    let result = await runCompletionRound(s);
    let attempt = 0;
    while (!result.connectionError && !result.aborted && isBadRound(result) && attempt < MAX_ROUND_RETRIES) {
      result.target.remove();
      if (result.usageEl) result.usageEl.remove();
      attempt++;
      result = await runCompletionRound(s);
    }
    return result;
  }

  function finalizeFinal(s, result) {
    const finalText = result.content || tr('emptyResponse');
    setMsgContent(result.target, finalText);
    const msg = { role: 'assistant', content: finalText };
    s.messages.push(msg);
    window.host.appendMessage(s.id, msg);
  }

  async function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    const s = activeSession();

    s.messages.push({ role: 'user', content: text });
    window.host.appendMessage(s.id, { role: 'user', content: text });
    touchSession(s);
    retitle(s);
    bubbleFor('user', text);
    autoScrollMessages(true);
    inputEl.value = ''; autoResize();
    renderSessions();

    controller = new AbortController();
    setBusy(true);

    const maxToolRounds = settings.maxToolRounds || DEFAULT_MAX_TOOL_ROUNDS;
    let outcome = 'cap';
    for (let round = 0; round < maxToolRounds; round++) {
      const result = await runCompletionRoundWithRetry(s);
      if (result.connectionError) { controller = null; setBusy(false); return; }
      if (result.serverError) {
        result.target.remove();
        if (result.usageEl) result.usageEl.remove();
        const n = document.createElement('div');
        n.className = 'msg note';
        n.textContent = tr('serverErrorNote', { detail: result.detail || tr('httpErrorFallback') });
        messagesEl.appendChild(n);
        autoScrollMessages(true);
        controller = null; setBusy(false); return;
      }
      if (result.aborted) { finalizeAbort(s, result); outcome = 'aborted'; break; }
      if (result.toolCalls.length) {
        const proceeded = await handleToolCalls(s, result);
        finalizeUsageNote(result);
        if (!proceeded) {
          // handleToolCalls already committed the assistant turn to s.messages;
          // just reflect the stop in the visible transcript.
          if (result.content) {
            const n = document.createElement('div');
            n.className = 'msg note';
            n.textContent = tr('stoppedNote');
            messagesEl.appendChild(n);
          } else {
            result.target.remove();
          }
          outcome = 'aborted';
          break;
        }
        continue;
      }
      finalizeFinal(s, result);
      finalizeUsageNote(result);
      outcome = 'done';
      break;
    }

    if (outcome === 'cap') {
      const n = document.createElement('div');
      n.className = 'msg note';
      n.textContent = tr('toolRoundCapNote', { n: maxToolRounds });
      messagesEl.appendChild(n);
    }

    controller = null;
    setBusy(false);
    touchSession(s);
    renderSessions();
    autoScrollMessages();
  }

  function autoResize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 110) + 'px';
    inputEl.style.overflowY = inputEl.scrollHeight > 110 ? 'auto' : 'hidden';
  }

  // ---- bubble position, drag & panel placement ----------------------------
  function clampBubble(left, top) {
    const maxL = Math.max(MARGIN, window.innerWidth - BUBBLE - MARGIN);
    const maxT = Math.max(MARGIN, window.innerHeight - BUBBLE - MARGIN);
    return {
      left: Math.max(MARGIN, Math.min(left, maxL)),
      top: Math.max(MARGIN, Math.min(top, maxT))
    };
  }

  function setBubblePos(left, top) {
    const c = clampBubble(left, top);
    bubbleLeft = c.left; bubbleTop = c.top;
    bubble.style.left = c.left + 'px';
    bubble.style.top = c.top + 'px';
    if (isOpen) positionPanel();
  }

  // The panel opens toward whichever corner the bubble sits away from: a bubble
  // in the top-left opens down-right, one in the bottom-right opens up-left, and
  // so on. It's anchored at the corner nearest the bubble and grows away from
  // it, so resizing (from the far corner) keeps that anchor fixed.
  function positionPanel() {
    const w = window.innerWidth, h = window.innerHeight;
    const pw = Math.max(PANEL_MIN_W, Math.min(panelW, w - MARGIN * 2));
    const ph = Math.max(PANEL_MIN_H, Math.min(panelH, h - MARGIN * 2));
    panel.style.width = pw + 'px';
    panel.style.height = ph + 'px';

    const cx = bubbleLeft + BUBBLE / 2;
    const cy = bubbleTop + BUBBLE / 2;

    let left, originX;
    if (cx < w / 2) { left = bubbleLeft + BUBBLE + GAP; originX = 'left'; }
    else            { left = bubbleLeft - GAP - pw; originX = 'right'; }

    let top, originY;
    if (cy < h / 2) { top = bubbleTop; originY = 'top'; }
    else            { top = bubbleTop + BUBBLE - ph; originY = 'bottom'; }

    left = Math.max(MARGIN, Math.min(left, w - pw - MARGIN));
    top = Math.max(MARGIN, Math.min(top, h - ph - MARGIN));

    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.transformOrigin = originY + ' ' + originX;

    // Put the resize grip on the growth corner (the one away from the bubble).
    curOriginX = originX; curOriginY = originY;
    resizeHandle.style.left   = originX === 'right'  ? '0' : 'auto';
    resizeHandle.style.right  = originX === 'left'   ? '0' : 'auto';
    resizeHandle.style.top    = originY === 'bottom' ? '0' : 'auto';
    resizeHandle.style.bottom = originY === 'top'    ? '0' : 'auto';
    resizeHandle.style.cursor =
      (originX === 'left') === (originY === 'top') ? 'nwse-resize' : 'nesw-resize';
  }

  function toggleOpen(forceClose) {
    isOpen = forceClose ? false : !isOpen;
    if (isOpen) positionPanel();
    panel.classList.toggle('open', isOpen);
    if (isOpen) { ping(); inputEl.focus(); }
    else { sessionsEl.classList.remove('open'); }
    // The panel's bounds just shrank/grew; the cursor may now sit in what used
    // to be (or has become) dead space. Re-run the hit test immediately rather
    // than waiting for the next mousemove, or clicks/scrolls there get eaten
    // by the click-through window until the cursor happens to move again.
    syncClickThrough();
  }

  // Stored as a fraction of the window so it survives resolution changes.
  function saveBubblePos() {
    const bubblePos = {
      xf: (bubbleLeft + BUBBLE / 2) / window.innerWidth,
      yf: (bubbleTop + BUBBLE / 2) / window.innerHeight
    };
    settings.bubble = bubblePos;
    window.host.updateSettings({ bubble: bubblePos });
  }

  function restoreBubblePos() {
    const b = settings.bubble;
    if (b && typeof b.xf === 'number') {
      setBubblePos(b.xf * window.innerWidth - BUBBLE / 2,
                   b.yf * window.innerHeight - BUBBLE / 2);
    } else {
      setBubblePos(window.innerWidth - BUBBLE - MARGIN,   // default: bottom-right
                   window.innerHeight - BUBBLE - MARGIN);
    }
  }

  // Drag with a small threshold, so a plain click still just toggles the panel.
  let grabDX = 0, grabDY = 0, downX = 0, downY = 0;
  bubble.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true; dragMoved = false;
    downX = e.clientX; downY = e.clientY;
    grabDX = e.clientX - bubbleLeft;
    grabDY = e.clientY - bubbleTop;
    bubble.setPointerCapture(e.pointerId);
    ignoring = false; window.host.setIgnoreMouse(false);   // stay interactive while dragging
  });
  bubble.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (!dragMoved && Math.hypot(e.clientX - downX, e.clientY - downY) < DRAG_THRESHOLD) return;
    dragMoved = true;
    bubble.classList.add('dragging');
    setBubblePos(e.clientX - grabDX, e.clientY - grabDY);
  });
  bubble.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    bubble.classList.remove('dragging');
    try { bubble.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (dragMoved) saveBubblePos();
    else toggleOpen();
  });

  function savePanelSize() {
    const panelSize = { w: panelW, h: panelH };
    settings.panel = panelSize;
    window.host.updateSettings({ panel: panelSize });
  }
  function restorePanelSize() {
    const p = settings.panel;
    if (p && p.w && p.h) { panelW = p.w; panelH = p.h; }
  }

  // Resize from the growth corner: the bubble-side corner stays anchored, so we
  // just grow width/height in whichever direction that corner faces.
  let rStartX = 0, rStartY = 0, rStartW = 0, rStartH = 0;
  resizeHandle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    resizing = true;
    rStartX = e.clientX; rStartY = e.clientY;
    rStartW = panelW; rStartH = panelH;
    resizeHandle.setPointerCapture(e.pointerId);
    ignoring = false; window.host.setIgnoreMouse(false);
  });
  resizeHandle.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    let dx = e.clientX - rStartX, dy = e.clientY - rStartY;
    if (curOriginX === 'right')  dx = -dx;   // anchored on the right → grows leftward
    if (curOriginY === 'bottom') dy = -dy;   // anchored on the bottom → grows upward
    panelW = Math.max(PANEL_MIN_W, Math.min(rStartW + dx, window.innerWidth - MARGIN * 2));
    panelH = Math.max(PANEL_MIN_H, Math.min(rStartH + dy, window.innerHeight - MARGIN * 2));
    positionPanel();
  });
  resizeHandle.addEventListener('pointerup', (e) => {
    if (!resizing) return;
    resizing = false;
    try { resizeHandle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    savePanelSize();
  });

  // ---- click-through hit testing -------------------------------------------
  // The window spans the whole work area. Only the bubble (and the panel when
  // open) should intercept the mouse; everything else falls through to whatever
  // is behind it on the desktop.
  function hitTest(x, y) {
    const targets = isOpen ? [bubble, panel] : [bubble];
    return targets.some(el => {
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
  }
  let ignoring = true;
  let lastMouseX = -1, lastMouseY = -1;
  function syncClickThrough() {
    if (dragging || resizing) return;          // never toggle click-through mid-drag/resize
    const over = hitTest(lastMouseX, lastMouseY);
    if (over === ignoring) {
      ignoring = !over;
      window.host.setIgnoreMouse(ignoring);
    }
  }
  document.addEventListener('mousemove', (e) => {
    lastMouseX = e.clientX; lastMouseY = e.clientY;
    syncClickThrough();
  });

  // ---- events -------------------------------------------------------------
  // The bubble is toggled from its pointerup handler (a tap), so it can also be
  // dragged; see the drag section above.
  closeBtn.addEventListener('click', () => toggleOpen(true));
  sessionsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    sessionsEl.classList.toggle('open');
    sessionsBtn.classList.toggle('active', sessionsEl.classList.contains('open'));
    if (sessionsEl.classList.contains('open')) renderSessions();
  });
  // Clicking anywhere else in the panel (the window never loses OS focus for
  // this, so onWindowBlur doesn't fire) closes the recent-sessions dropdown.
  document.addEventListener('click', (e) => {
    if (!sessionsEl.classList.contains('open')) return;
    if (e.target.closest('#sessions') || e.target.closest('#sessions-btn')) return;
    sessionsEl.classList.remove('open');
    sessionsBtn.classList.remove('active');
  });
  settingsBtn.addEventListener('click', () => window.host.openSettings());
  actionBtn.addEventListener('click', () => { controller ? stop() : send(); });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); controller ? stop() : send(); }
    if (e.key === 'Escape') { if (controller) stop(); }
  });
  inputEl.addEventListener('input', autoResize);

  // Keep the bubble (and any open panel) on screen when the work area changes.
  window.addEventListener('resize', () => { setBubblePos(bubbleLeft, bubbleTop); });

  // Tray "Reset position" drops the bubble back to the bottom-right corner.
  if (window.host.onResetBubble) {
    window.host.onResetBubble(() => {
      setBubblePos(window.innerWidth - BUBBLE - MARGIN, window.innerHeight - BUBBLE - MARGIN);
      saveBubblePos();
    });
  }

  // Clicking outside the window (or opening the settings/session-manager
  // window, which steals OS focus) hands focus to whatever's underneath,
  // which fires this — treat it as "clicked outside" and collapse the panel.
  if (window.host.onWindowBlur) {
    window.host.onWindowBlur(() => {
      if (isOpen) toggleOpen(true);
    });
  }

  // Settings/session-manager windows steal focus while open (triggering the
  // auto-collapse above); reopen the panel once they close instead of leaving
  // just the bubble behind.
  if (window.host.onOpenPanel) {
    window.host.onOpenPanel(() => {
      if (!isOpen) toggleOpen();
    });
  }

  // Settings/session-manager windows write through the same store; refresh
  // just the slice of state a given change actually touched.
  if (window.host.onStoreChanged) {
    window.host.onStoreChanged(async (info) => {
      if (info?.scope === 'preset') {
        presetList = await window.host.listPresets();
        renderPresetSelect();
        return;
      }
      if (info?.scope === 'skill') {
        skillList = await window.host.listSkills();
        return;
      }
      if (info?.scope === 'settings') {
        const prevActiveId = settings.activeId;
        const prevLang = settings.language;
        settings = await window.host.getSettings();
        document.documentElement.style.setProperty('--font-scale', settings.fontScale || 1);
        const langChanged = (settings.language || 'ko') !== (prevLang || 'ko');
        if (langChanged) {
          window.I18N.setLang(settings.language || 'ko');
          window.I18N.applyDom(document);
        }
        renderEndpoint();
        fetchServerNCtx();
        await refreshMcpTools();
        if (settings.activeId !== prevActiveId) {
          session = await window.host.getSession(settings.activeId);
          resetContextUsage();
        }
        if (settings.activeId !== prevActiveId || langChanged) {
          renderSessions();
          renderMessages();
          renderPresetSelect();
        }
        return;
      }
      sessionList = await window.host.listSessions();
      if (info?.id && info.id === settings.activeId) {
        session = await window.host.getSession(settings.activeId);
        resetContextUsage();
        renderMessages();
        renderPresetSelect();
      }
      renderSessions();
    });
  }

  // ---- init ---------------------------------------------------------------
  (async () => {
    await load();
    restorePanelSize();
    restoreBubblePos();
    renderEndpoint();
    renderSessions();
    renderMessages();
    renderPresetSelect();
    autoResize();
    ping();
    setInterval(ping, 30000);
    refreshMcpTools().catch(e => console.error('MCP tool list refresh failed:', e));
  })();
})();
