/**
 * ModelSelector — compact pill + popover model picker.
 *
 * Public API:
 *   getSelectedModel()  → { model, modelType }
 *   setHasImage(bool)   — switches to vision slot when true
 *   isCurrentModelVision() → bool
 *   updateSlot(key, model, type)
 *   getSlots()
 */

const VISION_PATTERNS = [
  /llava/i, /vision/i, /qwen.*vl/i, /vl\d/i,
  /moondream/i, /bakllava/i, /minicpm.v/i, /cogvlm/i, /internvl/i
];

const PROVIDER_COLOR = {
  ollama:      '#4caf50',
  groq:        '#f4733a',
  gemini:      '#4a8de0',
  openrouter:  '#9c6ade',
};

const PROVIDER_LABEL = {
  ollama:      'Ollama',
  groq:        'Groq',
  gemini:      'Gemini',
  openrouter:  'OpenRouter',
};

class ModelSelector {
  constructor() {
    this._pillBtn  = document.getElementById('modelPillBtn');
    this._pillDot  = document.getElementById('modelPillDot');
    this._pillName = document.getElementById('modelPillName');
    this._picker   = document.getElementById('modelPicker');
    this._tabsEl   = document.getElementById('modelPickerTabs');
    this._listEl   = document.getElementById('modelPickerList');

    // State
    this.currentModelType = 'ollama';
    this.currentModel     = 'gpt-oss:20b';
    this.ollamaModels        = [];
    this.groqModels          = [];
    this.geminiModels        = [];
    this.openrouterModels    = [];
    this._configured         = { groq: false, gemini: false, openrouter: false };
    this._autoMode        = 'chat';
    this._hasImage        = false;
    this._incognito       = false;
    this._open            = false;

    this.slots = {
      chat:   { model: 'gpt-oss:20b',             type: 'ollama' },
      vision: { model: 'llama3.2-vision:11b',     type: 'ollama' },
      cloud:  { model: 'llama-3.3-70b-versatile', type: 'groq'   },
    };

    this.onModelChanged = null;

    this._createBackdrop();
    this._setup();
    this._init();
  }

  // ── Backdrop (the reliable way to close on outside click) ─────────────────

  _createBackdrop() {
    this._backdrop = document.createElement('div');
    this._backdrop.className = 'mp-backdrop hidden';
    document.body.appendChild(this._backdrop);
    this._backdrop.addEventListener('mousedown', () => this._closePicker());
  }

  // ── Setup ─────────────────────────────────────────────────────────────────

  _setup() {
    // Pill click → toggle picker
    this._pillBtn?.addEventListener('click', () => {
      this._open ? this._closePicker() : this._openPicker();
    });

    // Provider tab clicks
    this._tabsEl?.addEventListener('click', (e) => {
      const btn = e.target.closest('.mp-tab');
      if (!btn || btn.hidden) return;
      this._switchTab(btn.dataset.type);
    });

    // Model item clicks bubble up to picker — handled per-item in _renderList
  }

  async _init() {
    try {
      const saved = await window.electronAPI?.getModelSlots?.();
      if (saved) this.slots = { ...this.slots, ...saved };
    } catch {}

    await this._fetchModels();
    this._updateTabVisibility();
    this._applyAutoSlot();
  }

  // ── Model fetching ────────────────────────────────────────────────────────

  async _fetchModels() {
    try {
      const result = await window.electronAPI?.getModels?.();
      if (result?.success) {
        this.ollamaModels     = result.models.ollama      || [];
        this.groqModels       = result.models.groq        || [];
        this.geminiModels     = result.models.gemini      || [];
        this.openrouterModels = result.models.openrouter  || [];
        this._configured      = result.configured || { groq: false, gemini: false, openrouter: false };
      }
    } catch {}
  }

  async refreshModels() {
    await this._fetchModels();
    this._updateTabVisibility();
    if (this._open) this._renderList();
    this._applyAutoSlot();
  }

  _updateTabVisibility() {
    this._tabsEl?.querySelectorAll('.mp-tab').forEach(btn => {
      const type = btn.dataset.type;
      if (type === 'ollama') { btn.hidden = false; return; }
      btn.hidden = this._incognito || !this._configured[type];
    });
    // Cloud providers are blocked in incognito — force local.
    if (this._incognito && this.currentModelType !== 'ollama') {
      this.currentModelType = 'ollama';
    }
    // If current provider is now hidden, fall back to ollama
    if (this.currentModelType !== 'ollama' && !this._configured[this.currentModelType]) {
      this.currentModelType = 'ollama';
    }
  }

  setIncognito(on) {
    this._incognito = !!on;
    this._updateTabVisibility();
    if (this._incognito && this.currentModelType !== 'ollama') {
      this._applyAutoSlot();
    }
    this._updatePill();
    if (this._open) this._renderList();
  }

  // ── Picker open / close ───────────────────────────────────────────────────

  _openPicker() {
    this._open = true;
    this._picker?.classList.remove('hidden');
    this._backdrop?.classList.remove('hidden');
    this._setActiveTab(this.currentModelType);
    this._renderList();
  }

  _closePicker() {
    this._open = false;
    this._picker?.classList.add('hidden');
    this._backdrop?.classList.add('hidden');
  }

  _switchTab(type) {
    this.currentModelType = type;
    this._setActiveTab(type);
    this._renderList();
    this._notifyChanged();
    this._updatePill();
  }

  _setActiveTab(type) {
    this._tabsEl?.querySelectorAll('.mp-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.type === type);
    });
  }

  // ── Model list ────────────────────────────────────────────────────────────

  _renderList() {
    if (!this._listEl) return;
    const models = this._modelsForType(this.currentModelType);
    this._listEl.innerHTML = '';

    if (!models.length) {
      const empty = document.createElement('div');
      empty.className = 'mp-empty';
      empty.textContent = {
        ollama:      'No Ollama models — is Ollama running?',
        groq:        'No Groq models — add API key in Settings → Models',
        gemini:      'No Gemini models — add API key in Settings → Models',
        openrouter:  'No OpenRouter models — add API key in Settings → Models',
      }[this.currentModelType] || 'No models available';
      this._listEl.appendChild(empty);
      return;
    }

    for (const model of models) {
      const isVision = this.currentModelType === 'ollama' && VISION_PATTERNS.some(p => p.test(model));
      const isCurrent = model === this.currentModel;

      const item = document.createElement('button');
      item.className = 'mp-model-item' + (isCurrent ? ' selected' : '');
      item.innerHTML = `
        <span class="mp-model-icon">${isVision ? '👁' : this._modelIcon(model)}</span>
        <span class="mp-model-name">${model}</span>
        ${isCurrent ? '<span class="mp-model-check">✓</span>' : ''}
      `;
      item.addEventListener('click', () => {
        this._selectModel(model, this.currentModelType);
        this._closePicker();
      });
      this._listEl.appendChild(item);
    }
  }

  _modelIcon(model) {
    if (/coder|code/i.test(model))   return '💻';
    if (/llama/i.test(model))         return '🦙';
    if (/qwen/i.test(model))          return '🔷';
    if (/gemma/i.test(model))         return '♊';
    if (/mistral/i.test(model))       return '🌬';
    if (/deepseek/i.test(model))      return '🔍';
    if (/glm/i.test(model))           return '🧠';
    return '●';
  }

  // ── Selection ─────────────────────────────────────────────────────────────

  _selectModel(model, type) {
    this.currentModel     = model;
    this.currentModelType = type;
    this._updatePill();
    this._notifyChanged();
  }

  _updatePill() {
    const color = PROVIDER_COLOR[this.currentModelType] || '#888';
    if (this._pillDot)  this._pillDot.style.background = color;
    if (this._pillName) this._pillName.textContent = this._shortName(this.currentModel);
    if (this._pillBtn)  this._pillBtn.title = `${PROVIDER_LABEL[this.currentModelType]}: ${this.currentModel}`;
  }

  _shortName(model) {
    if (!model) return '…';
    if (model.length <= 20) return model;
    return model.slice(0, 18) + '…';
  }

  // ── Slot / mode API ───────────────────────────────────────────────────────


  setHasImage(hasImage) {
    this._hasImage = hasImage;
    this._applyAutoSlot();
  }

  _applyAutoSlot() {
    const key  = this._hasImage ? 'vision' : 'chat';
    const slot = this.slots[key];
    if (!slot) return;

    const models = this._modelsForType(slot.type);
    const match  = models.find(m => m === slot.model || m.startsWith(slot.model + ':'));
    this._selectModel(match || slot.model, slot.type);
  }

  async updateSlot(slotKey, model, type) {
    this.slots[slotKey] = { model, type };
    try { await window.electronAPI?.saveModelSlots?.(this.slots); } catch {}
  }

  getSlots() { return this.slots; }

  // ── Public query API ──────────────────────────────────────────────────────

  getSelectedModel() {
    return { model: this.currentModel, modelType: this.currentModelType };
  }

  isVisionModel(name) {
    if (this.currentModelType === 'gemini') return true;
    return VISION_PATTERNS.some(p => p.test(name));
  }

  isCurrentModelVision() {
    return this.currentModelType === 'gemini' || VISION_PATTERNS.some(p => p.test(this.currentModel));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _modelsForType(type) {
    if (type === 'gemini')     return this.geminiModels;
    if (type === 'groq')       return this.groqModels;
    if (type === 'openrouter') return this.openrouterModels;
    return this.ollamaModels;
  }

  _notifyChanged() {
    this.onModelChanged?.();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.modelSelector = new ModelSelector();
});
