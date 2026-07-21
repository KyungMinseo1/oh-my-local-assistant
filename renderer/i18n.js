// Shared translation table + tiny runtime, loaded (unchanged) by all three
// renderer windows before their own script. Static markup opts in via
// data-i18n[-title|-placeholder] attributes (see applyDom); each window's JS
// calls setLang() once settings are loaded and re-renders its own dynamic
// text (message bubbles, status lines, etc.) using t().
(() => {
  const STRINGS = {
    ko: {
      // common
      close: '닫기',
      maximize: '최대화',
      restoreSize: '이전 크기로',
      delete: '삭제',
      newSession: '새 세션',
      unclassified: '미분류',
      timeJustNow: '방금',
      timeMinutes: '{n}분',
      timeHours: '{n}시간',
      timeDays: '{n}일',

      // settings window
      settingsWindowTitle: '설정 — Local Assistant',
      settingsHeaderTitle: '설정',
      catGeneral: '일반',
      catSystem: '시스템 프롬프트',
      catWorkspace: '워크스페이스 & 도구',
      catMcp: 'MCP 서버',
      paneGeneralH2: '일반',
      labelBaseUrl: 'BASE URL',
      labelModel: "MODEL (비워두면 'local')",
      labelMaxTokens: 'MAX TOKENS (응답 길이 제한)',
      labelMaxToolRounds: '도구 호출 한도 (메시지당 모델↔도구 왕복 횟수)',
      labelLanguage: '언어',
      paneSystemH2: '시스템 프롬프트',
      labelSystemPrompt: 'SYSTEM PROMPT',
      placeholderSystemPrompt: '비워두면 시스템 프롬프트 없이 전송',
      paneWorkspaceH2: '워크스페이스 & 도구',
      labelWorkspace: '워크스페이스 (도구가 접근할 폴더)',
      placeholderWorkspace: '폴더를 선택하세요',
      btnBrowse: '찾아보기',
      labelTools: 'TOOLS',
      paneMcpH2: 'MCP 서버 (전역)',
      labelMcpServers: 'MCP SERVERS (JSON)',
      labelMcpTools: 'MCP 도구',
      footerSave: '저장',
      statusSaved: '저장됨',
      statusConnectingMcp: 'MCP 서버 연결 중…',
      toolSwitchEnabledTitle: '사용',
      toolSwitchAlwaysTitle: '항상 허용',
      mcpNoToolsFound: '연결된 서버에서 발견된 도구가 없습니다.',
      mcpConnectingCount: '연결 중…',
      mcpStatusConnecting: '{name}: 연결 중',
      mcpJsonTopLevelError: '최상위는 객체({...})여야 합니다.',
      mcpJsonError: 'MCP 서버 설정 JSON 오류: {msg}',
      toolLabelDatetime: '현재 시간 조회',
      toolLabelReadFile: '파일 읽기',
      toolLabelGlobSearch: '파일 이름 검색',
      toolLabelGrepSearch: '내용 검색 (grep)',
      toolLabelToolSearch: '도구 검색 (MCP)',

      // sessions window
      sessionsWindowTitle: '세션 관리 — Local Assistant',
      sessionsHeaderTitle: '세션 관리',
      tabAll: '전체',
      tabProjects: '프로젝트',
      placeholderNewProject: '새 프로젝트 이름',
      btnAddProject: '+ 추가',
      noSessions: '세션이 없습니다.',
      noneInGroup: '없음',
      deleteProjectTitle: '프로젝트 삭제',
      countSuffix: '{n}개',

      // main widget
      titleSessions: '세션 목록',
      titleSettings: '설정',
      placeholderInput: '메시지 입력...',
      titleSend: '전송',
      titleStop: '생성 중지',
      titleResize: '크기 조절',
      moreSessions: '더보기…',
      emptyState: '로컬 모델과 대화를 시작하세요',
      thinking: '💭 생각 중…',
      thoughtFor: '💭 생각함 · {s}초',
      toolErrorUnknown: '알 수 없는 오류',
      toolErrorPrefix: '↳ 오류: {msg}',
      readFileResult: '↳ {path} ({n}자{extra})',
      truncatedSuffix: ', 잘림',
      globResult: '↳ 파일 {n}개 찾음{extra}',
      grepResult: '↳ {n}개 일치{extra}',
      moreExistsSuffix: ' (더 있음)',
      confirmDeny: '거부',
      confirmApprove: '승인',
      confirmHead: '🔧 {name} 실행할까요?',
      ctxTokensSuffix: '{n} 토큰',
      usageLive: '생성 중 · 완료 ~{n} 토큰',
      usagePromptPart: '프롬프트 {n}',
      usageCompletionPart: '완료 {n}',
      usageFinalEstimate: '완료 ~{n} 토큰 (추정)',
      connectionFailed: '연결 실패: {base} — 서버 상태와 CORS를 확인하세요',
      toolDisabled: '이 도구는 비활성화되어 있습니다.',
      badArgsJson: '이전 도구 호출의 arguments가 올바른 JSON이 아니었습니다(중간에 잘렸을 수 있음). 유효한 JSON으로 같은 도구를 다시 호출하세요.',
      userDenied: '사용자가 실행을 거부했습니다.',
      stoppedNote: '— 중지됨 —',
      emptyResponse: '(빈 응답)',
      serverErrorNote: '서버 오류: {detail} — 재시도 후에도 반복됨',
      httpErrorFallback: 'HTTP 오류',
      toolRoundCapNote: '— 도구 호출 한도({n}회) 도달 —'
    },
    en: {
      // common
      close: 'Close',
      maximize: 'Maximize',
      restoreSize: 'Restore',
      delete: 'Delete',
      newSession: 'New session',
      unclassified: 'Unclassified',
      timeJustNow: 'just now',
      timeMinutes: '{n}m',
      timeHours: '{n}h',
      timeDays: '{n}d',

      // settings window
      settingsWindowTitle: 'Settings — Local Assistant',
      settingsHeaderTitle: 'Settings',
      catGeneral: 'General',
      catSystem: 'System prompt',
      catWorkspace: 'Workspace & tools',
      catMcp: 'MCP servers',
      paneGeneralH2: 'General',
      labelBaseUrl: 'BASE URL',
      labelModel: "MODEL (leave empty for 'local')",
      labelMaxTokens: 'MAX TOKENS (caps response length)',
      labelMaxToolRounds: 'TOOL-CALL LIMIT (model↔tool round-trips per message)',
      labelLanguage: 'LANGUAGE',
      paneSystemH2: 'System prompt',
      labelSystemPrompt: 'SYSTEM PROMPT',
      placeholderSystemPrompt: 'Leave empty to send no system prompt',
      paneWorkspaceH2: 'Workspace & tools',
      labelWorkspace: 'WORKSPACE (folder tools can access)',
      placeholderWorkspace: 'Choose a folder',
      btnBrowse: 'Browse',
      labelTools: 'TOOLS',
      paneMcpH2: 'MCP servers (global)',
      labelMcpServers: 'MCP SERVERS (JSON)',
      labelMcpTools: 'MCP TOOLS',
      footerSave: 'Save',
      statusSaved: 'Saved',
      statusConnectingMcp: 'Connecting to MCP servers…',
      toolSwitchEnabledTitle: 'Enabled',
      toolSwitchAlwaysTitle: 'Always allow',
      mcpNoToolsFound: 'No tools found on connected servers.',
      mcpConnectingCount: 'Connecting…',
      mcpStatusConnecting: '{name}: connecting',
      mcpJsonTopLevelError: 'The top level must be an object ({...}).',
      mcpJsonError: 'MCP server config JSON error: {msg}',
      toolLabelDatetime: 'Get current time',
      toolLabelReadFile: 'Read file',
      toolLabelGlobSearch: 'Search file names',
      toolLabelGrepSearch: 'Search content (grep)',
      toolLabelToolSearch: 'Search tools (MCP)',

      // sessions window
      sessionsWindowTitle: 'Session Manager — Local Assistant',
      sessionsHeaderTitle: 'Session Manager',
      tabAll: 'All',
      tabProjects: 'Projects',
      placeholderNewProject: 'New project name',
      btnAddProject: '+ Add',
      noSessions: 'No sessions.',
      noneInGroup: 'None',
      deleteProjectTitle: 'Delete project',
      countSuffix: '{n}',

      // main widget
      titleSessions: 'Session list',
      titleSettings: 'Settings',
      placeholderInput: 'Type a message...',
      titleSend: 'Send',
      titleStop: 'Stop generating',
      titleResize: 'Resize',
      moreSessions: 'More…',
      emptyState: 'Start a conversation with your local model',
      thinking: '💭 Thinking…',
      thoughtFor: '💭 Thought for {s}s',
      toolErrorUnknown: 'unknown error',
      toolErrorPrefix: '↳ Error: {msg}',
      readFileResult: '↳ {path} ({n} chars{extra})',
      truncatedSuffix: ', truncated',
      globResult: '↳ found {n} file(s){extra}',
      grepResult: '↳ {n} match(es){extra}',
      moreExistsSuffix: ' (more)',
      confirmDeny: 'Deny',
      confirmApprove: 'Approve',
      confirmHead: '🔧 Run {name}?',
      ctxTokensSuffix: '{n} tokens',
      usageLive: 'Generating · ~{n} tokens',
      usagePromptPart: 'prompt {n}',
      usageCompletionPart: 'completion {n}',
      usageFinalEstimate: '~{n} tokens (estimated)',
      connectionFailed: 'Connection failed: {base} — check the server and CORS',
      toolDisabled: 'This tool is disabled.',
      badArgsJson: "The previous tool call's arguments were not valid JSON (it may have been cut off). Call the same tool again with valid JSON.",
      userDenied: 'The user denied this action.',
      stoppedNote: '— Stopped —',
      emptyResponse: '(empty response)',
      serverErrorNote: 'Server error: {detail} — persisted after retries',
      httpErrorFallback: 'HTTP error',
      toolRoundCapNote: '— Tool-call limit ({n}) reached —'
    }
  };

  let lang = 'ko';

  function t(key, vars) {
    const table = STRINGS[lang] || STRINGS.ko;
    let s = table[key] ?? STRINGS.ko[key] ?? key;
    if (vars) for (const k of Object.keys(vars)) s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]);
    return s;
  }

  function setLang(l) {
    lang = l === 'en' ? 'en' : 'ko';
    document.documentElement.lang = lang;
    if (document.title && document.body?.dataset.i18nTitleKey) {
      document.title = t(document.body.dataset.i18nTitleKey);
    }
  }

  // Applies data-i18n / data-i18n-title / data-i18n-placeholder attributes
  // found under root to the current language. Called once at startup after
  // the language is known, and again whenever the language changes.
  function applyDom(root) {
    (root || document).querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    (root || document).querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = t(el.getAttribute('data-i18n-title'));
    });
    (root || document).querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
    });
    if (document.body?.dataset.i18nTitleKey) document.title = t(document.body.dataset.i18nTitleKey);
  }

  function timeAgo(ts) {
    const d = Math.floor((Date.now() - ts) / 1000);
    if (d < 60) return t('timeJustNow');
    if (d < 3600) return t('timeMinutes', { n: Math.floor(d / 60) });
    if (d < 86400) return t('timeHours', { n: Math.floor(d / 3600) });
    return t('timeDays', { n: Math.floor(d / 86400) });
  }

  window.I18N = { t, setLang, applyDom, timeAgo, get lang() { return lang; } };
})();
