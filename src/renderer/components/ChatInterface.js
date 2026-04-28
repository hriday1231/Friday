// AudioWorklet processor — captured as a Blob URL so no separate file is needed
const _WHISPER_WORKLET_CODE = `
class PCMCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch && ch.length > 0) this.port.postMessage(new Float32Array(ch));
    return true;
  }
}
registerProcessor('pcm-capture', PCMCaptureProcessor);
`;

/** Manages the artifacts side panel (large code blocks extracted from responses). */
class ArtifactsPanel {
  constructor() {
    this._panel    = document.getElementById('artifactsPanel');
    this._tabs     = document.getElementById('artifactsTabs');
    this._body     = document.getElementById('artifactsPanelBody');
    this._copyBtn  = document.getElementById('artifactCopyBtn');
    this._prevBtn  = document.getElementById('artifactPreviewBtn');
    this._closeBtn = document.getElementById('artifactCloseBtn');
    this._artifacts = []; // [{ id, name, lang, code }]
    this._activeId  = null;
    this._showPreview = false;

    this._closeBtn?.addEventListener('click', () => this.hide());
    this._copyBtn?.addEventListener('click',  () => this._copyActive());
    this._prevBtn?.addEventListener('click',  () => this._togglePreview());
  }

  /** Push a new artifact (or replace if same name). Returns the artifact id. */
  push(name, lang, code) {
    const existing = this._artifacts.find(a => a.name === name);
    if (existing) {
      existing.lang = lang;
      existing.code = code;
      if (this._activeId === existing.id) this._renderBody();
      this._renderTabs();
      return existing.id;
    }
    const id = `art-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    this._artifacts.push({ id, name, lang, code });
    this._renderTabs();
    this._activate(id);
    this._show();
    return id;
  }

  _show() {
    this._panel?.classList.remove('hidden');
    document.body.classList.add('has-artifacts');
  }

  hide() {
    this._panel?.classList.add('hidden');
    document.body.classList.remove('has-artifacts');
  }

  _activate(id) {
    this._activeId = id;
    this._showPreview = false;
    this._renderTabs();
    this._renderBody();
  }

  _renderTabs() {
    if (!this._tabs) return;
    this._tabs.innerHTML = '';
    for (const art of this._artifacts) {
      const tab = document.createElement('button');
      tab.className = 'artifact-tab' + (art.id === this._activeId ? ' active' : '');
      tab.title = art.name;
      tab.innerHTML = `<span class="artifact-tab-lang">${art.lang || 'code'}</span><span>${art.name}</span>`;
      tab.addEventListener('click', () => this._activate(art.id));
      this._tabs.appendChild(tab);
    }
  }

  _renderBody() {
    if (!this._body) return;
    const art = this._artifacts.find(a => a.id === this._activeId);
    if (!art) { this._body.innerHTML = ''; return; }

    const isHtml = art.lang === 'html';
    if (this._prevBtn) this._prevBtn.style.display = isHtml ? '' : 'none';

    this._body.innerHTML = '';
    if (this._showPreview && isHtml) {
      const wrap = document.createElement('div');
      wrap.className = 'artifact-preview-view';
      const iframe = document.createElement('iframe');
      iframe.sandbox = 'allow-scripts';
      iframe.srcdoc = art.code;
      wrap.appendChild(iframe);
      this._body.appendChild(wrap);
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'artifact-code-view';
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = art.lang ? `language-${art.lang}` : '';
      code.textContent = art.code;
      if (typeof hljs !== 'undefined') hljs.highlightElement(code);
      pre.appendChild(code);
      wrap.appendChild(pre);
      this._body.appendChild(wrap);
    }
  }

  _togglePreview() {
    this._showPreview = !this._showPreview;
    this._renderBody();
  }

  _copyActive() {
    const art = this._artifacts.find(a => a.id === this._activeId);
    if (!art) return;
    navigator.clipboard.writeText(art.code).then(() => {
      if (this._copyBtn) {
        this._copyBtn.title = 'Copied!';
        setTimeout(() => { if (this._copyBtn) this._copyBtn.title = 'Copy'; }, 2000);
      }
    });
  }

  clear() {
    this._artifacts = [];
    this._activeId  = null;
    this._renderTabs();
    this._body.innerHTML = '';
    this.hide();
  }
}

class ChatInterface {
  constructor() {
    this.messagesContainer = document.getElementById('chatMessages');
    this.userInput         = document.getElementById('userInput');
    this.sendBtn           = document.getElementById('sendBtn');
    this.clearChatBtn      = document.getElementById('clearChatBtn');
    this.searchToggleBtn   = document.getElementById('searchToggleBtn');
    this.attachBtn         = document.getElementById('attachBtn');
    this.micBtn            = document.getElementById('micBtn');
    this.stopBtn           = document.getElementById('stopBtn');
    this._recognition      = null;   // SpeechRecognition instance
    this._isListening      = false;
    this._whisperCtx       = null;
    this._whisperStream    = null;
    this._whisperWorklet   = null;
    this._whisperChunks    = null;
    this.imageInput        = document.getElementById('imageInput');
    this.previewStrip      = document.getElementById('imagePreviewStrip');
    this.visionWarning     = document.getElementById('visionWarning');
    this.forceSearch       = false;
    this._attachedImages   = []; // [{ data: base64, mimeType, name, previewUrl }]
    this._attachedDocs     = []; // pending for current message
    this._sessionDocs      = []; // docs kept in context for whole session
    this._removedDocs      = []; // docs removed from context but available to re-add
    this._currentSessionId = null; // active session id (for truncation)

    this._toolStreamBuffer = []; // accumulates chunks during a tool call for post-response display
    this._artifacts = new ArtifactsPanel();
    this._ttsConfig  = { autoRead: false, voice: '', rate: 1.0, pitch: 1.0 };
    this.setupEventListeners();
    this._setupToolConfirmation();

    // Load TTS config (async)
    window.electronAPI?.getTtsConfig?.().then(cfg => { if (cfg) this._ttsConfig = cfg; }).catch(() => {});

    // Load persisted session on startup (async — don't block constructor)
    this._loadActiveSession();
  }

  setupEventListeners() {
    this.sendBtn.addEventListener('click', () => this.sendMessage());

    this.userInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    // clearChatBtn / newChatBtn are handled by renderer.js (which also
    // refreshes the session list). Don't add a duplicate listener here.

    this.searchToggleBtn?.addEventListener('click', () => {
      this.forceSearch = !this.forceSearch;
      this.searchToggleBtn?.classList.toggle('active', this.forceSearch);
    });

    this.userInput.addEventListener('input', () => {
      this.userInput.style.height = 'auto';
      this.userInput.style.height = Math.min(this.userInput.scrollHeight, 150) + 'px';
    });

    // Stop button — cancel the active AgentRuntime turn
    this.stopBtn?.addEventListener('click', () => {
      const sid = this._currentSessionId;
      if (sid) {
        window.electronAPI?.cancelAgentMessage?.(sid);
      }
    });

    // Mic button — voice input
    this.micBtn?.addEventListener('click', () => this._toggleVoice());

    // ESC cancels recording
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this._isListening) this._stopVoice();
    });

    // ── Image attachment ──────────────────────────────────────────────────

    // Attach button → open file picker
    this.attachBtn?.addEventListener('click', () => this.imageInput?.click());

    // File picker selection
    this.imageInput?.addEventListener('change', (e) => {
      this._handleFiles(Array.from(e.target.files || []));
      e.target.value = ''; // allow re-selecting same file
    });

    // Paste image from clipboard
    document.addEventListener('paste', (e) => {
      const items = Array.from(e.clipboardData?.items || []);
      const imageItems = items.filter(item => item.kind === 'file' && item.type.startsWith('image/'));
      if (imageItems.length > 0) {
        e.preventDefault();
        this._handleFiles(imageItems.map(item => item.getAsFile()));
      }
    });

    // Open links in system browser instead of navigating Electron window
    this.messagesContainer.addEventListener('click', (e) => {
      const link = e.target.closest('a[href]');
      if (!link) return;
      e.preventDefault();
      const href = link.getAttribute('href');
      if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
        window.electronAPI?.openExternal?.(href);
      }
    });

    // Drag-and-drop — covers the whole chat area (messages + input).
    // Uses a counter to avoid flickering when the pointer crosses child elements.
    const chatArea = document.querySelector('.chat-area') || this.messagesContainer;
    let _dragCount = 0;
    chatArea.addEventListener('dragenter', (e) => {
      e.preventDefault();
      if (++_dragCount === 1) chatArea.classList.add('drag-over');
    });
    chatArea.addEventListener('dragover', (e) => { e.preventDefault(); });
    chatArea.addEventListener('dragleave', () => {
      if (--_dragCount === 0) chatArea.classList.remove('drag-over');
    });
    chatArea.addEventListener('drop', (e) => {
      e.preventDefault();
      _dragCount = 0;
      chatArea.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length > 0) this._handleFiles(files);
    });
  }

  // ── Attachment handling (images + documents) ─────────────────────────────

  _handleFiles(files) {
    files.forEach(file => {
      if (!file) return;
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (e) => {
          const dataUrl = e.target.result;
          const [header, data] = dataUrl.split(',');
          const mimeType = header.match(/:(.*?);/)?.[1] || file.type;
          this._addAttachment({ data, mimeType, name: file.name, previewUrl: dataUrl });
        };
        reader.readAsDataURL(file);
      } else {
        this._handleDocumentFile(file).catch(err => {
          console.error('[Files]', err);
          this._showVoiceError(`Could not read ${file.name}: ${err.message}`);
        });
      }
    });
  }

  async _handleDocumentFile(file) {
    const name  = file.name;
    const isPdf = file.type === 'application/pdf' || name.toLowerCase().endsWith('.pdf');

    if (isPdf) {
      // Parse in the renderer — pdfjs-dist needs browser APIs (ImageData, Path2D, canvas)
      // that only exist here, not in the Node.js main process.
      if (!window._pdfjsLib) {
        // Build absolute file:// URLs from the document location so the path
        // is always correct regardless of which script file triggers the import.
        // window.location.href → file:///…/Friday/src/renderer/index.html
        const appRoot  = window.location.href.replace(/\/src\/renderer\/[^/]*$/, '');
        const pdfUrl   = `${appRoot}/node_modules/pdfjs-dist/build/pdf.mjs`;
        const workerUrl= `${appRoot}/node_modules/pdfjs-dist/build/pdf.worker.min.mjs`;
        const mod = await import(pdfUrl);
        mod.GlobalWorkerOptions.workerSrc = workerUrl;
        window._pdfjsLib = mod;
      }
      const pdfjsLib = window._pdfjsLib;
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      let text = '';
      for (let p = 1; p <= pdf.numPages; p++) {
        const page    = await pdf.getPage(p);
        const content = await page.getTextContent();
        text += content.items.map(item => item.str).join(' ') + '\n';
      }
      this._addDoc({ name, text: text.trim(), type: 'pdf', pages: pdf.numPages });
    } else {
      // Plain text, code, CSV, markdown, etc. — read directly
      const text = await file.text();
      this._addDoc({ name, text, type: 'text' });
    }
  }

  _addAttachment(imgObj) {
    this._attachedImages.push(imgObj);
    this._renderPreviewStrip();
    this._updateVisionWarning();
    // Auto-switch model selector to vision slot when first image is attached
    window.modelSelector?.setHasImage?.(true);
  }

  _removeAttachment(index) {
    URL.revokeObjectURL(this._attachedImages[index]?.previewUrl);
    this._attachedImages.splice(index, 1);
    this._renderPreviewStrip();
    this._updateVisionWarning();
    // Revert to chat slot when all images are removed
    if (this._attachedImages.length === 0) {
      window.modelSelector?.setHasImage?.(false);
    }
  }

  _addDoc(docObj) {
    this._attachedDocs.push(docObj);
    this._renderPreviewStrip();

    // Background: BM25-index immediately, then try semantic embedding
    if (docObj.text && docObj.text.length > 0 && window.DocIndex) {
      const docId = docObj.name + ':' + docObj.text.length;
      try { window.DocIndex.index(docId, docObj.text); } catch { /* ignore */ }

      // Fire-and-forget async embedding with progress updates on the chip
      docObj._embStatus   = 'pending';
      docObj._embProgress = { done: 0, total: window.DocIndex.chunkCount(docId) };
      this._renderPreviewStrip();

      window.DocIndex.asyncIndex(docId, docObj.text, (done, total, phase) => {
        docObj._embStatus   = phase === 'done' ? 'done' : phase === 'failed' ? 'failed' : 'pending';
        docObj._embProgress = { done, total };
        this._renderPreviewStrip();
      }).catch(() => {
        docObj._embStatus = 'failed';
        this._renderPreviewStrip();
      });
    }
  }

  _removeDoc(index) {
    this._attachedDocs.splice(index, 1);
    this._renderPreviewStrip();
  }

  _clearAttachments() {
    this._attachedImages = [];
    this._attachedDocs   = [];
    if (this.previewStrip) this.previewStrip.innerHTML = '';
    if (this.visionWarning) this.visionWarning.style.display = 'none';
  }

  /** Render the persistent "Docs in context" banner above the input area. */
  _renderSessionDocsBanner() {
    let banner = document.getElementById('sessionDocsBanner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'sessionDocsBanner';
      banner.className = 'session-docs-banner';
      // Insert above the image preview strip inside .input-area
      const inputArea = document.querySelector('.input-area');
      if (inputArea) inputArea.prepend(banner);
    }
    banner.innerHTML = '';
    if (this._sessionDocs.length === 0 && this._removedDocs.length === 0) {
      banner.style.display = 'none';
      return;
    }
    banner.style.display = 'flex';

    if (this._sessionDocs.length > 0) {
      const label = document.createElement('span');
      label.className = 'session-docs-label';
      label.textContent = 'In context:';
      banner.appendChild(label);
    }

    this._sessionDocs.forEach((doc, i) => {
      const chip = document.createElement('div');
      chip.className = 'session-doc-chip';

      const icon = document.createElement('span');
      icon.textContent = doc.type === 'pdf' ? '📄' : '📝';

      const name = document.createElement('span');
      name.className = 'session-doc-chip-name';
      name.textContent = doc.name;

      const rm = document.createElement('button');
      rm.className = 'session-doc-chip-remove';
      rm.textContent = '×';
      rm.title = 'Remove from context';
      rm.addEventListener('click', () => {
        const [removed] = this._sessionDocs.splice(i, 1);
        this._removedDocs.push(removed);
        this._renderSessionDocsBanner();
      });

      chip.append(icon, name, rm);
      banner.appendChild(chip);
    });

    // Show removed docs with re-add button
    if (this._removedDocs.length > 0) {
      const removedLabel = document.createElement('span');
      removedLabel.className = 'session-docs-label removed-label';
      removedLabel.textContent = 'Removed:';
      banner.appendChild(removedLabel);

      this._removedDocs.forEach((doc, i) => {
        const chip = document.createElement('div');
        chip.className = 'session-doc-chip removed';

        const icon = document.createElement('span');
        icon.textContent = doc.type === 'pdf' ? '📄' : '📝';

        const name = document.createElement('span');
        name.className = 'session-doc-chip-name';
        name.textContent = doc.name;

        const addBack = document.createElement('button');
        addBack.className = 'session-doc-chip-readd';
        addBack.textContent = '+';
        addBack.title = 'Add back to context';
        addBack.addEventListener('click', () => {
          const [restored] = this._removedDocs.splice(i, 1);
          this._sessionDocs.push(restored);
          this._renderSessionDocsBanner();
        });

        chip.append(icon, name, addBack);
        banner.appendChild(chip);
      });
    }
  }

  _renderPreviewStrip() {
    if (!this.previewStrip) return;
    this.previewStrip.innerHTML = '';

    // Image thumbnails
    this._attachedImages.forEach((img, i) => {
      const thumb = document.createElement('div');
      thumb.className = 'image-preview-thumb';
      const imgEl = document.createElement('img');
      imgEl.src = img.previewUrl;
      imgEl.alt = img.name;
      thumb.appendChild(imgEl);
      const removeBtn = document.createElement('button');
      removeBtn.className = 'image-preview-remove';
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove';
      removeBtn.addEventListener('click', () => this._removeAttachment(i));
      thumb.appendChild(removeBtn);
      this.previewStrip.appendChild(thumb);
    });

    // Document chips
    this._attachedDocs.forEach((doc, i) => {
      const chip = document.createElement('div');
      chip.className = 'doc-preview-chip';
      const icon = doc.type === 'pdf' ? '📄' : '📝';
      const label = document.createElement('span');
      label.className = 'doc-preview-name';
      label.textContent = `${icon} ${doc.name}`;
      if (doc.pages) label.title = `${doc.pages} page${doc.pages !== 1 ? 's' : ''}`;

      // Embedding status badge
      const emb = document.createElement('span');
      emb.className = 'doc-emb-badge';
      const status = doc._embStatus;
      if (status === 'pending') {
        const { done, total } = doc._embProgress || { done: 0, total: 0 };
        emb.className += ' pending';
        emb.title = total > 0 ? `Embedding ${done}/${total} chunks…` : 'Starting embedding…';
        emb.textContent = total > 0 ? `⠋ ${done}/${total}` : '⠋';
      } else if (status === 'done') {
        emb.className += ' done';
        emb.textContent = '⚡';
        emb.title = 'Semantic search ready';
      } else if (status === 'failed') {
        emb.className += ' failed';
        emb.textContent = 'BM25';
        emb.title = 'nomic-embed-text unavailable — using keyword search';
      }

      const removeBtn = document.createElement('button');
      removeBtn.className = 'image-preview-remove';
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove';
      removeBtn.addEventListener('click', () => this._removeDoc(i));
      chip.appendChild(label);
      if (status) chip.appendChild(emb);
      chip.appendChild(removeBtn);
      this.previewStrip.appendChild(chip);
    });
  }

  /**
   * After marked renders HTML into a container, apply syntax highlighting
   * and inject a Copy button into every <pre><code> block.
   */
  _enhanceCodeBlocks(container) {
    container.querySelectorAll('pre code').forEach(block => {
      const pre = block.parentElement;

      // ── Execution output block ──────────────────────────────────────────
      // Model wraps stdout/stderr in ```output ... ``` — render as styled panel
      const lang = (block.className.match(/language-(\S+)/) || [])[1] || '';
      if (lang === 'output') {
        const raw   = block.innerText || block.textContent || '';
        const panel = this._buildExecOutputPanel(raw);
        pre.replaceWith(panel);
        return; // don't add copy button / hljs to this block
      }

      // ── Normal code block ───────────────────────────────────────────────
      if (typeof hljs !== 'undefined') hljs.highlightElement(block);

      if (pre.querySelector('.copy-code-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'copy-code-btn';
      btn.textContent = 'Copy';
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(block.innerText || block.textContent).then(() => {
          btn.textContent = '✓ Copied';
          setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
        });
      });
      pre.appendChild(btn);
    });
  }

  // ── TTS helpers ────────────────────────────────────────────────────────────

  _speak(rawText) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    // Strip markdown code blocks, headers, and formatting for cleaner audio
    const plain = rawText
      .replace(/```[\s\S]*?```/g, 'code block.')
      .replace(/`[^`]+`/g, '')
      .replace(/#{1,6}\s/g, '')
      .replace(/[*_~]/g, '')
      .trim()
      .slice(0, 5000);
    const utt = new SpeechSynthesisUtterance(plain);
    const voices = window.speechSynthesis.getVoices();
    if (this._ttsConfig?.voice) {
      const v = voices.find(v => v.name === this._ttsConfig.voice);
      if (v) utt.voice = v;
    }
    utt.rate  = this._ttsConfig?.rate  ?? 1.0;
    utt.pitch = this._ttsConfig?.pitch ?? 1.0;
    window.speechSynthesis.speak(utt);
    return utt;
  }

  _stopSpeech() {
    window.speechSynthesis?.cancel();
  }

  /** Render a unified diff string as a styled diff view element. */
  _renderDiff(text) {
    const pre = document.createElement('pre');
    pre.className = 'diff-view';
    for (const raw of text.split('\n')) {
      const span = document.createElement('span');
      if (raw.startsWith('+++') || raw.startsWith('---')) {
        span.className = 'diff-file';
      } else if (raw.startsWith('@@')) {
        span.className = 'diff-hunk';
      } else if (raw.startsWith('+')) {
        span.className = 'diff-add';
      } else if (raw.startsWith('-')) {
        span.className = 'diff-del';
      } else {
        span.className = 'diff-ctx';
      }
      span.textContent = raw + '\n';
      pre.appendChild(span);
    }
    return pre;
  }

  /** Build the styled execution-output panel from raw tool result text. */
  _buildExecOutputPanel(raw) {
    // Parse "exit_code: 0   duration: 45ms" header line
    const exitMatch = raw.match(/exit_code:\s*(\S+)/);
    const durMatch  = raw.match(/duration:\s*(\S+)/);
    const exitCode  = exitMatch ? exitMatch[1] : '?';
    const duration  = durMatch  ? durMatch[1]  : '';

    // Split stdout / stderr sections
    const stdoutMatch = raw.match(/stdout:\n([\s\S]*?)(?=\n\nstderr:|$)/);
    const stderrMatch = raw.match(/stderr:\n([\s\S]*?)(?=$)/);
    const stdout = (stdoutMatch?.[1] || '').trim();
    const stderr = (stderrMatch?.[1] || '').trim();
    const noOutput = !stdout && !stderr;

    const isOk = exitCode === '0' || exitCode === '?';

    const panel = document.createElement('div');
    panel.className = 'exec-output';

    const header = document.createElement('div');
    header.className = 'exec-output-header';
    header.innerHTML =
      `<span>⚡ Output</span>` +
      `<span class="${isOk ? 'exec-exit-ok' : 'exec-exit-err'}">exit ${exitCode}</span>` +
      (duration ? `<span class="exec-duration">${duration}</span>` : '');
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'exec-output-body';
    if (noOutput) {
      body.textContent = '(no output)';
    } else {
      if (stdout) {
        const pre = document.createElement('pre');
        pre.style.margin = '0';
        pre.textContent  = stdout;
        body.appendChild(pre);
      }
      if (stderr) {
        const errPre = document.createElement('pre');
        errPre.className = 'exec-stderr';
        errPre.style.margin = stdout ? '8px 0 0' : '0';
        errPre.textContent  = stderr;
        body.appendChild(errPre);
      }
    }
    panel.appendChild(body);

    return panel;
  }

  /**
   * Render markdown that may contain LaTeX math.
   * We extract $...$ / $$...$$ / \(...\) / \[...\] blocks BEFORE passing
   * to marked (so marked can't mangle underscores, backslashes, etc.),
   * then substitute KaTeX-rendered HTML back into the result.
   */
  _parseMarkdownWithLatex(text) {
    if (!text) return '';
    const blocks = [];

    const protect = (latex, display) => {
      const i = blocks.push({ latex, display }) - 1;
      return display ? `\x02DMATH${i}\x03` : `\x02IMATH${i}\x03`;
    };

    // Order matters: $$ before $, \[ before \(
    let s = text;

    // Convert backtick-wrapped math to $...$ so KaTeX can render it.
    // Matches `...` whose content looks like math: subscripts (_x / _{...}),
    // superscripts (^x / ^{...}), LaTeX commands (\alpha), or Greek/math Unicode.
    const MATH_IN_CODE = /[_^]\{|[_^][A-Za-z0-9]|\\[A-Za-z]+|\p{Script=Greek}|[∑∫∏√∞±×÷≤≥≠≈∈⊂⊃]/u;
    s = s.replace(/`([^`\n]{1,120})`/g, (match, inner) =>
      MATH_IN_CODE.test(inner) ? `$${inner}$` : match
    );

    s = s.replace(/\$\$([\s\S]*?)\$\$/g,  (_, m) => protect(m, true));
    s = s.replace(/\\\[([\s\S]*?)\\\]/g,   (_, m) => protect(m, true));
    s = s.replace(/\$([^\$\n]+?)\$/g,       (_, m) => protect(m, false));
    s = s.replace(/\\\(([^]*?)\\\)/g,       (_, m) => protect(m, false));

    // Collapse 3+ blank lines → 1 blank line (keeps paragraph structure for
    // marked but prevents the model's triple-spacing from creating big gaps).
    s = s.replace(/\n{3,}/g, '\n\n');

    let html = (typeof marked !== 'undefined')
      ? marked.parse(s, { gfm: true, breaks: false })
      : s;

    // Restore KaTeX output
    if (typeof katex !== 'undefined' && blocks.length) {
      html = html.replace(/\x02DMATH(\d+)\x03/g, (_, i) => {
        try { return katex.renderToString(blocks[i].latex, { displayMode: true,  throwOnError: false }); }
        catch { return blocks[i].latex; }
      });
      html = html.replace(/\x02IMATH(\d+)\x03/g, (_, i) => {
        try { return katex.renderToString(blocks[i].latex, { displayMode: false, throwOnError: false }); }
        catch { return blocks[i].latex; }
      });
    }
    return html;
  }

  _setGenerating(on) {
    this.sendBtn.disabled = on;
    if (this.stopBtn) this.stopBtn.style.display = on ? 'flex' : 'none';
  }

  // ── Voice input ───────────────────────────────────────────────────────────

  _toggleVoice() {
    if (this._isListening) {
      this._stopVoice();
    } else {
      // Fire-and-forget but catch everything so no unhandled rejection
      this._startVoice().catch(err => {
        console.error('[Voice] Unhandled start error:', err);
        this._showVoiceError(`Voice error: ${err.message}`);
        this._resetMicState();
      });
    }
  }

  async _startVoice() {
    let whisperCfg = null;
    try {
      whisperCfg = await window.electronAPI?.getWhisperConfig?.();
    } catch { /* ignore — fall back to Web Speech */ }

    const useWhisper = whisperCfg?.exePath && whisperCfg?.modelPath;
    if (useWhisper) {
      await this._startWhisperRecording();
    } else {
      this._startWebSpeech();
    }
  }

  // ── Whisper path: AudioWorklet → raw PCM → WAV (no ffmpeg needed) ──────────

  async _startWhisperRecording() {
    if (!navigator.mediaDevices?.getUserMedia) {
      this._showVoiceError('Microphone API not available in this context.');
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      this._showVoiceError('Microphone permission denied.');
      return;
    }

    // Create AudioContext at 16 kHz — whisper's native sample rate, no resampling needed
    let ctx;
    try {
      ctx = new AudioContext({ sampleRate: 16000 });
    } catch (err) {
      stream.getTracks().forEach(t => t.stop());
      this._showVoiceError(`AudioContext failed: ${err.message}`);
      return;
    }

    // Load the inline worklet processor via a Blob URL (no extra file required)
    try {
      const blob = new Blob([_WHISPER_WORKLET_CODE], { type: 'application/javascript' });
      const url  = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
    } catch (err) {
      stream.getTracks().forEach(t => t.stop());
      try { await ctx.close(); } catch {}
      this._showVoiceError(`Worklet init failed: ${err.message}`);
      return;
    }

    const chunks = [];
    const source  = ctx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(ctx, 'pcm-capture');
    worklet.port.onmessage = (e) => { chunks.push(e.data); };

    // Route source → worklet → silent gain → destination so Chrome keeps processing
    const silencer = ctx.createGain();
    silencer.gain.value = 0;
    source.connect(worklet);
    worklet.connect(silencer);
    silencer.connect(ctx.destination);

    this._whisperCtx    = ctx;
    this._whisperStream = stream;
    this._whisperWorklet = worklet;
    this._whisperChunks = chunks;
    this._isListening   = true;

    this.micBtn?.classList.add('recording');
    this.micBtn?.setAttribute('title', 'Recording… click or ESC to stop');
  }

  async _stopWhisperRecording() {
    const ctx    = this._whisperCtx;
    const stream = this._whisperStream;
    const chunks = this._whisperChunks;

    this._whisperCtx     = null;
    this._whisperStream  = null;
    this._whisperWorklet = null;
    this._whisperChunks  = null;

    this.micBtn?.classList.remove('recording');
    this.micBtn?.classList.add('transcribing');
    this.micBtn?.setAttribute('title', 'Transcribing…');
    const prevPlaceholder = this.userInput.placeholder;
    this.userInput.placeholder = 'Transcribing…';

    try {
      // Tear down the audio pipeline
      stream?.getTracks().forEach(t => t.stop());
      try { await ctx?.close(); } catch {}

      if (!chunks || chunks.length === 0) {
        this._showVoiceError('No audio captured.');
        return;
      }

      // Merge all Float32 PCM chunks into one array
      const totalLen = chunks.reduce((s, c) => s + c.length, 0);
      const merged   = new Float32Array(totalLen);
      let offset = 0;
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }

      // Float32 → Int16
      const int16 = new Int16Array(merged.length);
      for (let i = 0; i < merged.length; i++) {
        const s = Math.max(-1, Math.min(1, merged[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      // Build a valid WAV and send straight to whisper-cli (no ffmpeg required)
      const wav    = this._buildWav(int16, 16000);
      const result = await window.electronAPI?.transcribeAudio?.(new Uint8Array(wav), 'audio/wav');

      if (result?.success && result.transcript) {
        const base = this.userInput.value;
        this.userInput.value = base + (base ? ' ' : '') + result.transcript;
        this.userInput.style.height = 'auto';
        this.userInput.style.height = Math.min(this.userInput.scrollHeight, 150) + 'px';
      } else if (result?.error) {
        this._showVoiceError(`Whisper: ${result.error}`);
      }
    } catch (err) {
      console.error('[Voice] Stop error:', err);
      this._showVoiceError(`Transcription failed: ${err.message}`);
    } finally {
      this.userInput.placeholder = prevPlaceholder;
      this._resetMicState();
      this.userInput.focus();
    }
  }

  /** Build a minimal PCM WAV ArrayBuffer from Int16 samples. */
  _buildWav(int16Samples, sampleRate) {
    const numChannels  = 1;
    const bitsPerSample = 16;
    const byteRate     = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign   = numChannels * (bitsPerSample / 8);
    const dataSize     = int16Samples.length * 2;
    const buffer       = new ArrayBuffer(44 + dataSize);
    const v            = new DataView(buffer);

    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };

    str(0,  'RIFF');
    v.setUint32( 4, 36 + dataSize, true);
    str(8,  'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16,           true);  // PCM subchunk size
    v.setUint16(20, 1,            true);  // AudioFormat = PCM
    v.setUint16(22, numChannels,  true);
    v.setUint32(24, sampleRate,   true);
    v.setUint32(28, byteRate,     true);
    v.setUint16(32, blockAlign,   true);
    v.setUint16(34, bitsPerSample,true);
    str(36, 'data');
    v.setUint32(40, dataSize,     true);

    new Int16Array(buffer, 44).set(int16Samples);
    return buffer;
  }

  // ── Web Speech API fallback (used when Whisper not configured) ────────────

  _startWebSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      this._showVoiceError('Configure Whisper in Settings → Voice for offline transcription.');
      return;
    }
    const rec      = new SR();
    rec.continuous = true; rec.interimResults = true;
    const baseText = this.userInput.value;
    rec.onresult = (e) => {
      let interim = '', final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        e.results[i].isFinal ? (final += t) : (interim += t);
      }
      const confirmed = (this._voiceConfirmed || '') + final;
      this._voiceConfirmed = confirmed;
      this.userInput.value = baseText + (baseText && confirmed ? ' ' : '') +
        confirmed + (interim ? ` ${interim}` : '');
      this.userInput.style.height = 'auto';
      this.userInput.style.height = Math.min(this.userInput.scrollHeight, 150) + 'px';
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed') this._showVoiceError('Microphone permission denied.');
      else if (e.error !== 'no-speech') console.warn('[Voice]', e.error);
      this._stopVoice();
    };
    rec.onend = () => { if (this._isListening) rec.start(); };
    this._voiceConfirmed = '';
    this._recognition    = rec;
    this._isListening    = true;
    rec.start();
    this.micBtn?.classList.add('recording');
    this.micBtn?.setAttribute('title', 'Recording… click or ESC to stop');
  }

  _stopVoice() {
    this._isListening = false;
    if (this._whisperChunks !== null) {
      // Whisper AudioWorklet path — async, errors caught inside
      this._stopWhisperRecording().catch(err => {
        console.error('[Voice] Stop error:', err);
        this._showVoiceError(`Stop failed: ${err.message}`);
        this._resetMicState();
      });
    } else {
      // Web Speech path
      this._recognition?.stop();
      this._recognition    = null;
      this._voiceConfirmed = '';
      this._resetMicState();
      this.userInput.focus();
    }
  }

  _resetMicState() {
    this._isListening = false;
    this.micBtn?.classList.remove('recording', 'transcribing');
    this.micBtn?.setAttribute('title', 'Voice input (click to speak)');
  }

  _showVoiceError(msg) {
    const old = document.querySelector('.voice-error-toast');
    if (old) old.remove();
    const el = document.createElement('div');
    el.className   = 'voice-error-toast';
    el.textContent = `🎤 ${msg}`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('voice-error-toast--visible'));
    setTimeout(() => {
      el.classList.remove('voice-error-toast--visible');
      setTimeout(() => el.remove(), 300);
    }, 4000);
  }

  _updateVisionWarning() {
    if (!this.visionWarning) return;
    const hasImages = this._attachedImages.length > 0;
    const isVision  = window.modelSelector?.isCurrentModelVision?.() ?? true;
    this.visionWarning.style.display = (hasImages && !isVision) ? 'block' : 'none';
  }

  // ── Session management ────────────────────────────────────────────────────

  /**
   * Strip injected file context from a stored user message so session history
   * shows only what the user actually typed.
   *
   * Format we inject:
   *   [Attached file: name]\n<text>\n\n---\n\n[Attached file: name2]\n<text>\n\n<user text>
   *
   * Strategy: if the message starts with "[Attached file:", split on "\n\n" and
   * take the last chunk — that is always the user's original message.
   */
  _stripDocContext(content) {
    if (!content) return content;
    const isDocMsg = content.startsWith('[Attached file:') || content.startsWith('[Relevant excerpts from:');
    if (!isDocMsg) return content;
    const parts = content.split('\n\n');
    const last  = parts[parts.length - 1].trim();
    // Placeholder used when user sent nothing but a file
    return (last === '(Please review the attached files above.)' || last === '(Please review the attached file above.)') ? '' : last;
  }

  /** Load the active session's messages from disk and render them. */
  async _loadActiveSession() {
    try {
      const data = await window.electronAPI?.getActiveSession?.();
      // Bind session id even for empty sessions so follow-up sends target the
      // right session rather than falling back to whatever the main process
      // most recently touched.
      if (data?.session?.id) this._currentSessionId = data.session.id;
      if (!data || !data.messages || data.messages.length === 0) {
        this._showWelcome();
        return;
      }
      this.messagesContainer.innerHTML = '';
      for (const msg of data.messages) {
        const content = msg.role === 'user'
          ? this._stripDocContext(msg.display || msg.content)
          : msg.content;
        // Pass parts for assistant messages that have them (new parts system)
        const msgOpts = { type: msg.type || 'chat' };
        if (msg.parts) msgOpts.parts = msg.parts;
        this.addMessage(msg.role, content, msgOpts, msg.images || []);
      }
      this.scrollToBottom();
    } catch (err) {
      console.error('Failed to load session:', err);
      this._showWelcome();
    }
  }

  /** Called when the incognito toggle flips — drop transient state. */
  _incognitoHistoryCleared() {
    this._clearAttachments();
    this._sessionDocs = [];
    this._removedDocs = [];
    this._artifacts?.clear();
    window.DocIndex?.clear();
    this._renderSessionDocsBanner();
    this._toolStreamBuffer = [];
    this._activeThinkingId = null;
    this._liveMsgEl = null;
  }

  /** Start a brand-new session — keeps history accessible, clears the view. */
  async newChat() {
    this._clearAttachments();
    this._sessionDocs = [];
    this._removedDocs = [];
    this._artifacts?.clear();
    window.DocIndex?.clear();
    this._renderSessionDocsBanner();
    try {
      const data = await window.electronAPI?.newChat?.();
      if (data?.session?.id) this._currentSessionId = data.session.id;
    } catch (err) {
      console.error('Failed to create new session:', err);
    }
    this._showWelcome();
  }

  /** Switch to an existing session (called from a future history panel). */
  async loadSession(sessionId) {
    this._sessionDocs = [];
    this._removedDocs = [];
    this._currentSessionId = sessionId;
    this._artifacts?.clear();
    window.DocIndex?.clear();
    this._renderSessionDocsBanner();
    try {
      const data = await window.electronAPI?.loadSession?.(sessionId);
      if (!data) return;
      this.messagesContainer.innerHTML = '';
      for (const msg of data.messages) {
        const content = msg.role === 'user'
          ? this._stripDocContext(msg.display || msg.content)
          : msg.content;
        const msgOpts = { type: msg.type || 'chat' };
        if (msg.parts) msgOpts.parts = msg.parts;
        this.addMessage(msg.role, content, msgOpts, msg.images || []);
      }
      this.scrollToBottom();
    } catch (err) {
      console.error('Failed to load session:', err);
    }

    // Restore persisted documents and re-index them
    try {
      const docs = await window.electronAPI?.getDocuments?.({ sessionId }) || [];
      for (const doc of docs) {
        const docObj = { name: doc.name, type: doc.type, text: doc.text, pages: doc.pages };
        this._sessionDocs.push(docObj);
        if (doc.text && window.DocIndex) {
          const docId = doc.name + ':' + doc.text.length;
          try { window.DocIndex.index(docId, doc.text); } catch { /* ignore */ }
          // Background semantic re-embedding (fire-and-forget)
          window.DocIndex.asyncIndex(docId, doc.text, () => {}).catch(() => {});
        }
      }
      if (docs.length > 0) this._renderSessionDocsBanner();
    } catch (err) {
      console.error('Failed to restore session documents:', err);
    }
  }

  _showWelcome() {
    this.messagesContainer.innerHTML = `
      <div class="welcome-message">
        <h2>Hi! I'm Friday</h2>
        <p>Your personal AI assistant. Ask me anything!</p>
      </div>
    `;
  }

  // ── Messaging ─────────────────────────────────────────────────────────────

  /** Programmatically submit text (e.g. from wake word activation). */
  submitText(text) {
    if (!text) return;
    this.userInput.value = text;
    this.sendMessage();
  }

  async sendMessage() {
    const rawMessage = this.userInput.value.trim();
    if (!rawMessage && this._attachedImages.length === 0 && this._attachedDocs.length === 0) return;
    this._stopSpeech(); // stop any ongoing TTS when user sends a new message

    const { model, modelType } = window.modelSelector.getSelectedModel();

    // Block sending images to a non-vision model — Ollama silently drops the
    // images array, which produces "irrelevant" answers that ignore the image.
    if (this._attachedImages.length > 0 && !window.modelSelector?.isCurrentModelVision?.()) {
      this._showVoiceError('Attached images need a vision model (👁). Configure one in Settings → Model Slots → Vision, then re-attach.');
      return;
    }

    this.userInput.value = '';
    this.userInput.style.height = 'auto';

    // Capture and clear pending attachments before async work
    const images    = [...this._attachedImages];
    const newDocs   = [...this._attachedDocs];
    this._clearAttachments();

    // Build full message for the model using RAG for large docs:
    // session docs (persistent) + newly attached docs + user text
    const allDocs = [...this._sessionDocs, ...newDocs];
    let messageForModel = rawMessage;
    if (allDocs.length > 0) {
      const docContext = (await Promise.all(allDocs.map(async d => {
        const docId  = d.name + ':' + d.text.length;
        const docIdx = window.DocIndex;
        // Ensure BM25-indexed (session docs may not have been indexed yet)
        if (docIdx && !docIdx.has(docId)) docIdx.index(docId, d.text);
        const chunks = docIdx?.chunkCount(docId) ?? 0;
        const useRag = docIdx && chunks >= 3 && rawMessage;
        if (useRag) {
          const retrieved = await docIdx.query(docId, rawMessage, 6);
          const mode = docIdx.embStatus(docId) === 'done' ? 'semantic+BM25' : 'BM25';
          return `[Relevant excerpts from: ${d.name} — ${retrieved.length}/${chunks} chunks, ${mode}]\n${retrieved.join('\n\n---\n\n')}`;
        }
        return `[Attached file: ${d.name}]\n${d.text}`;
      }))).join('\n\n');
      messageForModel = docContext + '\n\n' + (rawMessage || '(Please review the attached files above.)');
    }

    // Promote newly sent docs into the session context and persist to SQLite
    if (newDocs.length > 0) {
      this._sessionDocs.push(...newDocs);
      this._renderSessionDocsBanner();
      if (this._currentSessionId && window.electronAPI?.saveDocument) {
        for (const doc of newDocs) {
          window.electronAPI.saveDocument({
            sessionId: this._currentSessionId,
            doc: { name: doc.name, type: doc.type, text: doc.text, pages: doc.pages }
          }).catch(() => {});
        }
      }
    }

    const welcomeMsg = this.messagesContainer.querySelector('.welcome-message');
    if (welcomeMsg) welcomeMsg.remove();

    // Show user bubble with raw message + doc chips (not the injected content)
    this.addMessage('user', rawMessage, 'chat', images, newDocs.map(d => ({ name: d.name, type: d.type })));
    this._toolStreamBuffer = [];
    const thinkingId = this.addThinkingIndicator();
    this._setGenerating(true);

    // ── Single path: ALL messages go through AgentRuntime ─────────────────────
    // Events (part.new, part.delta, part.update, session.status, permission.request)
    // are handled by the onAgentEvent listener in renderer.js.

    try {
      if (!window.electronAPI?.sendAgentMessage) {
        throw new Error('App not fully loaded. Please try again.');
      }

      const incognito = !!window.isIncognito?.();
      const result = await window.electronAPI.sendAgentMessage({
        message:        messageForModel,
        displayMessage: rawMessage,
        model,
        sessionId:      incognito ? null : this._currentSessionId,
        images: images.map(({ data, mimeType }) => ({ data, mimeType })),
        forceSearch: incognito ? false : this.forceSearch,
        incognito,
      });

      this.forceSearch = false;
      this.searchToggleBtn?.classList.remove('active');

      if (result?.sessionId) this._currentSessionId = result.sessionId;

      // If the AgentRuntime returned an error and no events fired,
      // the thinking indicator is still visible — clean it up.
      if (!result?.success) {
        if (this._activeThinkingId) {
          this.removeThinkingIndicator(this._activeThinkingId);
        }
        // Only show error if the live parts didn't already render one
        if (!this._liveMsgEl) {
          const errMsg = result?.error === 'Cancelled'
            ? 'Response cancelled.'
            : `Error: ${result?.error || 'Unknown error'}`;
          this.addMessage('assistant', errMsg, result?.error === 'Cancelled' ? 'chat' : 'error');
        }
      }
    } catch (error) {
      if (this._activeThinkingId) {
        this.removeThinkingIndicator(this._activeThinkingId);
      }
      if (!this._liveMsgEl) {
        const msg = error.message === 'Cancelled'
          ? 'Response cancelled.'
          : `Error: ${error.message}`;
        this.addMessage('assistant', msg, error.message === 'Cancelled' ? 'chat' : 'error');
      }
    } finally {
      this._setGenerating(false);
      this.userInput.focus();
      if (rawMessage && typeof window._onSuggestionQuery === 'function') {
        window._onSuggestionQuery(rawMessage);
      }
    }
  }

  /** Create an empty assistant bubble that streaming chunks will fill */
  createStreamingMessage() {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message assistant';

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar friday-avatar';
    avatar.textContent = 'F';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    const textDiv = document.createElement('div');
    textDiv.className = 'message-content-text';
    contentDiv.appendChild(textDiv);

    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    this.messagesContainer.appendChild(messageDiv);
    this.scrollToBottom();

    return messageDiv;
  }

  /** Re-render a completed streaming message with full markdown */
  finalizeStreamingMessage(messageEl, finalText, type) {
    if (type === 'search') messageEl.classList.add('search');

    const contentDiv = messageEl.querySelector('.message-content');
    if (!contentDiv) return;

    // Inject buffered tool output as collapsible block(s) before the response text
    if (this._toolStreamBuffer.length > 0) {
      // Separate diff chunks from regular stdout/stderr chunks
      const diffChunks  = this._toolStreamBuffer.filter(c => c.type === 'diff');
      const otherChunks = this._toolStreamBuffer.filter(c => c.type !== 'diff');

      // Render diff blocks (write_file / patch_file)
      for (const dc of diffChunks) {
        const details = document.createElement('details');
        details.className = 'tool-output-details diff-details';
        const summary = document.createElement('summary');
        // Extract stats from the @@ line if present
        const statsMatch = dc.text.match(/@@ .* @@ \(([^)]+)\)/);
        summary.textContent = statsMatch ? `File diff  (${statsMatch[1]})` : 'File diff';
        details.appendChild(summary);
        details.appendChild(this._renderDiff(dc.text));
        contentDiv.insertBefore(details, contentDiv.firstChild);
      }

      // Render stdout/stderr (execute_code etc.)
      const allOther = otherChunks.map(c => c.text).join('');
      if (allOther.trim()) {
        const details = document.createElement('details');
        details.className = 'tool-output-details';
        const summary = document.createElement('summary');
        const lineCount = allOther.split('\n').filter(l => l.trim()).length;
        summary.textContent = `Tool output (${lineCount} line${lineCount !== 1 ? 's' : ''})`;
        details.appendChild(summary);
        const pre = document.createElement('pre');
        pre.className = 'tool-stream-box';
        for (const c of otherChunks) {
          const span = document.createElement('span');
          span.className = c.type === 'stderr' ? 'tool-stream-stderr' : 'tool-stream-stdout';
          span.textContent = c.text;
          pre.appendChild(span);
        }
        details.appendChild(pre);
        contentDiv.insertBefore(details, contentDiv.firstChild);
      }

      this._toolStreamBuffer = [];
    }

    if (type === 'search' && !contentDiv.querySelector('.search-badge')) {
      const badge = document.createElement('div');
      badge.className = 'search-badge';
      badge.textContent = '🔍 WEB SEARCH';
      contentDiv.insertBefore(badge, contentDiv.firstChild);
    }

    const textDiv = contentDiv.querySelector('.message-content-text');
    if (textDiv) {
      textDiv.innerHTML = this._parseMarkdownWithLatex(finalText || '');
      this._enhanceCodeBlocks(textDiv);
      if (type === 'search') {
        contentDiv.querySelector('.search-sources')?.remove();
        this._addSourceCards(textDiv, contentDiv);
      }
    }

    // Add copy + regenerate + speak actions
    this._addMessageActions(contentDiv, finalText, messageEl);

    // Auto-read if TTS is enabled
    if (this._ttsConfig?.autoRead && finalText) {
      this._speak(finalText);
    }

    // Extract large code blocks into artifacts panel
    this._extractArtifacts(textDiv, finalText);

    this.scrollToBottom();
  }

  /**
   * Extract all external links from a rendered search response and append
   * them as a clean "Sources" card strip below the answer.
   */
  _addSourceCards(textDiv, contentDiv) {
    const links  = [...textDiv.querySelectorAll('a[href^="http"]')];
    const seen   = new Set();
    const unique = links.filter(a => {
      if (seen.has(a.href)) return false;
      seen.add(a.href);
      return true;
    });
    if (!unique.length) return;

    const wrap = document.createElement('div');
    wrap.className = 'search-sources';

    const hdr = document.createElement('div');
    hdr.className = 'search-sources-header';
    hdr.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg> ${unique.length} source${unique.length !== 1 ? 's' : ''}`;
    wrap.appendChild(hdr);

    const grid = document.createElement('div');
    grid.className = 'search-sources-grid';

    unique.forEach(a => {
      try {
        const url    = new URL(a.href);
        const card   = document.createElement('div');
        card.className = 'search-source-card';
        card.title   = a.href;

        const fav    = document.createElement('img');
        fav.className = 'search-source-favicon';
        fav.src      = `https://www.google.com/s2/favicons?domain=${url.hostname}&sz=16`;
        fav.onerror  = () => fav.style.display = 'none';

        const info   = document.createElement('div');
        info.className = 'search-source-info';

        const title  = document.createElement('div');
        title.className = 'search-source-title';
        title.textContent = (a.textContent || url.hostname).trim().slice(0, 60);

        const domain = document.createElement('div');
        domain.className = 'search-source-domain';
        domain.textContent = url.hostname.replace(/^www\./, '');

        info.append(title, domain);
        card.append(fav, info);
        card.addEventListener('click', () => window.electronAPI?.openExternal?.(a.href));
        grid.appendChild(card);
      } catch { /* ignore malformed URLs */ }
    });

    wrap.appendChild(grid);
    contentDiv.appendChild(wrap);
  }

  addMessage(role, content, typeOrOpts = 'chat', images = [], files = []) {
    // typeOrOpts can be a plain string (legacy) or an options object
    let type = 'chat';
    let opts = {};
    if (typeOrOpts && typeof typeOrOpts === 'object') {
      opts = typeOrOpts;
      type = opts.type || 'chat';
    } else {
      type = typeOrOpts || 'chat';
    }

    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}`;
    if (type === 'search') messageDiv.classList.add('search');

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = role === 'user' ? '◎' : 'F';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    if (type === 'search') {
      const badge = document.createElement('div');
      badge.className = 'search-badge';
      badge.textContent = '🔍 WEB SEARCH';
      contentDiv.appendChild(badge);
    }

    // Scheduled task badge
    if (opts.scheduled) {
      const badge = document.createElement('div');
      const repeated = opts.error && opts.consecutiveFailures >= 3;
      badge.className = `scheduled-task-badge${opts.error ? ' error' : ''}${repeated ? ' critical' : ''}`;
      const icon = opts.error ? (repeated ? '🚨' : '⚠️') : '⏰';
      const failNote = repeated ? ` (${opts.consecutiveFailures}x)` : '';
      badge.innerHTML =
        `<span class="stb-icon">${icon}</span>` +
        `<span class="stb-name">${opts.taskName || 'Scheduled Task'}${failNote}</span>` +
        `<span class="stb-time">${opts.timeStr || ''}</span>`;
      contentDiv.appendChild(badge);
    }

    // Render image thumbnails for user messages
    if (images && images.length > 0) {
      const imagesDiv = document.createElement('div');
      imagesDiv.className = 'message-images';
      images.forEach(img => {
        const imgEl = document.createElement('img');
        imgEl.src = img.previewUrl || `data:${img.mimeType};base64,${img.data}`;
        imgEl.alt = img.name || 'attached image';
        imgEl.addEventListener('click', () => {
          const w = window.open('', '_blank', 'width=900,height=700');
          w.document.write(`<img src="${imgEl.src}" style="max-width:100%;height:auto">`);
        });
        imagesDiv.appendChild(imgEl);
      });
      contentDiv.appendChild(imagesDiv);
    }

    // Render file chips for attached documents
    if (files && files.length > 0) {
      const filesDiv = document.createElement('div');
      filesDiv.className = 'message-files';
      files.forEach(f => {
        const chip = document.createElement('span');
        chip.className = 'message-file-chip';
        chip.textContent = `${f.type === 'pdf' ? '📄' : '📝'} ${f.name}`;
        filesDiv.appendChild(chip);
      });
      contentDiv.appendChild(filesDiv);
    }

    // ── Parts-based rendering (new system) ─────────────────────────────────
    const parts = opts.parts;
    if (role === 'assistant' && Array.isArray(parts) && parts.length > 0) {
      for (const part of parts) {
        const el = this._createPartEl(part);
        if (el) contentDiv.appendChild(el);
      }
    } else {
      // Legacy: render content as markdown
      const textDiv = document.createElement('div');
      textDiv.className = 'message-content-text';
      if (content) {
        textDiv.innerHTML = this._parseMarkdownWithLatex(content);
        this._enhanceCodeBlocks(textDiv);
        if (type === 'search') this._addSourceCards(textDiv, contentDiv);
      }
      contentDiv.appendChild(textDiv);
    }

    // Edit button (user messages only)
    if (role === 'user') {
      const editBtn = document.createElement('button');
      editBtn.className = 'msg-edit-btn';
      editBtn.title = 'Edit & re-run';
      editBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
      editBtn.addEventListener('click', () => this._editMessage(messageDiv, textDiv, content));
      contentDiv.appendChild(editBtn);
    }

    // Copy + Regenerate actions (assistant messages only)
    if (role === 'assistant' && content) {
      this._addMessageActions(contentDiv, content, messageDiv);
    }

    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    this.messagesContainer.appendChild(messageDiv);
    this.scrollToBottom();

    return messageDiv;
  }

  /** Inline edit a user message and re-run the conversation from that point. */
  _editMessage(messageDiv, textDiv, originalContent) {
    if (messageDiv.classList.contains('editing')) return;
    messageDiv.classList.add('editing');

    const contentDiv = messageDiv.querySelector('.message-content');

    // Build editor
    const editor = document.createElement('textarea');
    editor.className = 'msg-edit-textarea';
    editor.value = originalContent || textDiv.textContent || '';

    const actions = document.createElement('div');
    actions.className = 'msg-edit-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'msg-edit-cancel';
    cancelBtn.textContent = 'Cancel';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'msg-edit-save';
    saveBtn.textContent = 'Re-run ↵';

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    textDiv.style.display = 'none';
    contentDiv.querySelector('.msg-edit-btn')?.style.setProperty('display', 'none');
    contentDiv.appendChild(editor);
    contentDiv.appendChild(actions);

    // Auto-resize textarea
    const resize = () => { editor.style.height = 'auto'; editor.style.height = editor.scrollHeight + 'px'; };
    editor.addEventListener('input', resize);
    resize();
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);

    const cancel = () => {
      messageDiv.classList.remove('editing');
      textDiv.style.display = '';
      contentDiv.querySelector('.msg-edit-btn')?.style.removeProperty('display');
      editor.remove();
      actions.remove();
    };

    const rerun = async () => {
      const newText = editor.value.trim();
      if (!newText) return;

      // Find this message's DOM index among all .message elements
      const allMsgs = [...this.messagesContainer.querySelectorAll('.message')];
      const domIdx  = allMsgs.indexOf(messageDiv);

      // Truncate the session in the store from this index onwards
      if (domIdx !== -1 && this._currentSessionId) {
        await window.electronAPI?.truncateSession?.(this._currentSessionId, domIdx);
      }

      // Remove this and all subsequent DOM message elements
      if (domIdx !== -1) {
        for (let i = domIdx; i < allMsgs.length; i++) allMsgs[i].remove();
      }

      // Populate input and auto-send
      this.userInput.value = newText;
      this.userInput.dispatchEvent(new Event('input'));
      this.sendMessage();
    };

    cancelBtn.addEventListener('click', cancel);
    saveBtn.addEventListener('click', rerun);
    editor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); rerun(); }
      if (e.key === 'Escape') cancel();
    });
  }

  // ── Streaming indicators ──────────────────────────────────────────────────

  static get _TOOL_LABELS() {
    return {
      brave_web_search:    '🔍 Searching the web',
      fetch_page:          '🌐 Reading page',
      open_url:            '🌐 Opening browser',
      open_bookmark:       '🔖 Opening bookmark',
      search_site:         '🔎 Opening site search',
      launch_app:          '🚀 Launching app',
      add_calendar_event:  '📅 Adding to calendar',
      get_calendar_summary:'📅 Checking calendar',
      edit_calendar_event: '📅 Updating calendar',
      delete_calendar_event:'📅 Removing from calendar',
    };
  }

  _updateThinkingStatus(thinkingId, toolName) {
    const el = document.getElementById(thinkingId);
    if (!el) return;
    const span = el.querySelector('.thinking');
    if (span) span.textContent = ChatInterface._TOOL_LABELS[toolName] || `⚙ Using ${toolName}`;
  }

  // ── Usage / token display ─────────────────────────────────────────────────

  static _GEMINI_COST(model, inputTok, outputTok) {
    // Prices per 1M tokens (USD). Rough estimates — update as needed.
    const table = {
      'gemini-2.5-pro':        [1.25, 10.0],
      'gemini-2.0-flash':      [0.10,  0.40],
      'gemini-2.0-flash-lite': [0.075, 0.30],
      'gemini-1.5-pro':        [1.25,  5.00],
      'gemini-1.5-flash':      [0.075, 0.30],
    };
    const key = Object.keys(table).find(k => model.startsWith(k)) || 'gemini-2.0-flash';
    const [inp, out] = table[key];
    return (inputTok / 1e6) * inp + (outputTok / 1e6) * out;
  }

  _appendUsage(messageEl, usage, modelType) {
    const { inputTokens = 0, outputTokens = 0 } = usage;
    if (!inputTokens && !outputTokens) return;

    const footer = document.createElement('div');
    footer.className = 'message-usage';

    const totalTokens = inputTokens + outputTokens;
    let text = `${totalTokens.toLocaleString()} tokens (${inputTokens.toLocaleString()} in · ${outputTokens.toLocaleString()} out)`;

    if (modelType === 'gemini') {
      const model = window.modelSelector?.modelSelect?.value || '';
      const cost  = ChatInterface._GEMINI_COST(model, inputTokens, outputTokens);
      if (cost > 0) {
        const costStr = cost < 0.001
          ? `$${(cost * 1000).toFixed(3)}m`   // show in millicents
          : `$${cost.toFixed(4)}`;
        text += ` · ~${costStr}`;
      }
    } else {
      text += ' · local';
    }

    footer.textContent = text;
    messageEl.querySelector('.message-content')?.appendChild(footer);
  }

  addThinkingIndicator() {
    const thinkingId = 'thinking-' + Date.now();
    this._activeThinkingId = thinkingId;
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message assistant';
    messageDiv.id = thinkingId;

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = 'F';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    const topRow = document.createElement('div');
    topRow.style.cssText = 'display:flex;align-items:center;gap:12px;';

    const thinkingSpan = document.createElement('span');
    thinkingSpan.className = 'thinking';
    thinkingSpan.textContent = 'Thinking';
    topRow.appendChild(thinkingSpan);

    contentDiv.appendChild(topRow);
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    this.messagesContainer.appendChild(messageDiv);
    this.scrollToBottom();

    return thinkingId;
  }

  /** Append a streamed output chunk to the active thinking indicator and buffer it. */
  appendToolStreamChunk(thinkingId, chunk) {
    // Buffer so we can replay into the final response bubble
    this._toolStreamBuffer.push({ text: chunk.text, type: chunk.type });

    const el = document.getElementById(thinkingId);
    if (!el) return;
    const contentDiv = el.querySelector('.message-content');
    if (!contentDiv) return;

    let streamBox = contentDiv.querySelector('.tool-stream-box');
    if (!streamBox) {
      streamBox = document.createElement('pre');
      streamBox.className = 'tool-stream-box';
      contentDiv.appendChild(streamBox);
    }

    const span = document.createElement('span');
    span.className = chunk.type === 'stderr' ? 'tool-stream-stderr' : 'tool-stream-stdout';
    span.textContent = chunk.text;
    streamBox.appendChild(span);

    // Keep box bounded — retain last ~80 spans
    while (streamBox.children.length > 80) streamBox.removeChild(streamBox.firstChild);
    // Auto-scroll stream box itself
    streamBox.scrollTop = streamBox.scrollHeight;
    this.scrollToBottom();
  }

  removeThinkingIndicator(id) {
    const element = document.getElementById(id);
    if (element) element.remove();
    if (this._activeThinkingId === id) this._activeThinkingId = null;
  }

  /**
   * In Cowork mode: replace code blocks with ≥15 lines with artifact chips.
   * The full code is pushed to the ArtifactsPanel.
   */
  _extractArtifacts(textDiv, rawMarkdown) {
    if (!this._artifacts || !textDiv) return;

    const codeBlocks = textDiv.querySelectorAll('pre code');
    let artIdx = 0;

    codeBlocks.forEach(block => {
      const pre  = block.parentElement;
      const code = block.innerText || block.textContent || '';
      const lines = code.split('\n').length;
      if (lines < 15) return; // leave small snippets inline

      const lang = (block.className.match(/language-(\S+)/) || [])[1] || 'text';
      if (lang === 'output') return; // leave exec output panels alone

      // Generate a name from the raw markdown fence label or fallback
      const fenceMatch = rawMarkdown.match(new RegExp(`\`\`\`${lang}[\\s\\S]*?\`\`\``));
      const name = `artifact-${++artIdx}.${lang === 'javascript' ? 'js' : lang === 'python' ? 'py' : lang}`;

      const artId = this._artifacts.push(name, lang, code.trimEnd());

      // Replace the pre block with a clickable chip
      const chip = document.createElement('div');
      chip.className = 'artifact-chip';
      chip.innerHTML = `
        <span class="artifact-chip-icon">${lang === 'html' ? '🌐' : lang === 'python' || lang === 'py' ? '🐍' : '📄'}</span>
        <span class="artifact-chip-name">${name}</span>
        <span class="artifact-chip-lang">${lang}</span>
        <span class="artifact-chip-lines">${lines} lines</span>
      `;
      chip.addEventListener('click', () => this._artifacts._activate(artId));
      pre.replaceWith(chip);
    });
  }

  /** Append copy + regenerate action buttons to a completed assistant message. */
  _addMessageActions(contentDiv, rawText, messageDiv) {
    if (contentDiv.querySelector('.msg-actions')) return; // already added
    const bar = document.createElement('div');
    bar.className = 'msg-actions';

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-btn';
    copyBtn.title = 'Copy response';
    copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy`;
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(rawText || '').then(() => {
        copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copied`;
        setTimeout(() => {
          copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy`;
        }, 2000);
      });
    });

    // Regenerate button
    const regenBtn = document.createElement('button');
    regenBtn.className = 'msg-action-btn';
    regenBtn.title = 'Regenerate response';
    regenBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.9L1 10"/></svg> Regenerate`;
    regenBtn.addEventListener('click', () => this._regenerateFrom(messageDiv));

    // Thumbs up / down feedback
    let _currentRating = 0;
    let _feedbackId    = null;

    const thumbUp = document.createElement('button');
    thumbUp.className = 'msg-action-btn msg-thumb';
    thumbUp.title = 'Good response — save as example';
    thumbUp.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>`;

    const thumbDown = document.createElement('button');
    thumbDown.className = 'msg-action-btn msg-thumb';
    thumbDown.title = 'Bad response';
    thumbDown.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>`;

    const _updateThumbState = () => {
      thumbUp.classList.toggle('active',   _currentRating ===  1);
      thumbDown.classList.toggle('active', _currentRating === -1);
    };

    const _getUserMessage = () => {
      const allMsgs = [...this.messagesContainer.querySelectorAll('.message')];
      const idx = allMsgs.indexOf(messageDiv);
      for (let i = idx - 1; i >= 0; i--) {
        if (allMsgs[i].classList.contains('user')) {
          return allMsgs[i].querySelector('.message-content-text')?.textContent?.trim() || '';
        }
      }
      return '';
    };

    thumbUp.addEventListener('click', async () => {
      if (_currentRating === 1) {
        // Toggle off
        if (_feedbackId) await window.electronAPI?.deleteFeedback?.(_feedbackId);
        _currentRating = 0; _feedbackId = null;
      } else {
        if (_feedbackId) await window.electronAPI?.deleteFeedback?.(_feedbackId);
        const res = await window.electronAPI?.saveFeedback?.({
          userMessage: _getUserMessage(),
          assistantResponse: rawText || '',
          rating: 1,
        });
        _currentRating = 1;
        _feedbackId = res?.id || null;
      }
      _updateThumbState();
    });

    thumbDown.addEventListener('click', async () => {
      if (_currentRating === -1) {
        if (_feedbackId) await window.electronAPI?.deleteFeedback?.(_feedbackId);
        _currentRating = 0; _feedbackId = null;
      } else {
        if (_feedbackId) await window.electronAPI?.deleteFeedback?.(_feedbackId);
        const res = await window.electronAPI?.saveFeedback?.({
          userMessage: _getUserMessage(),
          assistantResponse: rawText || '',
          rating: -1,
        });
        _currentRating = -1;
        _feedbackId = res?.id || null;
      }
      _updateThumbState();
    });

    // Speak button
    const speakBtn = document.createElement('button');
    speakBtn.className = 'msg-action-btn msg-speak';
    speakBtn.title = 'Read aloud';
    const _speakerIcon  = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
    const _stopIcon     = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>`;
    speakBtn.innerHTML  = _speakerIcon;
    let _speaking = false;
    speakBtn.addEventListener('click', () => {
      if (_speaking) {
        this._stopSpeech();
        _speaking = false;
        speakBtn.innerHTML = _speakerIcon;
        speakBtn.classList.remove('active');
      } else {
        const utt = this._speak(rawText || '');
        if (utt) {
          _speaking = true;
          speakBtn.innerHTML = _stopIcon;
          speakBtn.classList.add('active');
          utt.onend = () => {
            _speaking = false;
            speakBtn.innerHTML = _speakerIcon;
            speakBtn.classList.remove('active');
          };
        }
      }
    });

    bar.appendChild(copyBtn);
    bar.appendChild(regenBtn);
    bar.appendChild(speakBtn);
    bar.appendChild(thumbUp);
    bar.appendChild(thumbDown);
    contentDiv.appendChild(bar);
  }

  /** Find the user message before this assistant message and re-send it. */
  async _regenerateFrom(assistantMsgDiv) {
    const allMsgs = [...this.messagesContainer.querySelectorAll('.message')];
    const idx = allMsgs.indexOf(assistantMsgDiv);
    if (idx < 1) return;

    // Find the nearest user message before this one
    let userMsgDiv = null;
    let userIdx = idx - 1;
    while (userIdx >= 0) {
      if (allMsgs[userIdx].classList.contains('user')) { userMsgDiv = allMsgs[userIdx]; break; }
      userIdx--;
    }
    if (!userMsgDiv) return;

    const userText = userMsgDiv.querySelector('.message-content-text')?.textContent?.trim();
    if (!userText) return;

    // Truncate session from the user message index
    if (this._currentSessionId) {
      await window.electronAPI?.truncateSession?.(this._currentSessionId, userIdx);
    }
    // Remove user message and everything after from DOM
    for (let i = userIdx; i < allMsgs.length; i++) allMsgs[i].remove();

    // Re-populate input and send
    this.userInput.value = userText;
    this.userInput.dispatchEvent(new Event('input'));
    this.sendMessage();
  }

  // Legacy alias — kept so any old call to clearChat() still works
  clearChat() { this.newChat(); }

  scrollToBottom() {
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  // ── AgentRuntime parts-based rendering ───────────────────────────────────

  /**
   * Called when agent session.status → 'running'.
   * Removes the thinking indicator and creates the live parts container.
   */
  startAgentResponse() {
    if (this._activeThinkingId) {
      this.removeThinkingIndicator(this._activeThinkingId);
    }
    const msgEl = document.createElement('div');
    msgEl.className = 'message assistant agent-msg';

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar friday-avatar';
    avatar.textContent = 'F';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content agent-parts';

    msgEl.appendChild(avatar);
    msgEl.appendChild(contentDiv);
    this.messagesContainer.appendChild(msgEl);

    this._liveMsgEl   = msgEl;
    this._liveContent = contentDiv;
    this._partEls     = new Map();

    this.scrollToBottom();
    return msgEl;
  }

  /** Handle part.new event from AgentRuntime. */
  handlePartNew(part) {
    if (!this._liveContent) this.startAgentResponse();
    const el = this._createPartEl(part);
    if (el) {
      this._partEls.set(part.id, el);
      this._liveContent.appendChild(el);
      this.scrollToBottom();
    }
  }

  /** Handle part.delta event — streaming text chunk or tool stream chunk. */
  handlePartDelta(partId, delta) {
    const el = this._partEls?.get(partId);
    if (!el) return;
    // Text part streaming
    const streamSpan = el.querySelector('.agent-text-streaming');
    if (streamSpan) {
      streamSpan.textContent = (streamSpan.textContent || '') + delta;
      this.scrollToBottom();
      return;
    }
  }

  /** Handle tool.stream chunk (live stdout/stderr from execute_code etc.) */
  handleToolStream(partId, chunk) {
    const el = this._partEls?.get(partId);
    if (!el) return;
    const streamPre = el.querySelector('.tool-stream-pre');
    if (!streamPre) return;
    streamPre.style.display = 'block';
    // Make sure the card is expanded so the user sees live output
    if (!el.classList.contains('expanded')) el.classList.add('expanded');
    streamPre.textContent = (streamPre.textContent || '') + chunk;
    // Keep bounded
    if (streamPre.textContent.length > 8000) {
      streamPre.textContent = '…' + streamPre.textContent.slice(-7000);
    }
    streamPre.scrollTop = streamPre.scrollHeight;
    this.scrollToBottom();
  }

  /**
   * Handle part.update event — receives the FULL updated part object.
   * (AgentRuntime emits { type:'part.update', part: fullPartObject })
   */
  handlePartUpdate(partId, updatedPart) {
    const el = this._partEls?.get(partId);
    if (!el) return;

    // ── Tool part state update ──────────────────────────────────────────────
    if (updatedPart.type === 'tool' && updatedPart.state) {
      const stateType = updatedPart.state.type || 'pending';
      el.classList.remove('pending', 'running', 'completed', 'error');
      el.classList.add(stateType);

      const iconSlot = el.querySelector('.tool-card-spinner, .tool-card-icon-done, .tool-card-icon-err');
      if (iconSlot) {
        const newIcon = document.createElement(stateType === 'running' ? 'div' : 'span');
        if (stateType === 'running')   { newIcon.className = 'tool-card-spinner'; }
        if (stateType === 'completed') { newIcon.className = 'tool-card-icon-done'; newIcon.textContent = '✓'; }
        if (stateType === 'error')     { newIcon.className = 'tool-card-icon-err';  newIcon.textContent = '✕'; }
        iconSlot.replaceWith(newIcon);
      }

      // Auto-collapse stream box when done
      if (stateType === 'completed' || stateType === 'error') {
        el.querySelector('.tool-stream-pre')?.style && (el.querySelector('.tool-stream-pre').style.display = 'none');
      }

      // Populate output
      const output = updatedPart.state.output;
      const errMsg = updatedPart.state.message;
      const rawOutput = output !== undefined ? output : (errMsg || null);
      if (rawOutput !== null) {
        let outPre = el.querySelector('.tool-card-pre[data-role="output"]');
        if (!outPre) {
          const body = el.querySelector('.tool-card-body');
          const outLabel = document.createElement('div');
          outLabel.className = 'tool-card-section-label';
          outLabel.textContent = stateType === 'error' ? 'Error' : 'Output';
          outPre = document.createElement('pre');
          outPre.className = 'tool-card-pre';
          outPre.setAttribute('data-role', 'output');
          body?.append(outLabel, outPre);
        }
        const outText = typeof rawOutput === 'string'
          ? rawOutput
          : JSON.stringify(rawOutput, null, 2);
        outPre.textContent = outText.length > 2000 ? outText.slice(0, 2000) + '\n…' : outText;
        outPre.style.display = 'block';
      }
    }

    // ── Text part finalized — replace streaming span with rendered markdown ──
    if (updatedPart.type === 'text' && updatedPart.content !== undefined && el.classList.contains('agent-text-part')) {
      el.innerHTML = '';
      const textDiv = document.createElement('div');
      textDiv.className = 'message-content-text';
      textDiv.innerHTML = this._parseMarkdownWithLatex(updatedPart.content || '');
      this._enhanceCodeBlocks(textDiv);
      el.appendChild(textDiv);
    }
  }

  /**
   * Called when session.status → 'idle'.
   * Wires up copy/regen/speak actions on the completed live message.
   */
  finalizeAgentResponse(finalText, usage, modelType) {
    if (!this._liveMsgEl) return;
    const contentDiv = this._liveContent;
    if (contentDiv && finalText) {
      this._addMessageActions(contentDiv, finalText, this._liveMsgEl);
    }
    if (usage) this._appendUsage(this._liveMsgEl, usage, modelType || '');
    if (this._ttsConfig?.autoRead && finalText) this._speak(finalText);
    this._liveMsgEl   = null;
    this._liveContent = null;
    this._partEls     = null;
    this.scrollToBottom();
  }

  /** Create a DOM element for a Part object. Returns null for invisible parts. */
  _createPartEl(part) {
    switch (part.type) {
      case 'text':      return this._createTextPartEl(part);
      case 'tool':      return this._createToolCardEl(part);
      case 'patch':     return this._createPatchViewerEl(part);
      case 'reasoning': return this._createReasoningBlockEl(part);
      case 'error':     return this._createErrorPartEl(part);
      case 'step-start': case 'step-finish': case 'compaction': case 'todo':
        return null; // invisible or handled elsewhere
      default: return null;
    }
  }

  _createTextPartEl(part) {
    const el = document.createElement('div');
    el.className = 'agent-text-part';
    // Text parts arrive with content:'' and are filled via part.delta streaming.
    // Only render as markdown when content is already fully populated (history replay).
    if (!part.content || part.time?.end === null) {
      // Streaming — will be filled via part.delta
      const span = document.createElement('span');
      span.className = 'agent-text-streaming';
      span.textContent = part.content || '';
      el.appendChild(span);
    } else {
      const textDiv = document.createElement('div');
      textDiv.className = 'message-content-text';
      textDiv.innerHTML = this._parseMarkdownWithLatex(part.content || '');
      this._enhanceCodeBlocks(textDiv);
      el.appendChild(textDiv);
    }
    return el;
  }

  _createToolCardEl(part) {
    // part.state is an object: { type: 'pending'|'running'|'completed'|'error', output?, message? }
    const stateType = part.state?.type || 'pending';
    const card = document.createElement('div');
    card.className = `tool-card ${stateType}`;

    // Use part.input (the actual field name from makeToolPart)
    const input = part.input || {};
    const argsPreview = Object.keys(input).length > 0
      ? Object.entries(input)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(', ')
          .slice(0, 80)
      : '';

    const iconHtml = stateType === 'completed'
      ? '<span class="tool-card-icon-done">✓</span>'
      : stateType === 'error'
        ? '<span class="tool-card-icon-err">✕</span>'
        : '<div class="tool-card-spinner"></div>';

    const header = document.createElement('div');
    header.className = 'tool-card-header';
    header.innerHTML = `${iconHtml}
      <span class="tool-card-name">${part.toolName || 'tool'}</span>
      ${argsPreview ? `<span class="tool-card-args-preview">${argsPreview}</span>` : ''}
      <span class="tool-card-chevron">›</span>`;

    const body = document.createElement('div');
    body.className = 'tool-card-body';

    if (Object.keys(input).length > 0) {
      const lbl = document.createElement('div');
      lbl.className = 'tool-card-section-label';
      lbl.textContent = 'Input';
      const pre = document.createElement('pre');
      pre.className = 'tool-card-pre';
      pre.textContent = JSON.stringify(input, null, 2);
      body.append(lbl, pre);
    }

    const streamPre = document.createElement('pre');
    streamPre.className = 'tool-stream-pre';
    streamPre.style.display = stateType === 'running' ? 'block' : 'none';
    body.appendChild(streamPre);

    // Output section (for completed / error states)
    const existingOutput = part.state?.output;
    const existingError  = part.state?.message;
    const rawOut = existingOutput !== undefined ? existingOutput : existingError;
    if (rawOut !== undefined && rawOut !== null) {
      const outLabel = document.createElement('div');
      outLabel.className = 'tool-card-section-label';
      outLabel.textContent = stateType === 'error' ? 'Error' : 'Output';
      const outPre = document.createElement('pre');
      outPre.className = 'tool-card-pre';
      outPre.setAttribute('data-role', 'output');
      const t = typeof rawOut === 'string' ? rawOut : JSON.stringify(rawOut, null, 2);
      outPre.textContent = t.length > 2000 ? t.slice(0, 2000) + '\n…' : t;
      body.append(outLabel, outPre);
    } else {
      const outPre = document.createElement('pre');
      outPre.className = 'tool-card-pre';
      outPre.setAttribute('data-role', 'output');
      outPre.style.display = 'none';
      body.appendChild(outPre);
    }

    card.append(header, body);

    header.addEventListener('click', () => {
      card.classList.toggle('expanded');
      streamPre.style.display =
        card.classList.contains('expanded') && card.classList.contains('running')
          ? 'block' : 'none';
    });

    if (stateType === 'running') card.classList.add('expanded');
    return card;
  }

  _createPatchViewerEl(part) {
    const viewer = document.createElement('div');
    viewer.className = 'patch-viewer';

    const header = document.createElement('div');
    header.className = 'patch-viewer-header';
    header.innerHTML = `
      <span class="patch-file-name">${part.filePath || 'file'}</span>
      <span class="patch-stats">
        <span class="patch-stat-add">+${part.additions || 0}</span>
        <span style="color:var(--t-dim)"> / </span>
        <span class="patch-stat-del">-${part.deletions || 0}</span>
      </span>
      <span class="patch-chevron">›</span>`;

    const body = document.createElement('div');
    body.className = 'patch-viewer-body';

    if (part.diff) {
      for (const line of (part.diff + '').split('\n')) {
        const lineEl = document.createElement('div');
        if      (line.startsWith('+++') || line.startsWith('---')) lineEl.className = 'patch-line patch-line-ctx';
        else if (line.startsWith('@@'))  lineEl.className = 'patch-line patch-line-hunk';
        else if (line.startsWith('+'))   lineEl.className = 'patch-line patch-line-add';
        else if (line.startsWith('-'))   lineEl.className = 'patch-line patch-line-del';
        else                             lineEl.className = 'patch-line patch-line-ctx';
        lineEl.textContent = line;
        body.appendChild(lineEl);
      }
    }

    viewer.append(header, body);
    header.addEventListener('click', () => viewer.classList.toggle('expanded'));
    return viewer;
  }

  _createReasoningBlockEl(part) {
    const el = document.createElement('div');
    el.className = 'reasoning-block';
    const lbl = document.createElement('div');
    lbl.className = 'reasoning-block-label';
    lbl.textContent = 'Reasoning';
    const txt = document.createElement('div');
    txt.className = 'reasoning-block-text';
    txt.textContent = part.content || '';
    el.append(lbl, txt);
    return el;
  }

  _createErrorPartEl(part) {
    const el = document.createElement('div');
    el.className = 'agent-error-part';
    el.style.cssText = 'color:#c06060;padding:4px 8px;font-size:12px;border-left:2px solid #c06060;margin:4px 0;';
    el.textContent = `⚠ ${part.message || 'Unknown error'}`;
    return el;
  }

  /**
   * Show the AgentRuntime permission request banner.
   * Called by renderer.js on permission.request events.
   */
  showAgentPermissionBanner(data) {
    const container = document.getElementById('permissionBannerContainer');
    if (!container) return;

    const { requestId, toolName, args } = data;
    const argsText = args
      ? Object.entries(args).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n').slice(0, 300)
      : '';

    const banner = document.createElement('div');
    banner.className = 'permission-banner';
    banner.dataset.reqId = requestId;
    banner.innerHTML = `
      <div class="permission-banner-icon">🔧</div>
      <div class="permission-banner-body">
        <div class="permission-banner-title">Allow <strong>${toolName}</strong>?</div>
        ${argsText ? `<pre class="permission-banner-detail">${argsText}</pre>` : ''}
        <div class="permission-banner-actions">
          <button class="perm-btn perm-btn-deny">Deny</button>
          <button class="perm-btn perm-btn-allow">Allow once</button>
          <button class="perm-btn perm-btn-always">Always allow this session</button>
        </div>
      </div>`;

    const respond = (approved, alwaysAllow = false) => {
      window.electronAPI?.respondAgentPermission?.(requestId, approved, alwaysAllow);
      banner.remove();
    };

    banner.querySelector('.perm-btn-deny').addEventListener('click',   () => respond(false));
    banner.querySelector('.perm-btn-allow').addEventListener('click',  () => respond(true, false));
    banner.querySelector('.perm-btn-always').addEventListener('click', () => respond(true, true));

    container.appendChild(banner);
    banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /** Remove a permission banner by requestId (e.g. if resolved programmatically). */
  dismissAgentPermissionBanner(requestId) {
    document.querySelector(`.permission-banner[data-req-id="${requestId}"]`)?.remove();
  }

  /**
   * Permission gate — handled by AgentRuntime's permission.request events.
   * showAgentPermissionBanner() is called from the onAgentEvent listener in renderer.js.
   */
  _setupToolConfirmation() {
    // No-op: all permission requests now come through AgentRuntime events.
    // Kept as a method for backward compat (called in constructor).
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.chatInterface = new ChatInterface();
});
