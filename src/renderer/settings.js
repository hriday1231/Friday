function $(id) {
  return document.getElementById(id);
}

function setBadge(el, state, text) {
  if (!el) return;
  el.textContent = text;
  el.classList.remove('ok', 'warn', 'err');
  el.classList.add(state);
}

function showToast(message, type = 'info') {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove('show', 'info', 'ok', 'warn', 'err');
  toast.classList.add('show', type);
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), 2500);
}

let currentSettings = {
  appShortcuts: [],
  webBookmarks: []
};

function renderTable(tableId, rows, fields) {
  const table = $(tableId);
  if (!table) return;
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = '';

  rows.forEach((row, index) => {
    const tr = document.createElement('tr');

    fields.forEach((field) => {
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.value = row[field] ?? '';
      input.addEventListener('input', (e) => {
        row[field] = e.target.value;
      });
      td.appendChild(input);
      tr.appendChild(td);
    });

    const actionsTd = document.createElement('td');
    const removeBtn = document.createElement('button');
    removeBtn.textContent = '×';
    removeBtn.className = 'settings-row-remove';
    removeBtn.title = 'Remove row';
    removeBtn.addEventListener('click', () => {
      rows.splice(index, 1);
      renderAllTables();
    });
    actionsTd.appendChild(removeBtn);
    tr.appendChild(actionsTd);

    tbody.appendChild(tr);
  });
}

function renderAllTables() {
  renderTable('appShortcutsTable', currentSettings.appShortcuts, ['name', 'path', 'args']);
  renderTable('webBookmarksTable', currentSettings.webBookmarks, ['name', 'url']);
}

async function loadSettings() {
  const settings = await window.electronAPI?.getSettings();
  currentSettings = {
    appShortcuts: settings?.appShortcuts || [],
    webBookmarks: settings?.webBookmarks || []
  };
  renderAllTables();
}

async function saveSettings() {
  const result = await window.electronAPI?.saveSettings(currentSettings);
  if (!result?.success) {
    showToast(result?.error || 'Failed to save settings', 'err');
    return;
  }
  showToast('Saved', 'ok');
}

function setIntegrationBody(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

async function refreshIntegrationsStatus() {
  const status = await window.electronAPI?.getIntegrationsStatus();
  if (!status) return;

  // Ollama
  if (status.ollama?.running) {
    setBadge($('badge-ollama'), 'ok', 'Running');
    const models = Array.isArray(status.ollama.models) ? status.ollama.models : [];
    setIntegrationBody('body-ollama', models.length ? `Models: ${models.slice(0, 6).join(', ')}${models.length > 6 ? '…' : ''}` : 'No models found.');
  } else {
    setBadge($('badge-ollama'), 'err', 'Not running');
    setIntegrationBody('body-ollama', 'Ollama not reachable. Check the URL above.');
  }

  // Groq / Gemini / Brave / OpenRouter (Models page badges)
  setBadge($('badge-groq'),          status.groq?.configured        ? 'ok' : 'warn', status.groq?.configured        ? '✓' : '—');
  setBadge($('badge-gemini-models'), status.gemini?.configured       ? 'ok' : 'warn', status.gemini?.configured       ? '✓' : '—');
  setBadge($('badge-brave-models'),  status.brave?.configured        ? 'ok' : 'warn', status.brave?.configured        ? '✓' : '—');
  setBadge($('badge-openrouter'),    status.openrouter?.configured   ? 'ok' : 'warn', status.openrouter?.configured   ? '✓' : '—');

  // Google Calendar
  const creds = status.googleCalendar?.credentialsPresent;
  const token = status.googleCalendar?.tokenPresent;
  const acct = status.googleCalendar?.account;
  if (creds && token) {
    setBadge($('badge-google'), 'ok', acct ? `Connected (${acct})` : 'Connected');
    setIntegrationBody('body-google', acct ? `Signed in as ${acct}.` : 'Token found. Use Test to confirm access.');
  } else if (creds && !token) {
    setBadge($('badge-google'), 'warn', 'Needs sign-in');
    setIntegrationBody('body-google', 'Credentials found but no token. Click Connect / Re-auth.');
  } else {
    setBadge($('badge-google'), 'warn', 'Not set');
    setIntegrationBody('body-google', 'Missing credentials.json (or GOOGLE_CREDENTIALS_PATH).');
  }
}

async function runIntegrationTest(name) {
  showToast(`Testing ${name}…`, 'info');
  const result = await window.electronAPI?.testIntegration(name);
  if (!result?.success) {
    showToast(result?.error || `Test failed: ${name}`, 'err');
    return;
  }
  const details = result.details ? JSON.stringify(result.details) : 'OK';
  showToast(`${name} OK: ${details}`, 'ok');
  await refreshIntegrationsStatus();
}

function switchPage(page) {
  document.querySelectorAll('.settings-nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });
  const pages = ['integrations', 'models', 'shortcuts', 'bookmarks', 'memory', 'voice', 'persona', 'training'];
  for (const p of pages) {
    const el = $(`page-${p}`);
    if (el) el.classList.toggle('hidden', p !== page);
  }
  if (page === 'voice')         { loadWhisperConfig(); loadTtsCard(); loadWakeWordCard(); }
  if (page === 'memory')        loadMemory();
  if (page === 'persona')       loadPersona();
  if (page === 'models')        loadModelsPage();
  if (page === 'integrations')  loadIntegrationsPage();
  if (page === 'training')      loadTrainingPage();
}

async function loadIntegrationsPage() {
  // Load Ollama URL
  try {
    const res = await window.electronAPI?.getOllamaUrl?.();
    const el = $('ollamaUrlInput');
    if (el && res?.url) el.value = res.url;
  } catch {}

  // Load hotkey
  try {
    const res = await window.electronAPI?.getHotkey?.();
    const el = $('hotkeyInput');
    if (el && res?.hotkey) el.value = res.hotkey;
  } catch {}

  await loadScreenContextCard();
}

async function loadScreenContextCard() {
  try {
    const cfg = await window.electronAPI?.getScreenContextConfig?.();
    if (cfg) {
      const enabled  = $('screenContextEnabled');
      const interval = $('screenContextInterval');
      if (enabled)  enabled.checked  = !!cfg.enabled;
      if (interval) interval.value   = cfg.interval || 60;
    }
    const badge = $('badge-screen-context');
    if (badge) setBadge(badge, cfg?.enabled ? 'ok' : 'warn', cfg?.enabled ? 'Active' : 'Off');
  } catch {}
}

function wireEvents() {
  document.querySelectorAll('.settings-nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchPage(btn.dataset.page));
  });

  $('addAppShortcutBtn')?.addEventListener('click', () => {
    currentSettings.appShortcuts.push({ name: '', path: '', args: '' });
    renderAllTables();
  });
  $('addBookmarkBtn')?.addEventListener('click', () => {
    currentSettings.webBookmarks.push({ name: '', url: '' });
    renderAllTables();
  });
  wireMemoryEvents();

  $('saveAllBtn')?.addEventListener('click', () => saveSettings());
  $('refreshStatusBtn')?.addEventListener('click', () => refreshIntegrationsStatus());
  wireModelsPage();
  wireIntegrationsPage();

  document.querySelectorAll('[data-test]').forEach((btn) => {
    btn.addEventListener('click', () => runIntegrationTest(btn.dataset.test));
  });

  $('googleConnectBtn')?.addEventListener('click', async () => {
    showToast('Starting Google connect…', 'info');
    const res = await window.electronAPI?.googleCalendarConnect();
    if (!res?.success) {
      showToast(res?.error || 'Google connect failed', 'err');
      return;
    }
    showToast('Google connected', 'ok');
    await refreshIntegrationsStatus();
  });

  $('googleLogoutBtn')?.addEventListener('click', async () => {
    const res = await window.electronAPI?.googleCalendarLogout();
    if (!res?.success) {
      showToast(res?.error || 'Logout failed', 'err');
      return;
    }
    showToast('Logged out', 'ok');
    await refreshIntegrationsStatus();
  });
}

// ── Integrations page extras (Ollama URL + hotkey) ────────────────────────────

function wireIntegrationsPage() {
  $('saveOllamaUrlBtn')?.addEventListener('click', async () => {
    const url = ($('ollamaUrlInput')?.value || '').trim() || 'http://localhost:11434';
    const res = await window.electronAPI?.saveOllamaUrl?.(url);
    if (res?.success) showToast('Ollama URL saved', 'ok');
    else showToast('Failed to save Ollama URL', 'err');
    await refreshIntegrationsStatus();
  });

  $('saveHotkeyBtn')?.addEventListener('click', async () => {
    const hotkey = ($('hotkeyInput')?.value || '').trim();
    if (!hotkey) { showToast('Enter a hotkey first', 'warn'); return; }
    const res = await window.electronAPI?.saveHotkey?.(hotkey);
    if (res?.success) showToast(`Hotkey set to ${hotkey}`, 'ok');
    else showToast(res?.error || 'Failed to set hotkey — check the accelerator syntax', 'err');
  });

  $('saveScreenContextBtn')?.addEventListener('click', async () => {
    const cfg = {
      enabled:  !!$('screenContextEnabled')?.checked,
      interval: parseInt($('screenContextInterval')?.value || '60', 10),
    };
    const res = await window.electronAPI?.saveScreenContextConfig?.(cfg);
    if (res?.success) {
      showToast(cfg.enabled ? 'Screen context enabled' : 'Screen context disabled', 'ok');
      await loadScreenContextCard();
    } else {
      showToast(res?.error || 'Failed to save screen context config', 'err');
    }
  });

  $('saveWakeWordBtn')?.addEventListener('click', async () => {
    const cfg = {
      enabled: !!$('wakeWordEnabled')?.checked,
      phrase:  ($('wakeWordPhrase')?.value || 'hey friday').trim().toLowerCase(),
    };
    const res = await window.electronAPI?.saveWakeWordConfig?.(cfg);
    if (res?.success) {
      const badge = $('badge-wake-word');
      if (badge) setBadge(badge, cfg.enabled ? 'ok' : 'warn', cfg.enabled ? `"${cfg.phrase}"` : 'Off');
      showToast(cfg.enabled ? `Listening for "${cfg.phrase}"` : 'Wake word disabled', 'ok');
    } else {
      showToast(res?.error || 'Failed to save wake word config', 'err');
    }
  });
}

// ── Models page ───────────────────────────────────────────────────────────────

let _allModels = { ollama: [], groq: [], gemini: [], openrouter: [] };
let _modelSlots = {
  chat:   { model: 'gpt-oss:20b',             type: 'ollama' },
  vision: { model: 'llama3.2-vision:11b',     type: 'ollama' },
  cloud:  { model: 'llama-3.3-70b-versatile', type: 'groq'   },
};

async function loadModelsPage() {
  // Load current API keys
  try {
    const [groq, gemini, brave, openrouter] = await Promise.all([
      window.electronAPI?.getGroqKey?.(),
      window.electronAPI?.getGeminiKey?.(),
      window.electronAPI?.getBraveKey?.(),
      window.electronAPI?.getOpenRouterKey?.(),
    ]);
    const set = (id, key) => {
      const el = $(id);
      if (el && key) el.value = key;
    };
    const badge = (id, key) => {
      const el = $(id);
      if (!el) return;
      el.textContent = key ? '✓' : '—';
      el.className   = `settings-badge ${key ? 'ok' : ''}`;
    };
    set('groqApiKeyInput',        groq?.key);
    set('geminiApiKeyInput',      gemini?.key);
    set('braveApiKeyInput',       brave?.key);
    set('openrouterApiKeyInput',  openrouter?.key);
    badge('badge-groq',          groq?.key);
    badge('badge-gemini-models', gemini?.key);
    badge('badge-brave-models',  brave?.key);
    badge('badge-openrouter',    openrouter?.key);
  } catch {}

  // Load all models
  try {
    const result = await window.electronAPI?.getModels?.();
    if (result?.success) _allModels = result.models;
  } catch {}

  // Load saved slots
  try {
    const saved = await window.electronAPI?.getModelSlots?.();
    if (saved) _modelSlots = { ..._modelSlots, ...saved };
  } catch {}

  _renderModelSlots();
}

function _renderModelSlots() {
  const slotKeys = ['chat', 'vision', 'cloud'];
  for (const slot of slotKeys) {
    const typeEl  = $(`slot-${slot}-type`);
    const modelEl = $(`slot-${slot}-model`);
    if (!typeEl || !modelEl) continue;

    const current = _modelSlots[slot] || {};
    // Set provider dropdown
    if (current.type) typeEl.value = current.type;

    // Populate model dropdown for this provider
    _populateModelDropdown(modelEl, typeEl.value, current.model);

    // Re-populate model list when provider changes
    typeEl.onchange = () => {
      _populateModelDropdown(modelEl, typeEl.value, null);
    };
  }
}

function _populateModelDropdown(selectEl, type, selectedModel) {
  const models = _allModels[type] || [];
  selectEl.innerHTML = '';
  if (!models.length) {
    const opt = document.createElement('option');
    opt.value = selectedModel || '';
    opt.textContent = selectedModel || `(no ${type} models)`;
    selectEl.appendChild(opt);
    return;
  }
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    selectEl.appendChild(opt);
  }
  if (selectedModel) {
    const match = models.find(m => m === selectedModel || m.startsWith(selectedModel + ':'));
    if (match) selectEl.value = match;
  }
}

function _setBadge(id, key) {
  const el = $(id);
  if (!el) return;
  el.textContent = key ? '✓' : '—';
  el.className   = `settings-badge ${key ? 'ok' : ''}`;
}

function wireModelsPage() {
  // External links
  $('groqLink')?.addEventListener('click',   () => window.electronAPI?.openExternal?.('https://console.groq.com'));
  $('geminiLink')?.addEventListener('click', () => window.electronAPI?.openExternal?.('https://aistudio.google.com/app/apikey'));
  $('braveLink')?.addEventListener('click',  () => window.electronAPI?.openExternal?.('https://api.search.brave.com/app/keys'));

  // Groq
  $('saveGroqKeyBtn')?.addEventListener('click', async () => {
    const key = $('groqApiKeyInput')?.value?.trim() || '';
    await window.electronAPI?.saveGroqKey?.(key);
    _setBadge('badge-groq', key);
    showToast(key ? 'Groq key saved' : 'Groq key cleared', key ? 'ok' : 'info');
  });
  $('testGroqBtn')?.addEventListener('click', async () => {
    const key = $('groqApiKeyInput')?.value?.trim() || '';
    if (!key) { showToast('Enter a Groq API key first', 'warn'); return; }
    showToast('Testing Groq…', 'info');
    try {
      const res = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${key}` }
      });
      if (res.ok) { showToast('Groq ✓ connected', 'ok'); _setBadge('badge-groq', key); }
      else showToast(`Groq error ${res.status}`, 'err');
    } catch (e) { showToast(`Groq failed: ${e.message}`, 'err'); }
  });

  // Gemini
  $('saveGeminiKeyBtn')?.addEventListener('click', async () => {
    const key = $('geminiApiKeyInput')?.value?.trim() || '';
    await window.electronAPI?.saveGeminiKey?.(key);
    _setBadge('badge-gemini-models', key);
    showToast(key ? 'Gemini key saved' : 'Gemini key cleared', key ? 'ok' : 'info');
  });
  $('testGeminiBtn')?.addEventListener('click', async () => {
    const key = $('geminiApiKeyInput')?.value?.trim() || '';
    if (!key) { showToast('Enter a Gemini API key first', 'warn'); return; }
    showToast('Testing Gemini…', 'info');
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=1`
      );
      if (res.ok) { showToast('Gemini ✓ connected', 'ok'); _setBadge('badge-gemini-models', key); }
      else showToast(`Gemini error ${res.status}`, 'err');
    } catch (e) { showToast(`Gemini failed: ${e.message}`, 'err'); }
  });

  // Brave Search
  $('saveBraveKeyBtn')?.addEventListener('click', async () => {
    const key = $('braveApiKeyInput')?.value?.trim() || '';
    await window.electronAPI?.saveBraveKey?.(key);
    _setBadge('badge-brave-models', key);
    showToast(key ? 'Brave Search key saved' : 'Brave Search key cleared', key ? 'ok' : 'info');
  });
  $('testBraveBtn')?.addEventListener('click', async () => {
    const key = $('braveApiKeyInput')?.value?.trim() || '';
    if (!key) { showToast('Enter a Brave API key first', 'warn'); return; }
    showToast('Testing Brave Search…', 'info');
    try {
      const res = await fetch('https://api.search.brave.com/res/v1/web/search?q=test&count=1', {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': key }
      });
      if (res.ok) { showToast('Brave Search ✓ connected', 'ok'); _setBadge('badge-brave-models', key); }
      else showToast(`Brave error ${res.status}`, 'err');
    } catch (e) { showToast(`Brave failed: ${e.message}`, 'err'); }
  });

  // OpenRouter
  $('openrouterLink')?.addEventListener('click', () => window.electronAPI?.openExternal?.('https://openrouter.ai/keys'));
  $('saveOpenRouterKeyBtn')?.addEventListener('click', async () => {
    const key = $('openrouterApiKeyInput')?.value?.trim() || '';
    await window.electronAPI?.saveOpenRouterKey?.(key);
    _setBadge('badge-openrouter', key);
    showToast(key ? 'OpenRouter key saved' : 'OpenRouter key cleared', key ? 'ok' : 'info');
  });
  $('testOpenRouterBtn')?.addEventListener('click', async () => {
    const key = $('openrouterApiKeyInput')?.value?.trim() || '';
    if (!key) { showToast('Enter an OpenRouter API key first', 'warn'); return; }
    showToast('Testing OpenRouter…', 'info');
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: `Bearer ${key}` }
      });
      if (res.ok) {
        const data = await res.json();
        const count = data?.data?.length || 0;
        showToast(`OpenRouter ✓ — ${count} models available`, 'ok');
        _setBadge('badge-openrouter', key);
      } else {
        showToast(`OpenRouter error ${res.status}`, 'err');
      }
    } catch (e) { showToast(`OpenRouter failed: ${e.message}`, 'err'); }
  });

  $('saveModelSlotsBtn')?.addEventListener('click', async () => {
    const slotKeys = ['chat', 'vision', 'cloud'];
    for (const slot of slotKeys) {
      const type  = $(`slot-${slot}-type`)?.value;
      const model = $(`slot-${slot}-model`)?.value;
      if (type && model) _modelSlots[slot] = { type, model };
    }
    await window.electronAPI?.saveModelSlots?.(_modelSlots);
    showToast('Model slots saved', 'ok');
  });
}

// ── Memory management ─────────────────────────────────────────────────────────

let _memoryEntries  = [];
let _memoryFilter   = '';
let _memoryCatFilter = 'all';

async function loadMemory() {
  _memoryEntries = await window.electronAPI?.getMemory?.() || [];
  renderMemoryList();
}

function _relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 30)  return `${d}d ago`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const CAT_LABEL = { fact: 'Fact', preference: 'Pref', project: 'Project', entity: 'Entity', procedural: 'Behavior' };
const CAT_COLORS = { fact: 'fact', preference: 'pref', project: 'proj', entity: 'ent', procedural: 'proc' };

function _decayScore(entry) {
  const LAMBDA = 0.04;
  const ageDays = (Date.now() - (entry.last_reinforced || entry.created_at || Date.now())) / 86400000;
  return Math.exp(-LAMBDA * ageDays); // 1.0 = fresh, approaches 0 over months
}

function renderMemoryList() {
  const container = $('memoryList');
  const countEl   = $('memoryCount');
  if (!container) return;

  const q = _memoryFilter.trim().toLowerCase();
  let visible = _memoryCatFilter === 'all'
    ? [..._memoryEntries]
    : _memoryEntries.filter(e => (e.category || 'fact') === _memoryCatFilter);
  if (q) visible = visible.filter(e => e.content.toLowerCase().includes(q));

  if (countEl) countEl.textContent = `${_memoryEntries.length} memor${_memoryEntries.length === 1 ? 'y' : 'ies'}`;

  if (visible.length === 0) {
    container.innerHTML = q || _memoryCatFilter !== 'all'
      ? '<div class="memory-empty">No memories match that filter.</div>'
      : '<div class="memory-empty">No memories yet. Say "remember that…" in chat, or add one below.</div>';
    return;
  }

  container.innerHTML = '';
  for (const entry of visible) {
    const row = document.createElement('div');
    row.className = 'memory-row';

    // Decay bar (thin strip at left edge)
    const decay  = _decayScore(entry);
    const decayBar = document.createElement('div');
    decayBar.className = 'memory-decay-bar';
    decayBar.style.setProperty('--decay', decay.toFixed(3));
    decayBar.title = `Relevance weight: ${Math.round(decay * 100)}% (decays over time, refreshed on recall)`;

    // Editable content
    const input = document.createElement('input');
    input.type      = 'text';
    input.value     = entry.content;
    input.className = 'memory-row-input';
    input.addEventListener('change', async () => {
      const res = await window.electronAPI?.updateMemory?.(entry.id, input.value.trim());
      if (res?.success) showToast('Memory updated', 'ok');
      else showToast('Update failed', 'err');
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = entry.content; input.blur(); }
    });

    // Meta row: category + source + time
    const meta = document.createElement('div');
    meta.className = 'memory-row-meta';

    const cat = entry.category || 'fact';
    const catTag = document.createElement('span');
    catTag.className = `memory-cat-tag memory-cat-${CAT_COLORS[cat] || 'fact'}`;
    catTag.textContent = CAT_LABEL[cat] || cat;

    const sourceTag = document.createElement('span');
    sourceTag.className = `memory-source memory-source-${entry.source}`;
    sourceTag.textContent = entry.source === 'explicit' ? 'chat' : entry.source;
    sourceTag.title = `Added via: ${entry.source}`;

    const timeTag = document.createElement('span');
    timeTag.className = 'memory-row-time';
    timeTag.textContent = _relTime(entry.created_at);
    timeTag.title = entry.created_at ? new Date(entry.created_at).toLocaleString() : '';

    meta.appendChild(catTag);
    meta.appendChild(sourceTag);
    meta.appendChild(timeTag);

    // Delete button
    const del = document.createElement('button');
    del.className = 'memory-delete-btn';
    del.textContent = '×';
    del.title = 'Delete this memory';
    del.addEventListener('click', async () => {
      await window.electronAPI?.deleteMemory?.(entry.id);
      _memoryEntries = _memoryEntries.filter(e => e.id !== entry.id);
      renderMemoryList();
      showToast('Memory deleted', 'ok');
    });

    row.appendChild(decayBar);
    row.appendChild(input);
    row.appendChild(meta);
    row.appendChild(del);
    container.appendChild(row);
  }
}

async function addMemoryEntry() {
  const input    = $('newMemoryInput');
  const catSel   = $('newMemoryCategory');
  const content  = input?.value?.trim();
  const category = catSel?.value || 'fact';
  if (!content) return;
  const res = await window.electronAPI?.addMemory?.(content, category);
  if (res?.success) {
    input.value = '';
    await loadMemory();
    showToast('Memory saved', 'ok');
  } else {
    showToast('Failed to save memory', 'err');
  }
}

function wireMemoryEvents() {
  $('addMemoryBtn')?.addEventListener('click', addMemoryEntry);
  $('newMemoryInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') addMemoryEntry();
  });

  $('memorySearchInput')?.addEventListener('input', e => {
    _memoryFilter = e.target.value;
    renderMemoryList();
  });

  // Category filter tabs
  $('memoryCats')?.addEventListener('click', e => {
    const btn = e.target.closest('.memory-cat');
    if (!btn) return;
    $('memoryCats').querySelectorAll('.memory-cat').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _memoryCatFilter = btn.dataset.cat;
    renderMemoryList();
  });

  $('clearAllMemoryBtn')?.addEventListener('click', async () => {
    if (!confirm(`Delete all ${_memoryEntries.length} memories? This cannot be undone.`)) return;
    const res = await window.electronAPI?.clearAllMemory?.();
    if (res?.success) {
      _memoryEntries = [];
      renderMemoryList();
      showToast('All memories cleared', 'ok');
    } else {
      showToast('Failed to clear memories', 'err');
    }
  });
}

// ── Voice / Whisper settings ──────────────────────────────────────────────────

async function loadWhisperConfig() {
  const cfg = await window.electronAPI?.getWhisperConfig?.() || {};
  const exeInput   = $('whisperExePath');
  const modelInput = $('whisperModelPath');
  if (exeInput)   exeInput.value   = cfg.exePath   || '';
  if (modelInput) modelInput.value = cfg.modelPath || '';
  _updateWhisperBadge(cfg);
}

function _updateWhisperBadge(cfg) {
  const badge = $('badge-whisper');
  if (!badge) return;
  if (cfg.exePath && cfg.modelPath) {
    setBadge(badge, 'ok', 'Configured');
  } else {
    setBadge(badge, 'warn', 'Not set');
  }
}

async function loadTtsCard() {
  // Populate voice list from browser SpeechSynthesis
  const sel = $('ttsVoiceSelect');
  if (sel && window.speechSynthesis) {
    const populate = () => {
      const voices = window.speechSynthesis.getVoices();
      // Keep "System default" option, then add available voices
      while (sel.options.length > 1) sel.remove(1);
      for (const v of voices) {
        const opt = document.createElement('option');
        opt.value = v.name;
        opt.textContent = `${v.name} (${v.lang})`;
        sel.appendChild(opt);
      }
    };
    populate();
    window.speechSynthesis.onvoiceschanged = populate;
  }

  try {
    const cfg = await window.electronAPI?.getTtsConfig?.();
    if (cfg) {
      const autoRead = $('ttsAutoRead');
      const rate     = $('ttsRate');
      const pitch    = $('ttsPitch');
      const rateVal  = $('ttsRateVal');
      const pitchVal = $('ttsPitchVal');
      if (autoRead) autoRead.checked = !!cfg.autoRead;
      if (rate)     { rate.value   = cfg.rate  ?? 1.0; if (rateVal)  rateVal.textContent  = `${(cfg.rate  ?? 1.0).toFixed(1)}×`; }
      if (pitch)    { pitch.value  = cfg.pitch ?? 1.0; if (pitchVal) pitchVal.textContent = (cfg.pitch ?? 1.0).toFixed(1); }
      if (sel && cfg.voice) sel.value = cfg.voice;
      setBadge($('badge-tts'), cfg.autoRead ? 'ok' : 'warn', cfg.autoRead ? 'Auto-read' : 'Off');
    }
  } catch {}
}

function wireVoiceEvents() {
  $('saveWhisperBtn')?.addEventListener('click', async () => {
    const cfg = {
      exePath:   ($('whisperExePath')?.value   || '').trim(),
      modelPath: ($('whisperModelPath')?.value || '').trim(),
    };
    const res = await window.electronAPI?.saveWhisperConfig?.(cfg);
    if (res?.success) {
      _updateWhisperBadge(cfg);
      showToast('Whisper config saved', 'ok');
    } else {
      showToast('Save failed', 'err');
    }
  });

  $('testWhisperBtn')?.addEventListener('click', async () => {
    const cfg = {
      exePath:   ($('whisperExePath')?.value   || '').trim(),
      modelPath: ($('whisperModelPath')?.value || '').trim(),
    };
    if (!cfg.exePath || !cfg.modelPath) {
      showToast('Fill in both paths first', 'warn'); return;
    }
    showToast('Checking paths…', 'info');
    // Ask main process to verify files exist via a quick test
    const res = await window.electronAPI?.saveWhisperConfig?.(cfg);
    // Just verify the config was saved; real test happens on first use
    if (res?.success) {
      _updateWhisperBadge(cfg);
      showToast('Paths saved — will be tested on first voice use', 'ok');
    }
  });

  // TTS live range labels
  $('ttsRate')?.addEventListener('input',  e => { const v = $('ttsRateVal');  if (v) v.textContent = `${parseFloat(e.target.value).toFixed(1)}×`; });
  $('ttsPitch')?.addEventListener('input', e => { const v = $('ttsPitchVal'); if (v) v.textContent = parseFloat(e.target.value).toFixed(1); });

  $('saveTtsBtn')?.addEventListener('click', async () => {
    const cfg = {
      autoRead: !!$('ttsAutoRead')?.checked,
      voice:    $('ttsVoiceSelect')?.value || '',
      rate:     parseFloat($('ttsRate')?.value  || '1'),
      pitch:    parseFloat($('ttsPitch')?.value || '1'),
    };
    const res = await window.electronAPI?.saveTtsConfig?.(cfg);
    if (res?.success) {
      setBadge($('badge-tts'), cfg.autoRead ? 'ok' : 'warn', cfg.autoRead ? 'Auto-read' : 'Off');
      showToast('Voice output settings saved', 'ok');
    } else {
      showToast('Failed to save TTS settings', 'err');
    }
  });

  $('testTtsBtn')?.addEventListener('click', () => {
    if (!window.speechSynthesis) { showToast('SpeechSynthesis not available', 'err'); return; }
    window.speechSynthesis.cancel();
    const voices = window.speechSynthesis.getVoices();
    const voiceName = $('ttsVoiceSelect')?.value || '';
    const utt = new SpeechSynthesisUtterance("Hello! I'm Friday, your personal AI assistant.");
    if (voiceName) {
      const v = voices.find(v => v.name === voiceName);
      if (v) utt.voice = v;
    }
    utt.rate  = parseFloat($('ttsRate')?.value  || '1');
    utt.pitch = parseFloat($('ttsPitch')?.value || '1');
    window.speechSynthesis.speak(utt);
  });
}

// ── Wake word settings ────────────────────────────────────────────────────────

async function loadWakeWordCard() {
  try {
    const cfg = await window.electronAPI?.getWakeWordConfig?.();
    if (!cfg) return;
    const enabled = $('wakeWordEnabled');
    const phrase  = $('wakeWordPhrase');
    const badge   = $('badge-wake-word');
    if (enabled) enabled.checked = !!cfg.enabled;
    if (phrase)  phrase.value    = cfg.phrase || 'hey friday';
    if (badge)   setBadge(badge, cfg.enabled ? 'ok' : 'warn', cfg.enabled ? `"${cfg.phrase}"` : 'Off');
  } catch (e) {
    console.warn('[Settings] loadWakeWordCard error:', e.message);
  }
}

// ── Persona / custom system prompt ────────────────────────────────────────────

async function loadPersona() {
  const text = await window.electronAPI?.getCustomPrompt?.() || '';
  const ta = $('customPromptTextarea');
  if (ta) ta.value = text;
}

function wirePersonaEvents() {
  $('savePersonaBtn')?.addEventListener('click', async () => {
    const text = $('customPromptTextarea')?.value || '';
    const res = await window.electronAPI?.saveCustomPrompt?.(text);
    if (res?.success) showToast('Persona saved', 'ok');
    else showToast('Save failed', 'err');
  });

  $('clearPersonaBtn')?.addEventListener('click', async () => {
    const ta = $('customPromptTextarea');
    if (ta) ta.value = '';
    await window.electronAPI?.saveCustomPrompt?.('');
    showToast('Persona cleared', 'ok');
  });
}

// ── Training page ─────────────────────────────────────────────────────────────

function _formatLabel(format) {
  return { openai: 'OpenAI chat', alpaca: 'Alpaca', raw: 'Raw pairs' }[format] || format;
}

async function loadTrainingPage() {
  const examples = await window.electronAPI?.getFeedbackExamples?.() || [];
  const countEl  = $('trainingCount');
  if (countEl) countEl.textContent = `${examples.length} approved example${examples.length !== 1 ? 's' : ''} collected`;
}

function wireTrainingEvents() {
  $('trainingPreviewBtn')?.addEventListener('click', async () => {
    const format     = $('trainingFormatSelect')?.value || 'openai';
    const filterMode = $('trainingFilterMode')?.checked || false;
    const examples   = await window.electronAPI?.getFeedbackExamples?.() || [];
    const filtered   = filterMode ? examples.filter(e => e.app_mode === 'chat') : examples;
    const preview    = $('trainingPreview');
    if (!preview) return;

    if (filtered.length === 0) {
      preview.style.display = 'block';
      preview.textContent   = 'No examples yet. Rate responses with 👍 during chat to build the dataset.';
      return;
    }

    const sample = filtered.slice(0, 3).map(ex => {
      if (format === 'openai') {
        return JSON.stringify({ messages: [
          { role: 'user',      content: ex.user_message.slice(0, 80) + '…' },
          { role: 'assistant', content: ex.assistant_response.slice(0, 80) + '…' }
        ]}, null, 2);
      } else if (format === 'alpaca') {
        return JSON.stringify({ instruction: ex.user_message.slice(0, 80) + '…', input: '', output: ex.assistant_response.slice(0, 80) + '…' }, null, 2);
      }
      return JSON.stringify({ user: ex.user_message.slice(0, 80) + '…', assistant: ex.assistant_response.slice(0, 80) + '…' }, null, 2);
    }).join('\n\n');

    preview.style.display = 'block';
    preview.textContent   = `// ${_formatLabel(format)} — showing ${Math.min(3, filtered.length)} of ${filtered.length} examples\n\n${sample}`;
  });

  $('trainingExportBtn')?.addEventListener('click', async () => {
    const format     = $('trainingFormatSelect')?.value || 'openai';
    const filterMode = $('trainingFilterMode')?.checked || false;
    const btn = $('trainingExportBtn');
    if (btn) btn.disabled = true;
    try {
      const result = await window.electronAPI?.exportTrainingData?.({ format, filterMode });
      if (result?.success) {
        showToast(`Exported ${result.count} examples to ${result.path.split(/[\\/]/).pop()}`, 'ok');
      } else if (result?.error !== 'Cancelled') {
        showToast(result?.error || 'Export failed', 'err');
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

// ── DOMContentLoaded ─────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', async () => {
  if (!window.electronAPI) {
    showToast('electronAPI not available (preload)', 'err');
    return;
  }
  wireEvents();
  wireVoiceEvents();
  wirePersonaEvents();
  wireTrainingEvents();
  await loadSettings();
  await Promise.all([refreshIntegrationsStatus(), loadIntegrationsPage()]);
  switchPage('integrations');
});
