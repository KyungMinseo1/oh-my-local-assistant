(() => {
  const $ = (id) => document.getElementById(id);
  const t = window.I18N.t;

  const closeBtn = $('close-btn');
  const maximizeBtn = $('maximize-btn'), titlebarEl = $('titlebar');
  const allListEl = $('all-list'), newSessionAllEl = $('new-session-all');
  const newProjectNameInput = $('new-project-name'), addProjectBtn = $('add-project-btn'), groupsEl = $('project-groups');

  // Metadata-only session list ({id, title, created, updated, projectId}) —
  // this window never touches message content, so it never fetches it.
  let sessions = [];
  let projects = [];
  let activeId = null;

  // ---- session row (shared by both tabs) -----------------------------------
  // Clicking the row switches the active session but leaves this window open,
  // so the user can keep organizing/switching without reopening it.
  function renderSessionRow(container, s, opts = {}) {
    const row = document.createElement('div');
    row.className = 'session-row' + (s.id === activeId ? ' active' : '');
    row.innerHTML = `<span class="name"></span><span class="meta"></span>`;
    row.querySelector('.name').textContent = s.title;
    row.querySelector('.meta').textContent = window.I18N.timeAgo(s.updated);

    if (opts.showProjectSelect) {
      const sel = document.createElement('select');
      sel.className = 'proj-select';
      const optNone = document.createElement('option');
      optNone.value = ''; optNone.textContent = t('unclassified');
      sel.appendChild(optNone);
      projects.forEach(p => {
        const o = document.createElement('option');
        o.value = p.id; o.textContent = p.name;
        sel.appendChild(o);
      });
      sel.value = s.projectId || '';
      sel.addEventListener('change', () => {
        s.projectId = sel.value || null;
        window.host.setSessionProject(s.id, s.projectId);
        renderProjects();
      });
      row.appendChild(sel);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'del';
    delBtn.title = t('delete');
    delBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteSession(s.id); });
    row.appendChild(delBtn);

    row.addEventListener('click', (e) => {
      if (e.target.closest('.del') || e.target.closest('select')) return;
      selectSession(s.id);
    });

    // Double-click: switch to the session and jump straight back to the
    // conversation, rather than leaving the user in the manager window.
    row.addEventListener('dblclick', (e) => {
      if (e.target.closest('.del') || e.target.closest('select')) return;
      selectSession(s.id);
      window.close();
    });

    container.appendChild(row);
  }

  // ---- tab: 전체 --------------------------------------------------------
  function renderAll() {
    allListEl.innerHTML = '';
    const sorted = [...sessions].sort((a, b) => b.updated - a.updated);
    if (!sorted.length) {
      const e = document.createElement('div');
      e.className = 'project-empty';
      e.textContent = t('noSessions');
      allListEl.appendChild(e);
      return;
    }
    sorted.forEach(s => renderSessionRow(allListEl, s));
  }

  // ---- tab: 프로젝트 ------------------------------------------------------
  function renderProjectGroup(name, sessionsInGroup, onDelete) {
    const group = document.createElement('div');
    group.className = 'project-group';
    const header = document.createElement('div');
    header.className = 'project-header';
    header.innerHTML = `<span class="pname"></span><span class="count"></span>`;
    header.querySelector('.pname').textContent = name;
    header.querySelector('.count').textContent = t('countSuffix', { n: sessionsInGroup.length });
    if (onDelete) {
      const del = document.createElement('button');
      del.className = 'del-project';
      del.title = t('deleteProjectTitle');
      del.innerHTML = '<svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
      del.addEventListener('click', onDelete);
      header.appendChild(del);
    }
    group.appendChild(header);
    if (!sessionsInGroup.length) {
      const e = document.createElement('div');
      e.className = 'project-empty';
      e.textContent = t('noneInGroup');
      group.appendChild(e);
    } else {
      sessionsInGroup.forEach(s => renderSessionRow(group, s, { showProjectSelect: true }));
    }
    return group;
  }

  function renderProjects() {
    groupsEl.innerHTML = '';
    projects.forEach(p => {
      const inGroup = sessions.filter(s => s.projectId === p.id).sort((a, b) => b.updated - a.updated);
      groupsEl.appendChild(renderProjectGroup(p.name, inGroup, () => deleteProject(p.id)));
    });
    // Sessions with no projectId, or one pointing at a project that no longer
    // exists (deleteProject already clears this, but stays defensive).
    const knownIds = new Set(projects.map(p => p.id));
    const unclassified = sessions
      .filter(s => !s.projectId || !knownIds.has(s.projectId))
      .sort((a, b) => b.updated - a.updated);
    groupsEl.appendChild(renderProjectGroup(t('unclassified'), unclassified, null));
  }

  // ---- mutations --------------------------------------------------------
  function selectSession(id) {
    activeId = id;
    window.host.setActiveSession(id);
    renderAll(); renderProjects();
  }

  async function newSession() {
    const s = await window.host.createSession();
    sessions.unshift({ id: s.id, title: s.title, created: s.created, updated: s.updated, projectId: s.projectId });
    activeId = s.id;
    renderAll(); renderProjects();
  }

  async function deleteSession(id) {
    const { activeId: newActiveId } = await window.host.deleteSession(id);
    sessions = sessions.filter(s => s.id !== id);
    if (!sessions.length) sessions = await window.host.listSessions();   // deleteSession() created a fresh one server-side
    activeId = newActiveId;
    renderAll(); renderProjects();
  }

  async function addProject() {
    const name = newProjectNameInput.value.trim();
    if (!name) return;
    const p = await window.host.createProject(name);
    projects.push(p);
    newProjectNameInput.value = '';
    renderProjects();
  }

  // Non-destructive: sessions inside just lose their projectId (move to
  // 미분류) instead of being deleted along with the project.
  async function deleteProject(id) {
    await window.host.deleteProject(id);
    projects = projects.filter(p => p.id !== id);
    sessions.forEach(s => { if (s.projectId === id) s.projectId = null; });
    renderProjects();
  }

  // ---- tabs ---------------------------------------------------------------
  const tabBtns = [...document.querySelectorAll('.tab-btn')];
  const tabPanes = [...document.querySelectorAll('.tab-pane')];
  function showTab(tab) {
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    tabPanes.forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
  }
  tabBtns.forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ---- events ---------------------------------------------------------------
  newSessionAllEl.addEventListener('click', newSession);
  addProjectBtn.addEventListener('click', addProject);
  newProjectNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addProject(); });
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

  async function load() {
    const [settings, sessionList, projectList] = await Promise.all([
      window.host.getSettings(), window.host.listSessions(), window.host.listProjects()
    ]);
    activeId = settings.activeId;
    sessions = sessionList;
    projects = projectList;
    window.I18N.setLang(settings.language || 'ko');
    window.I18N.applyDom(document);
    document.documentElement.style.setProperty('--font-scale', settings.fontScale || 1);
  }

  // Picks up changes made elsewhere (e.g. a session deleted from the main
  // widget's inline drawer, or the language changed in the settings window)
  // while this window is left open.
  if (window.host.onStoreChanged) {
    window.host.onStoreChanged(async () => {
      await load();
      renderAll(); renderProjects();
    });
  }

  // ---- init ---------------------------------------------------------------
  (async () => {
    await load();
    renderAll();
    renderProjects();
  })();
})();
