// Main renderer process script

if (!window.electronAPI) {
  console.error('electronAPI not available - check preload script');
}

// ── Window controls ──────────────────────────────────────────────────────────
document.getElementById('minimizeBtn').addEventListener('click', () => {
  window.electronAPI?.minimizeWindow();
});

document.getElementById('closeBtn').addEventListener('click', () => {
  window.electronAPI?.closeWindow();
});

document.getElementById('reloadBtn').addEventListener('click', () => {
  location.reload();
});

// ── Settings ─────────────────────────────────────────────────────────────────
document.getElementById('settingsBtn')?.addEventListener('click', async () => {
  try {
    await window.electronAPI?.openSettings?.();
  } catch (error) {
    console.error('Failed to open settings window:', error);
  }
});

// ── Ollama model updates ──────────────────────────────────────────────────────
window.electronAPI?.onOllamaModelsUpdated?.((models) => {
  if (window.modelSelector) {
    window.modelSelector.ollamaModels = models;
    if (window.modelSelector.currentModelType === 'ollama') {
      window.modelSelector.updateModelDropdown();
    }
  }
});

// ── Focus on input when window is shown ──────────────────────────────────────
window.addEventListener('focus', () => {
  document.getElementById('userInput')?.focus();
});

// ── Memory approval panel ─────────────────────────────────────────────────────
window.electronAPI?.onMemoryProposal?.((facts) => {
  if (!facts || facts.length === 0) return;
  showMemoryApproval(facts);
});


function showMemoryApproval(facts) {
  document.querySelector('.memory-approval')?.remove();

  const panel = document.createElement('div');
  panel.className = 'memory-approval';

  const header = document.createElement('div');
  header.className = 'memory-approval-header';

  const title = document.createElement('span');
  title.className = 'memory-approval-title';
  title.textContent = '💡 Save to memory?';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'memory-approval-x';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => panel.remove());

  header.appendChild(title);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const rows = document.createElement('div');
  rows.className = 'memory-approval-rows';

  const approved = new Set(facts.map((_, i) => i));

  facts.forEach((fact, i) => {
    const row = document.createElement('div');
    row.className = 'memory-approval-row';

    const text = document.createElement('span');
    text.className = 'memory-approval-fact';
    text.textContent = fact;

    const keep = document.createElement('button');
    keep.className = 'mar-btn mar-keep active';
    keep.title = 'Keep';
    keep.textContent = '✓';

    const skip = document.createElement('button');
    skip.className = 'mar-btn mar-skip';
    skip.title = 'Skip';
    skip.textContent = '✕';

    keep.addEventListener('click', () => {
      approved.add(i);
      keep.classList.add('active');
      skip.classList.remove('active');
      row.classList.remove('dismissed');
    });
    skip.addEventListener('click', () => {
      approved.delete(i);
      skip.classList.add('active');
      keep.classList.remove('active');
      row.classList.add('dismissed');
    });

    row.appendChild(text);
    row.appendChild(keep);
    row.appendChild(skip);
    rows.appendChild(row);
  });

  panel.appendChild(rows);

  const footer = document.createElement('div');
  footer.className = 'memory-approval-footer';

  const saveAll = document.createElement('button');
  saveAll.className = 'mar-save';
  saveAll.textContent = 'Save selected';
  saveAll.addEventListener('click', async () => {
    const toSave = facts.filter((_, i) => approved.has(i));
    if (toSave.length > 0) await window.electronAPI?.approveMemories?.(toSave);
    panel.remove();
  });

  const dismiss = document.createElement('button');
  dismiss.className = 'mar-dismiss';
  dismiss.textContent = 'Dismiss all';
  dismiss.addEventListener('click', () => panel.remove());

  footer.appendChild(saveAll);
  footer.appendChild(dismiss);
  panel.appendChild(footer);

  document.body.appendChild(panel);

  // Slide in
  requestAnimationFrame(() => panel.classList.add('memory-approval--visible'));

  // Auto-dismiss after 45 s
  const timer = setTimeout(() => {
    panel.classList.remove('memory-approval--visible');
    setTimeout(() => panel.remove(), 300);
  }, 45000);

  panel.addEventListener('mouseenter', () => clearTimeout(timer));
}

// ── Sidebar collapse toggle ───────────────────────────────────────────────────
document.getElementById('sidebarToggleBtn')?.addEventListener('click', () => {
  document.querySelector('.sidebar').classList.toggle('collapsed');
});

// ── Title bar session label ───────────────────────────────────────────────────
function updateTitleBar(title) {
  const label = document.getElementById('sessionTitleLabel');
  const sep   = document.getElementById('titleSep');
  if (!label) return;
  if (title) {
    label.textContent  = title;
    if (sep) sep.style.display = '';
  } else {
    label.textContent  = '';
    if (sep) sep.style.display = 'none';
  }
}

// ── Workspace ─────────────────────────────────────────────────────────────────

// ── Session / Previous Chats Panel ───────────────────────────────────────────

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'Yesterday';
  return `${d}d ago`;
}

function groupByTime(sessions) {
  const now = Date.now();
  const DAY = 86400000;
  const groups = [
    { label: 'Today',       sessions: [] },
    { label: 'Yesterday',   sessions: [] },
    { label: 'Last 7 Days', sessions: [] },
    { label: 'Older',       sessions: [] }
  ];
  for (const s of sessions) {
    const age = now - s.updated_at;
    if      (age <  1 * DAY) groups[0].sessions.push(s);
    else if (age <  2 * DAY) groups[1].sessions.push(s);
    else if (age <  7 * DAY) groups[2].sessions.push(s);
    else                      groups[3].sessions.push(s);
  }
  return groups.filter(g => g.sessions.length > 0);
}

// The session id currently rendered in the chat view
let _viewedSessionId = null;

function renderSessionItem(container, session, activeId) {
  const item = document.createElement('div');
  item.className = 'chat-session-item';
  if (session.id === (activeId ?? _viewedSessionId)) item.classList.add('active');
  if (session.pinned) item.classList.add('pinned');

  const titleEl = document.createElement('div');
  titleEl.className = 'chat-session-title';
  titleEl.textContent = session.title || 'Untitled chat';
  titleEl.title = 'Double-click to rename';

  // ── Inline rename on double-click ─────────────────────────────────
  titleEl.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    const input = document.createElement('input');
    input.type      = 'text';
    input.value     = session.title || 'Untitled chat';
    input.className = 'chat-session-rename-input';
    let committed   = false;
    const commit = async () => {
      if (committed) return;
      committed = true;
      const newTitle = input.value.trim() || 'Untitled chat';
      await window.electronAPI?.renameSession?.(session.id, newTitle);
      if (session.id === _viewedSessionId) updateTitleBar(newTitle);
      await refreshSessionList(_viewedSessionId);
    };
    input.addEventListener('blur',    commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { committed = true; input.replaceWith(titleEl); }
    });
    input.addEventListener('click', e => e.stopPropagation());
    titleEl.replaceWith(input);
    input.focus();
    input.select();
  });

  const timeEl = document.createElement('div');
  timeEl.className = 'chat-session-time';
  timeEl.textContent = relativeTime(session.updated_at);

  // ── Pin button ────────────────────────────────────────────────────
  const pin = document.createElement('button');
  pin.className = `chat-session-pin${session.pinned ? ' pinned' : ''}`;
  pin.title     = session.pinned ? 'Unpin' : 'Pin';
  pin.textContent = '📌';
  pin.addEventListener('click', async (e) => {
    e.stopPropagation();
    await window.electronAPI?.pinSession?.(session.id, !session.pinned);
    await refreshSessionList(_viewedSessionId);
  });

  // ── Export button ─────────────────────────────────────────────────
  const exp = document.createElement('button');
  exp.className = 'chat-session-export';
  exp.title     = 'Export as Markdown';
  exp.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
  exp.addEventListener('click', async (e) => {
    e.stopPropagation();
    const result = await window.electronAPI?.exportSession?.(session.id);
    if (result?.success) {
      exp.textContent = '✓';
      setTimeout(() => {
        exp.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
      }, 2000);
    }
  });

  // ── Delete × button ───────────────────────────────────────────────
  const del = document.createElement('button');
  del.className   = 'chat-session-delete';
  del.textContent = '×';
  del.title       = 'Delete chat';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    await window.electronAPI?.deleteSession?.(session.id);
    if (_viewedSessionId === session.id) {
      _viewedSessionId = null;
      updateTitleBar(null);
      window.chatInterface?._showWelcome?.();
    }
    await refreshSessionList(null);
  });

  item.appendChild(titleEl);

  // ── Keyword tag pills ──────────────────────────────────────────────
  if (session.tags && session.tags.length > 0) {
    const tagsEl = document.createElement('div');
    tagsEl.className = 'session-tags';
    for (const tag of session.tags.slice(0, 3)) {
      const pill = document.createElement('span');
      pill.className   = 'session-tag';
      pill.textContent = tag;
      tagsEl.appendChild(pill);
    }
    item.appendChild(tagsEl); // tags sit between title and timestamp
  }

  item.appendChild(timeEl);
  item.appendChild(pin);
  item.appendChild(exp);
  item.appendChild(del);
  item.addEventListener('click', () => handleSessionClick(session.id, session.title));
  container.appendChild(item);
}

function renderSessionList(sessions, activeId) {
  const container = document.getElementById('chatsList');
  if (!container) return;

  // Hide sessions that have no title yet (fresh empty sessions)
  const history = sessions.filter(s => s.title !== null);

  if (history.length === 0) {
    container.innerHTML = '<div class="chats-empty">No previous chats</div>';
    return;
  }

  container.innerHTML = '';

  // Pinned group at top
  const pinned   = history.filter(s =>  s.pinned);
  const unpinned = history.filter(s => !s.pinned);

  if (pinned.length > 0) {
    const label = document.createElement('div');
    label.className   = 'chats-group-label';
    label.textContent = '📌 Pinned';
    container.appendChild(label);
    for (const session of pinned) renderSessionItem(container, session, activeId);
  }

  const grouped = groupByTime(unpinned);
  for (const group of grouped) {
    const label = document.createElement('div');
    label.className   = 'chats-group-label';
    label.textContent = group.label;
    container.appendChild(label);
    for (const session of group.sessions) renderSessionItem(container, session, activeId);
  }
}

async function handleSessionClick(sessionId, title) {
  if (_viewedSessionId === sessionId) return;
  _viewedSessionId = sessionId;
  updateTitleBar(title || null);
  if (window.chatInterface) await window.chatInterface.loadSession(sessionId);
  await refreshSessionList(sessionId);

}

async function refreshSessionList(activeId) {
  try {
    const sessions = await window.electronAPI?.getSessions?.();
    if (Array.isArray(sessions)) {
      renderSessionList(sessions, activeId ?? _viewedSessionId);
    }
  } catch (err) {
    console.error('Failed to refresh sessions:', err);
  }
}

// ── New Chat buttons ──────────────────────────────────────────────────────────
async function startNewChat() {
  _viewedSessionId = null;
  updateTitleBar(null);
  if (window.chatInterface) await window.chatInterface.newChat();
  await refreshSessionList(null);
}

document.getElementById('newChatBtn')?.addEventListener('click', startNewChat);
document.getElementById('clearChatBtn')?.addEventListener('click', startNewChat);

// ── Sidebar chat search ───────────────────────────────────────────────────────

const searchChatsBtn   = document.getElementById('searchChatsBtn');
const chatsSearchBar   = document.getElementById('chatsSearchBar');
const chatsSearchInput = document.getElementById('chatsSearchInput');
const chatsSearchClose = document.getElementById('chatsSearchClose');
let _searchDebounce    = null;
let _searchActive      = false;

function openChatsSearch() {
  _searchActive = true;
  chatsSearchBar?.classList.remove('hidden');
  chatsSearchInput?.focus();
}

function closeChatsSearch() {
  _searchActive = false;
  chatsSearchBar?.classList.add('hidden');
  if (chatsSearchInput) chatsSearchInput.value = '';
  refreshSessionList(_viewedSessionId);
}

searchChatsBtn?.addEventListener('click', openChatsSearch);
chatsSearchClose?.addEventListener('click', closeChatsSearch);

chatsSearchInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeChatsSearch();
});

chatsSearchInput?.addEventListener('input', () => {
  clearTimeout(_searchDebounce);
  const q = chatsSearchInput.value.trim();
  if (!q) { refreshSessionList(_viewedSessionId); return; }
  _searchDebounce = setTimeout(() => renderSearchResults(q), 220);
});

async function renderSearchResults(query) {
  const chatsList = document.getElementById('chatsList');
  if (!chatsList) return;
  const results = await window.electronAPI?.searchSessions?.(query) || [];
  chatsList.innerHTML = '';
  if (!results.length) {
    chatsList.innerHTML = '<div class="chats-empty">No results found</div>';
    return;
  }
  for (const { session, titleMatch, messageMatches } of results) {
    const item = document.createElement('div');
    item.className = 'chat-session-item';
    if (session.id === _viewedSessionId) item.classList.add('active');

    const titleEl = document.createElement('div');
    titleEl.className = 'chat-session-title';
    titleEl.innerHTML = titleMatch
      ? _hlMatch(session.title || 'Untitled chat', query)
      : (session.title || 'Untitled chat');
    item.appendChild(titleEl);

    for (const match of messageMatches) {
      const ex = document.createElement('div');
      ex.className = 'search-result-excerpt' + (match.role === 'user' ? ' user' : '');
      ex.innerHTML = _hlMatch(match.excerpt, query);
      item.appendChild(ex);
    }

    item.addEventListener('click', () => {
      closeChatsSearch();
      handleSessionClick(session.id, session.title);
    });
    chatsList.appendChild(item);
  }
}

function _hlMatch(text, query) {
  const esc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(${esc})`, 'gi'), '<mark class="hl">$1</mark>');
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || e.altKey) return;
  const tag    = document.activeElement?.tagName;
  const inText = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;

  // Ctrl+Shift+F — sidebar search
  if (e.shiftKey) {
    if (e.key.toLowerCase() === 'f') { e.preventDefault(); openChatsSearch(); }
    return;
  }

  switch (e.key.toLowerCase()) {
    case 'n':
      if (!inText) { e.preventDefault(); startNewChat(); }
      break;
    case 'k':
      e.preventDefault();
      openSessionSwitcher();
      break;
    case 'e':
      e.preventDefault();
      exportCurrentChat();
      break;
    case 'y':
      e.preventDefault();
      document.querySelector('.sidebar')?.classList.toggle('collapsed');
      break;
    case 'i': {
      const input = document.getElementById('userInput');
      if (input) {
        e.preventDefault();
        input.focus();
        const len = input.value.length;
        input.setSelectionRange(len, len);
      }
      break;
    }
  }
});

// ── Ctrl+K — Session Switcher ─────────────────────────────────────────────────

let _ssmSessions = [];
let _ssmIndex   = -1;
const ssmModal   = document.getElementById('sessionSwitcherModal');
const ssmSearch  = document.getElementById('ssmSearch');
const ssmList    = document.getElementById('ssmList');

function renderSsmList(query) {
  if (!ssmList) return;
  const q = query.trim().toLowerCase();
  const filtered = _ssmSessions.filter(s =>
    !q || (s.title || 'Untitled chat').toLowerCase().includes(q)
  );
  ssmList.innerHTML = '';
  _ssmIndex = -1;
  if (!filtered.length) {
    ssmList.innerHTML = '<div class="ssm-empty">No sessions match</div>';
    return;
  }
  filtered.forEach((s, i) => {
    const item = document.createElement('div');
    item.className = 'ssm-item';
    if (s.id === _viewedSessionId) item.classList.add('current');
    item.dataset.id    = s.id;
    item.dataset.title = s.title || 'Untitled chat';

    const title = document.createElement('span');
    title.className = 'ssm-item-title';
    title.textContent = s.title || 'Untitled chat';

    const time = document.createElement('span');
    time.className = 'ssm-item-time';
    time.textContent = relativeTime(s.updated_at);

    item.appendChild(title);
    item.appendChild(time);
    item.addEventListener('mouseenter', () => {
      _ssmIndex = i;
      updateSsmHighlight(filtered);
    });
    item.addEventListener('click', () => {
      closeSessionSwitcher();
      handleSessionClick(s.id, s.title);
    });
    ssmList.appendChild(item);
  });
}

function updateSsmHighlight(items) {
  ssmList.querySelectorAll('.ssm-item').forEach((el, i) =>
    el.classList.toggle('highlighted', i === _ssmIndex)
  );
  const hi = ssmList.querySelector('.ssm-item.highlighted');
  hi?.scrollIntoView({ block: 'nearest' });
}

async function openSessionSwitcher() {
  if (!ssmModal) return;
  const sessions = await window.electronAPI?.getSessions?.() || [];
  _ssmSessions = sessions.filter(s => s.title !== null);
  ssmModal.classList.remove('hidden');
  if (ssmSearch) { ssmSearch.value = ''; ssmSearch.focus(); }
  renderSsmList('');
}

function closeSessionSwitcher() {
  ssmModal?.classList.add('hidden');
}

ssmSearch?.addEventListener('input', () => renderSsmList(ssmSearch.value));

ssmSearch?.addEventListener('keydown', (e) => {
  const items = [...ssmList.querySelectorAll('.ssm-item')];
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _ssmIndex = Math.min(_ssmIndex + 1, items.length - 1);
    updateSsmHighlight(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _ssmIndex = Math.max(_ssmIndex - 1, 0);
    updateSsmHighlight(items);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const hi = items[_ssmIndex];
    if (hi) { closeSessionSwitcher(); handleSessionClick(hi.dataset.id, hi.dataset.title); }
  } else if (e.key === 'Escape') {
    closeSessionSwitcher();
  }
});

ssmModal?.querySelector('.ssm-backdrop')?.addEventListener('click', closeSessionSwitcher);

// ── Ctrl+E — Export current chat ─────────────────────────────────────────────

async function exportCurrentChat() {
  if (!_viewedSessionId) return;
  const result = await window.electronAPI?.exportSession?.(_viewedSessionId);
  if (result?.success) {
    const toast = document.createElement('div');
    toast.className = 'memory-toast memory-toast--visible';
    toast.style.cssText = 'background:rgba(30,90,40,0.92); border-color:rgba(60,160,70,0.4)';
    toast.textContent = '✓ Chat exported';
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.classList.remove('memory-toast--visible');
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  }
}

// Push refresh when main process sets a new session title
window.electronAPI?.onSessionTitleSet?.(() => refreshSessionList(_viewedSessionId));

// ── Suggestions Panel ─────────────────────────────────────────────────────────
let _suggOpen     = false;
let _suggLastQuery = '';

function _relTimeShort(ts) {
  if (!ts) return '';
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d < 1) return 'today';
  if (d === 1) return '1d ago';
  if (d < 7) return `${d}d ago`;
  if (d < 30) return `${Math.round(d / 7)}w ago`;
  return `${Math.round(d / 30)}mo ago`;
}

const CAT_LABEL = { fact: 'fact', preference: 'pref', project: 'proj', entity: 'entity', procedural: 'how' };

function renderSuggestions({ memories = [], episodes = [] } = {}) {
  const body = document.getElementById('suggPanelBody');
  if (!body) return;

  if (memories.length === 0 && episodes.length === 0) {
    body.innerHTML = '<div class="sugg-empty">No relevant context found yet.</div>';
    return;
  }

  let html = '';

  if (memories.length > 0) {
    html += '<div class="sugg-section"><div class="sugg-section-title">What I know</div>';
    for (const m of memories) {
      const cat = CAT_LABEL[m.category] || m.category || '';
      html += `<div class="sugg-item"><span class="sugg-item-cat">${cat}</span>${_esc(m.content)}</div>`;
    }
    html += '</div>';
  }

  if (episodes.length > 0) {
    html += '<div class="sugg-section"><div class="sugg-section-title">Related sessions</div>';
    for (const ep of episodes) {
      const age = _relTimeShort(ep.updated_at);
      html += `<div class="sugg-episode">
        <div><span class="sugg-episode-title">${_esc(ep.title || 'Untitled')}</span><span class="sugg-episode-age">${age}</span></div>
        ${ep.digest ? `<div class="sugg-episode-digest">${_esc(ep.digest.slice(0, 120))}</div>` : ''}
      </div>`;
    }
    html += '</div>';
  }

  body.innerHTML = html;
}

function _esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function fetchAndRenderSuggestions(query) {
  if (!_suggOpen || !query) return;
  _suggLastQuery = query;
  const body = document.getElementById('suggPanelBody');
  if (body) body.innerHTML = '<div class="sugg-spinner">Loading…</div>';
  try {
    const data = await window.electronAPI?.getSuggestions?.({ query, appMode: 'chat' });
    if (data) renderSuggestions(data);
  } catch {}
}

document.getElementById('suggToggleBtn')?.addEventListener('click', () => {
  _suggOpen = !_suggOpen;
  document.getElementById('suggPanel')?.classList.toggle('hidden', !_suggOpen);
  document.getElementById('suggToggleBtn')?.classList.toggle('active', _suggOpen);
  if (_suggOpen && _suggLastQuery) fetchAndRenderSuggestions(_suggLastQuery);
});

document.getElementById('suggCloseBtn')?.addEventListener('click', () => {
  _suggOpen = false;
  document.getElementById('suggPanel')?.classList.add('hidden');
  document.getElementById('suggToggleBtn')?.classList.remove('active');
});

// Called by ChatInterface after each completed response
window._onSuggestionQuery = (query) => {
  _suggLastQuery = query;
  if (_suggOpen) fetchAndRenderSuggestions(query);
};

// ── Incognito mode (local only, no persistence) ───────────────────────────────
let _incognito = false;
window.isIncognito = () => _incognito;

function _setIncognito(on) {
  _incognito = !!on;
  document.body.dataset.incognito = _incognito ? 'on' : 'off';
  document.getElementById('incogToggleBtn')?.classList.toggle('active', _incognito);
  window.modelSelector?.setIncognito?.(_incognito);

  const input = document.getElementById('userInput');
  if (input) {
    input.placeholder = _incognito
      ? 'Incognito — local only, nothing saved…'
      : 'Ask me anything... (Ctrl+Shift+Space to toggle)';
  }

  // Wipe the visible chat so nothing carries between modes.
  const msgs = document.getElementById('chatMessages');
  if (msgs) msgs.innerHTML = '<div class="welcome-message" id="welcomeMessage"><h2>Hi! I\'m Friday</h2><p id="welcomeSubtext">' +
    (_incognito ? 'Incognito mode — nothing is saved.' : 'Your personal AI assistant. Ask me anything!') +
    '</p></div>';

  if (window.chatInterface) {
    window.chatInterface._incognitoHistoryCleared?.();
  }

  // When entering incognito, don't point at a persisted session.
  // When leaving, the user gets a fresh normal chat.
  if (_incognito) {
    if (window.chatInterface) window.chatInterface._currentSessionId = null;
    _viewedSessionId = null;
    refreshSessionList(null);
  } else {
    if (window.chatInterface) window.chatInterface._currentSessionId = null;
    _viewedSessionId = null;
    updateTitleBar(null);
    refreshSessionList(null);
  }
}

document.getElementById('incogToggleBtn')?.addEventListener('click', async () => {
  // Wipe any prior incognito state on every toggle so the two modes never leak.
  try { await window.electronAPI?.clearIncognito?.(); } catch {}
  _setIncognito(!_incognito);
});

// ── Initial session list load ─────────────────────────────────────────────────
(async () => {
  try {
    const active = await window.electronAPI?.getActiveSession?.();
    if (active?.session?.id && Array.isArray(active.messages) && active.messages.length > 0) {
      _viewedSessionId = active.session.id;
      updateTitleBar(active.session.title || null);
    }
  } catch {}
  await refreshSessionList(_viewedSessionId);
})();

// ── Wake word detector ────────────────────────────────────────────────────────

let _wakeDetector = null;

async function _initWakeWord() {
  const cfg = await window.electronAPI?.getWakeWordConfig?.().catch(() => null);
  if (!cfg?.enabled) return;

  _wakeDetector = new WakeWordDetector({
    phrases: [cfg.phrase || 'hey friday'],
    onWake: async (commandText) => {
      // Bring the window into focus
      await window.electronAPI?.showWindow?.();

      if (commandText) {
        // Command was spoken after the wake phrase — submit it directly
        window.chatInterface?.submitText?.(commandText);
      } else {
        // No command — activate the mic so the user can speak
        document.getElementById('micBtn')?.click();
      }
    },
  });

  await _wakeDetector.start();
  console.log('[WakeWord] Detector started, phrase:', cfg.phrase);
}

_initWakeWord();

// Allow settings changes to restart the detector without reloading the page
window.electronAPI?.saveWakeWordConfig && (() => {
  // Patch: re-init after the settings page saves
  const _origSave = window.electronAPI.saveWakeWordConfig;
  window.electronAPI.saveWakeWordConfig = async (cfg) => {
    const res = await _origSave(cfg);
    _wakeDetector?.stop();
    _wakeDetector = null;
    if (cfg.enabled) await _initWakeWord();
    return res;
  };
})();

console.log('Friday Assistant initialized');

// ── AgentRuntime event listener (Phase 1C) ────────────────────────────────────
//
// All AgentRuntime events arrive on 'agent-event' with typed payloads.
// We route them to ChatInterface helper methods.

let _agentFinalText  = '';
let _agentUsage      = null;
let _agentModelType  = '';

window.electronAPI?.onAgentEvent?.((event) => {
  const ci = window.chatInterface;
  if (!ci) return;

  switch (event.type) {
    case 'session.status': {
      if (event.status === 'running') {
        // Ensure we're set as generating
        ci._setGenerating?.(true);
        _agentFinalText = '';
        _agentUsage     = null;
        // startAgentResponse is called lazily on first part.new
      } else if (event.status === 'idle') {
        ci.finalizeAgentResponse(_agentFinalText, _agentUsage, _agentModelType);
        ci._setGenerating?.(false);
        ci.userInput?.focus();
        // Refresh session list to pick up any title that was set
        refreshSessionList(_viewedSessionId);
        if (_agentFinalText && typeof window._onSuggestionQuery === 'function') {
          window._onSuggestionQuery(_agentFinalText);
        }
      } else if (event.status === 'error') {
        // Clean up orphaned thinking indicator on error
        if (ci._activeThinkingId) {
          ci.removeThinkingIndicator(ci._activeThinkingId);
        }
        ci._setGenerating?.(false);
        ci.userInput?.focus();
      }
      break;
    }

    case 'part.new': {
      const part = event.part;
      if (!part) break;
      // Always reset text accumulator on new text part (even if empty — deltas will fill it)
      if (part.type === 'text') {
        _agentFinalText = part.content || '';
      }
      ci.handlePartNew(part);
      break;
    }

    case 'part.delta': {
      // AgentRuntime emits { partId, text } (field is 'text', not 'delta')
      ci.handlePartDelta(event.partId, event.text || '');
      _agentFinalText += (event.text || '');
      break;
    }

    case 'part.update': {
      // AgentRuntime emits { part: fullPartObject }
      const updatedPart = event.part;
      if (!updatedPart) break;
      ci.handlePartUpdate(updatedPart.id, updatedPart);
      // Capture final text content
      if (updatedPart.type === 'text' && updatedPart.content) {
        _agentFinalText = updatedPart.content;
      }
      // Capture usage from step-finish
      if (updatedPart.usage) _agentUsage = updatedPart.usage;
      break;
    }

    case 'tool.stream': {
      ci.handleToolStream(event.partId, event.chunk);
      break;
    }

    case 'permission.request': {
      ci.showAgentPermissionBanner({
        requestId: event.requestId,
        toolName:  event.toolName,
        args:      event.args,
      });
      break;
    }

    case 'memory.proposal': {
      // Reuse existing memory approval flow
      if (event.facts && event.facts.length > 0) {
        showMemoryApproval(event.facts);
      }
      break;
    }

    case 'session.title': {
      if (event.sessionId === _viewedSessionId) {
        updateTitleBar(event.title);
      }
      refreshSessionList(_viewedSessionId);
      break;
    }

    case 'context.warning': {
      // Show token warning bar
      const bar = document.getElementById('tokenWarningBar');
      const txt = document.getElementById('tokenWarningText');
      if (bar) bar.classList.remove('hidden');
      if (txt && event.tokensLeft) {
        txt.textContent = `Context ${Math.round(event.pct * 100)}% full — ${event.tokensLeft.toLocaleString()} tokens remaining`;
      }
      break;
    }

    default:
      break;
  }
});

// Hide token warning bar when a new message starts
const _origSend = window.chatInterface?.sendMessage?.bind(window.chatInterface);
// Patch after DOMContentLoaded so chatInterface exists
document.addEventListener('DOMContentLoaded', () => {
  // Capture model type for usage display
  window._agentModelTypeGetter = () => {
    const sel = window.modelSelector?.getSelectedModel?.();
    _agentModelType = sel?.modelType || '';
  };
});


