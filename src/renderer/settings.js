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
    // Persist the key so the main-process service uses it, then test via IPC
    // (browser fetch to api.groq.com is blocked by CORS).
    await window.electronAPI?.saveGroqKey?.(key);
    const res = await window.electronAPI?.testIntegration?.('groq');
    if (res?.success) {
      showToast(`Groq ✓ — ${res.details?.modelCount ?? 0} models available`, 'ok');
      _setBadge('badge-groq', key);
    } else {
      showToast(`Groq failed: ${res?.error || 'unknown error'}`, 'err');
    }
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
    await window.electronAPI?.saveGeminiKey?.(key);
    const res = await window.electronAPI?.testIntegration?.('gemini');
    if (res?.success) {
      showToast(`Gemini ✓ — ${res.details?.modelCount ?? 0} models available`, 'ok');
      _setBadge('badge-gemini-models', key);
    } else {
      showToast(`Gemini failed: ${res?.error || 'unknown error'}`, 'err');
    }
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
    await window.electronAPI?.saveBraveKey?.(key);
    const res = await window.electronAPI?.testIntegration?.('brave');
    if (res?.success) {
      showToast(`Brave ✓ — ${res.details?.resultCount ?? 0} results`, 'ok');
      _setBadge('badge-brave-models', key);
    } else {
      showToast(`Brave failed: ${res?.error || 'unknown error'}`, 'err');
    }
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
    await window.electronAPI?.saveOpenRouterKey?.(key);
    const res = await window.electronAPI?.testIntegration?.('openrouter');
    if (res?.success) {
      showToast(`OpenRouter ✓ — ${res.details?.modelCount ?? 0} models available`, 'ok');
      _setBadge('badge-openrouter', key);
    } else {
      showToast(`OpenRouter failed: ${res?.error || 'unknown error'}`, 'err');
    }
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
  const useCpuEl   = $('whisperUseCpu');
  const extraEl    = $('whisperExtraArgs');
  if (exeInput)   exeInput.value   = cfg.exePath   || '';
  if (modelInput) modelInput.value = cfg.modelPath || '';
  if (useCpuEl)   useCpuEl.checked = !!cfg.useCpu;
  if (extraEl)    extraEl.value    = cfg.extraArgs || '';
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
      useCpu:    !!$('whisperUseCpu')?.checked,
      extraArgs: ($('whisperExtraArgs')?.value || '').trim(),
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
      useCpu:    !!$('whisperUseCpu')?.checked,
      extraArgs: ($('whisperExtraArgs')?.value || '').trim(),
    };
    if (!cfg.exePath || !cfg.modelPath) {
      showToast('Fill in both paths first', 'warn'); return;
    }
    showToast('Saving and running test transcription…', 'info');
    const save = await window.electronAPI?.saveWhisperConfig?.(cfg);
    if (!save?.success) { showToast('Save failed', 'err'); return; }
    _updateWhisperBadge(cfg);
    // Smoke-test the binary on a 1-second silence WAV so users find out NOW
    // (not on first wake-word fire) whether their build can initialize.
    try {
      if (typeof window.WakeWordDetector?._encodeWav !== 'function') {
        showToast('Saved (transcribe test unavailable)', 'ok'); return;
      }
      const silence = new Float32Array(16000); // 1s of zeros at 16kHz
      const wav     = window.WakeWordDetector._encodeWav([silence], 16000);
      const res     = await window.electronAPI?.transcribeAudio?.(wav, 'audio/wav');
      if (res?.success) {
        showToast('Whisper ✓ initialized successfully', 'ok');
      } else {
        const err = res?.error || 'unknown error';
        const isInitFail = /failed to initialize whisper context|cuda|gpu/i.test(err);
        showToast(
          isInitFail
            ? 'Whisper failed to start — try checking "Force CPU mode"'
            : `Whisper error: ${err.slice(0, 140)}`,
          'err'
        );
      }
    } catch (err) {
      showToast(`Test error: ${err.message || err}`, 'err');
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

  // ── Mic / wake-word diagnostics ────────────────────────────────────────
  $('micTestBtn')?.addEventListener('click', () => runMicLevelTest());
  $('wakeTestBtn')?.addEventListener('click', () => runWakePhraseTest());
}

// Live RMS meter — opens the mic for 5s, shows peak vs the WakeWordDetector
// threshold (0.012 by default). Lets users see whether their mic is being
// picked up at all and whether their normal speaking volume crosses the
// trigger threshold.
const _MIC_TEST_THRESHOLD = 0.012; // matches WakeWordDetector default

let _micTestRunning = false;
async function runMicLevelTest() {
  if (_micTestRunning) return;
  const btn    = $('micTestBtn');
  const status = $('micTestStatus');
  const fill   = $('micMeterFill');
  const result = $('micTestResult');
  if (!btn || !status || !fill || !result) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    result.textContent = 'Microphone API not available.';
    return;
  }

  let stream, ctx;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    result.textContent = `Mic permission denied: ${err.message || err}`;
    return;
  }
  try {
    ctx = new AudioContext();
  } catch (err) {
    stream.getTracks().forEach(t => t.stop());
    result.textContent = `AudioContext failed: ${err.message || err}`;
    return;
  }

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);

  _micTestRunning = true;
  btn.disabled = true;
  status.textContent = 'Listening… speak normally.';
  result.textContent = '';

  const buf = new Float32Array(analyser.fftSize);
  let peak = 0, sum = 0, samples = 0, displayPeak = 0;
  const start = performance.now();
  const DURATION_MS = 5000;

  await new Promise(resolve => {
    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let s = 0;
      for (const v of buf) s += v * v;
      const rms = Math.sqrt(s / buf.length);
      sum += rms; samples++;
      if (rms > peak) peak = rms;
      // Peak-hold display: decays slowly while live RMS pushes it up.
      displayPeak = Math.max(rms, displayPeak * 0.92);
      // Map [0..0.05] → [0..100%] with mild log curve so quiet voices show up.
      const pct = Math.min(100, Math.pow(displayPeak / 0.05, 0.7) * 100);
      fill.style.width = pct.toFixed(1) + '%';
      // Tint red when the live level crosses the wake-word threshold.
      fill.style.background = (rms >= _MIC_TEST_THRESHOLD)
        ? 'linear-gradient(90deg,#3a8,#cd6)'
        : 'linear-gradient(90deg,#3a8,#5d3)';
      if (performance.now() - start < DURATION_MS) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });

  // Tear down
  try { stream.getTracks().forEach(t => t.stop()); } catch {}
  try { await ctx.close(); } catch {}
  fill.style.width = '0%';
  status.textContent = 'Click to listen for 5 seconds.';

  const avg = samples > 0 ? sum / samples : 0;
  const verdict = peak < 0.0005
    ? 'No signal — is the right mic selected in Windows Sound settings?'
    : peak < _MIC_TEST_THRESHOLD
      ? 'Mic works but you were quieter than the wake-word threshold. Speak louder or move closer.'
      : 'Mic works and crossed the wake-word threshold — wake word should trigger.';
  result.innerHTML = `Peak: <strong>${peak.toFixed(4)}</strong> · Avg: <strong>${avg.toFixed(4)}</strong> · Threshold: <strong>${_MIC_TEST_THRESHOLD}</strong><br>${verdict}`;
  btn.disabled = false;
  _micTestRunning = false;
}

// Records 4 seconds via AudioWorklet → WAV (no ffmpeg needed), sends to
// whisper-cli, then matches the result against the configured wake phrase.
// Uses the SAME pipeline as WakeWordDetector so the test result accurately
// reflects what wake word will do in production.
let _wakeTestRunning = false;
async function runWakePhraseTest() {
  if (_wakeTestRunning) return;
  const btn    = $('wakeTestBtn');
  const status = $('wakeTestStatus');
  const result = $('wakeTestResult');
  if (!btn || !status || !result) return;

  // Reuse the in-form values so the user doesn't have to save first.
  const phrase = ($('wakeWordPhrase')?.value || 'hey friday').trim().toLowerCase();
  const cfg    = await window.electronAPI?.getWhisperConfig?.();
  if (!cfg?.exePath || !cfg?.modelPath) {
    result.innerHTML = '<span style="color:#e88">Whisper isn\'t configured. Set whisper-cli + model paths above first.</span>';
    return;
  }

  let stream, ctx, worklet, source, silencer;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    result.innerHTML = `<span style="color:#e88">Mic permission denied: ${err.message || err}</span>`;
    return;
  }
  try {
    ctx = new AudioContext({ sampleRate: 16000 });
  } catch (err) {
    stream.getTracks().forEach(t => t.stop());
    result.innerHTML = `<span style="color:#e88">AudioContext failed: ${err.message || err}</span>`;
    return;
  }

  // Reuse the inline worklet bundled with WakeWordDetector — same encoder,
  // same WAV bytes the production wake path will produce.
  const workletCode = `
    class PCMCaptureProcessor extends AudioWorkletProcessor {
      process(inputs) {
        const ch = inputs[0]?.[0];
        if (ch && ch.length > 0) this.port.postMessage(new Float32Array(ch));
        return true;
      }
    }
    registerProcessor('settings-pcm-capture', PCMCaptureProcessor);
  `;
  try {
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    const url  = URL.createObjectURL(blob);
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  } catch (err) {
    stream.getTracks().forEach(t => t.stop());
    try { await ctx.close(); } catch {}
    result.innerHTML = `<span style="color:#e88">AudioWorklet failed: ${err.message || err}. CSP or browser support issue?</span>`;
    return;
  }

  _wakeTestRunning = true;
  btn.disabled = true;
  result.textContent = '';

  const frames = [];
  try {
    worklet  = new AudioWorkletNode(ctx, 'settings-pcm-capture');
    source   = ctx.createMediaStreamSource(stream);
    silencer = ctx.createGain();
    silencer.gain.value = 0;
    source.connect(worklet);
    worklet.connect(silencer);
    silencer.connect(ctx.destination);
    worklet.port.onmessage = (e) => { frames.push(e.data); };
  } catch (err) {
    stream.getTracks().forEach(t => t.stop());
    try { await ctx.close(); } catch {}
    result.innerHTML = `<span style="color:#e88">Capture wiring failed: ${err.message || err}</span>`;
    btn.disabled = false; _wakeTestRunning = false;
    return;
  }

  // Visual countdown
  const DURATION_MS = 4000;
  const startedAt = performance.now();
  const tickStatus = () => {
    const remaining = Math.max(0, Math.ceil((DURATION_MS - (performance.now() - startedAt)) / 1000));
    status.textContent = remaining > 0 ? `Listening… ${remaining}s` : 'Transcribing…';
    if (remaining > 0 && _wakeTestRunning) requestAnimationFrame(tickStatus);
  };
  tickStatus();

  await new Promise(r => setTimeout(r, DURATION_MS));

  // Tear down audio pipeline
  try { worklet.disconnect(); source.disconnect(); silencer.disconnect(); } catch {}
  stream.getTracks().forEach(t => t.stop());
  try { await ctx.close(); } catch {}

  status.textContent = 'Transcribing…';
  try {
    if (typeof window.WakeWordDetector?._encodeWav !== 'function') {
      result.innerHTML = '<span style="color:#e88">WakeWordDetector script not loaded.</span>';
      return;
    }
    const wavBytes = window.WakeWordDetector._encodeWav(frames, 16000);
    const res      = await window.electronAPI?.transcribeAudio?.(wavBytes, 'audio/wav');
    if (!res?.success) {
      const err = res?.error || 'unknown error';
      const escErr = String(err).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const isInitFail = /failed to initialize whisper context|cuda|gpu|compute capability/i.test(err);
      const hint = isInitFail
        ? '<br><span style="color:#fc8">Hint: your whisper.cpp build may not support this GPU. Try enabling <strong>"Force CPU mode"</strong> in the Whisper card above and re-test.</span>'
        : '';
      result.innerHTML = `<span style="color:#e88">Transcription failed: ${escErr}</span>${hint}`;
    } else if (!res.transcript) {
      result.innerHTML = '<span style="color:var(--t-mid)">Whisper returned no text. Try speaking louder or check the mic test above.</span>';
    } else {
      const text  = res.transcript;
      const lower = text.toLowerCase().trim();
      const matched = lower.includes(phrase);
      const tail = matched ? lower.replace(phrase, '').trim() : '';
      const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      result.innerHTML = matched
        ? `Heard: <strong>"${escape(text)}"</strong><br><span style="color:#6c6">✓ Wake phrase "${escape(phrase)}" detected.</span>` +
          (tail ? `<br>Would submit command: <strong>"${escape(tail)}"</strong>` : '<br>(no command after the phrase — mic would auto-activate)')
        : `Heard: <strong>"${escape(text)}"</strong><br><span style="color:#e88">✗ Phrase "${escape(phrase)}" not found in transcript.</span>`;
    }
  } catch (err) {
    result.innerHTML = `<span style="color:#e88">Test failed: ${err.message || err}</span>`;
  } finally {
    status.textContent = 'Records 4s and transcribes via Whisper.';
    btn.disabled = false;
    _wakeTestRunning = false;
  }
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
