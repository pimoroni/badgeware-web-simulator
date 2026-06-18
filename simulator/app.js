/* ── Main application — called from the Monaco require() callback ────────── */
async function initApp() {

  configureMonaco(monaco);

  /* ── Editor ────────────────────────────────────────────────────── */
  const editor = monaco.editor.create(document.getElementById('editor'), {
    value:          '# Loading…',
    language:       'python',
    theme:          'badgeware',
    fontSize:       14,
    fontFamily:     'Consolas, Monaco, "Andale Mono", "Ubuntu Mono", monospace',
    fontLigatures:  true,
    minimap:        { enabled: false },
    scrollBeyondLastLine: false,
    lineNumbers:    'on',
    tabSize:        2,
    insertSpaces:   true,
    automaticLayout: true,
    wordWrap:       'on',
    renderLineHighlight: 'line',
    suggestOnTriggerCharacters: true,
    quickSuggestions: { other: true, comments: false, strings: false },
    parameterHints: { enabled: true },
  });

  // Load default example into the editor
  const defaultCode = await fetch('/simulator/examples/default_code.py')
    .then(r => r.ok ? r.text() : null)
    .catch(() => null)
    ?? 'badge.mode(HIRES)\n\ndef update():\n    screen.text("Hello!", 10, 10)\n';

  /* ── File / model state (needed early so model functions can reference them) */
  let currentFilePath = null;   // FS path when a user file is active, otherwise null
  let currentReadOnly = false;
  let currentTabKey   = null;   // key into openModels for the active tab
  let transientTabKey = null;   // key of the one transient (preview) tab, if any
  const openModels    = new Map();  // tabKey → { model, dirty, readOnly, transient, label? }
  const openOrder     = [];         // ordered list of open tabKeys

  // Bootstrap the default scratch tab (openScratchTab is hoisted as a function decl)
  openScratchTab('default_code.py', defaultCode);

  /* ── Simulator ─────────────────────────────────────────────────── */
  const simHost   = document.getElementById('sim-host');
  const stdoutEl  = document.getElementById('stdout');
  const statusEl  = document.getElementById('status');

  const simulator = await BadgewareSimulator(simHost);

  const appendOut = (text, cls) => {
    const span = document.createElement('span');
    span.textContent = text + '\n';
    if (cls) span.className = cls;
    stdoutEl.appendChild(span);
    stdoutEl.scrollTop = stdoutEl.scrollHeight;
  };

  /* ── 3D badge display (non-blocking) ──────────────────────────── */
  const { applyCanvasToScreen, pauseScreen, rotateView } = initBadge3D(simulator, appendOut);

  /* ── Runtime error → Monaco marker wiring ─────────────────────── */
  let lastRunKey   = null;   // tab key active when Run was pressed
  let traceFrames  = [];     // [{file, line}] accumulated during current traceback

  function clearRuntimeMarkers() {
    for (const info of openModels.values()) {
      if (info.model) monaco.editor.setModelMarkers(info.model, 'micropython', []);
    }
  }

  function applyTracebackMarkers(errorMsg) {
    // Group frames by model (multiple frames can hit the same file)
    const markersByModel = new Map();
    for (const frame of traceFrames) {
      // <stdin> is the code passed directly to runPython — the active tab at run time
      const key  = frame.file === '<stdin>' ? lastRunKey : frame.file;
      if (!key) continue;
      const info = openModels.get(key);
      if (!info?.model) continue;
      const model  = info.model;
      const lineNo = Math.min(Math.max(frame.line, 1), model.getLineCount());
      const list   = markersByModel.get(model) ?? [];
      list.push({
        startLineNumber: lineNo,
        startColumn:     1,
        endLineNumber:   lineNo,
        endColumn:       model.getLineLength(lineNo) + 1,
        message:         errorMsg,
        severity:        monaco.MarkerSeverity.Error,
      });
      markersByModel.set(model, list);
    }
    for (const [model, markers] of markersByModel) {
      monaco.editor.setModelMarkers(model, 'micropython', markers);
    }
  }

  // Called for every stdout line — parse MicroPython traceback incrementally
  function parseTracebackLine(text) {
    // "  File "path", line N[, in func]"
    const fileMatch = text.match(/^\s+File "([^"]+)", line (\d+)/);
    if (fileMatch) {
      traceFrames.push({ file: fileMatch[1], line: parseInt(fileMatch[2], 10) });
      return;
    }
    // Start of a new exception block — reset so previous partial traces don't leak
    if (text.startsWith('Traceback (most recent call last):')) {
      traceFrames = [];
      return;
    }
    // Terminal error line: non-whitespace start, frames already accumulated
    // e.g. "TypeError: ...", "SyntaxError: ...", "OSError: ..."
    if (traceFrames.length > 0 && /^\w/.test(text)) {
      applyTracebackMarkers(text);
      traceFrames = [];
      // A fatal exception ends the program — reflect that in the toolbar.
      onSimulatorStopped();
    }
  }

  // Override the simulator's stdout handler
  simulator.stdout = async (text) => {
    parseTracebackLine(text);
    appendOut(text);
  };

  /* ── Run / Stop action ─────────────────────────────────────────── */
  const runBtn  = document.getElementById('run-btn');
  const stopBtn = document.getElementById('stop-btn');
  let isRunning = false;

  // Stop is only meaningful while something is running; Run always re-runs.
  const setRunning = (running) => {
    isRunning = running;
    stopBtn.disabled = !running;
  };

  // The simulator stopped on its own (e.g. a fatal exception was raised).
  const onSimulatorStopped = () => {
    if (!isRunning) return;
    setRunning(false);
    statusEl.textContent = 'Stopped (error)';
  };

  const runCode = async () => {
    const code = editor.getValue();
    // Auto-save to user FS if a named file is open
    if (currentFilePath && !currentReadOnly) {
      userFS.set(currentFilePath, { text: code, binary: false });
    }
    clearRuntimeMarkers();
    traceFrames = [];
    lastRunKey  = currentTabKey;
    stdoutEl.innerHTML = '';
    appendOut('▶ Running…', 'out-dim');
    statusEl.textContent = 'Running…';
    setRunning(true);
    // simulator.run() tears down the old worker/canvas first; drop the screen
    // texture so the render loop never touches the destroyed canvas.
    pauseScreen();
    try {
      await simulator.run(code, userFS.workerFiles());
      applyCanvasToScreen();
      statusEl.textContent = currentFilePath && !currentReadOnly ? currentFilePath : '';
    } catch (err) {
      appendOut('✕ ' + err, 'out-error');
      statusEl.textContent = 'Error';
      setRunning(false);
    }
  };

  const stopCode = async () => {
    // Halt screen rendering before the canvas is destroyed (see pauseScreen).
    pauseScreen();
    await simulator.stop();
    setRunning(false);
    statusEl.textContent = 'Stopped';
  };

  // F5 keybinding inside the editor
  editor.addAction({
    id:                   'badgeware.run',
    label:                'Run in Simulator',
    keybindings:          [monaco.KeyCode.F5],
    contextMenuGroupId:   'navigation',
    contextMenuOrder:     1,
    run:                  runCode,
  });

  // Ctrl/Cmd+S — explicit save
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveCurrentFile);

  /* ── Toolbar wiring ────────────────────────────────────────────── */
  runBtn.addEventListener('click', runCode);
  stopBtn.addEventListener('click', stopCode);

  /* ── 3D badge spin buttons (180° steps) ────────────────────────── */
  document.getElementById('view-prev-btn').addEventListener('click', () => rotateView(-1));
  document.getElementById('view-next-btn').addEventListener('click', () => rotateView(+1));

  document.getElementById('example-select').addEventListener('change', async (e) => {
    if (!e.target.value) return;
    const name = e.target.value.split('/').pop();
    const code = await fetch(e.target.value).then(r => r.ok ? r.text() : null).catch(() => null);
    if (code != null) openScratchTab(name, code);
    e.target.value = '';
  });

  document.getElementById('clear-btn').addEventListener('click', () => {
    stdoutEl.innerHTML = '';
  });

  /* ── Load system file list ─────────────────────────────────────── */
  try {
    const fsData = await fetch('/simulator/filesystem.json').then(r => r.json());
    systemPaths = (fsData.files || []);
    // Reset the built flag so refreshFileTree rebuilds the sys tree with real paths
    const sysTreeEl = document.getElementById('fp-sys-tree');
    if (sysTreeEl) { sysTreeEl._built = false; sysTreeEl.innerHTML = ''; }
  } catch (_) {}

  /* ── File browser state ────────────────────────────────────────── */
  function setCurrentFile(tabKey, readOnly = false) {
    currentTabKey   = tabKey;
    // User-file keys are bare FS paths starting with '/'; others have a scheme prefix
    currentFilePath = (tabKey && !tabKey.includes(':')) ? tabKey : null;
    currentReadOnly = readOnly;
    editor.updateOptions({ readOnly });
    renderTabs();
    refreshFileTree();
  }

  /* ── Tab / model management ────────────────────────────────────── */
  function langForPath(p) {
    return p.endsWith('.py') ? 'python' : p.endsWith('.json') ? 'json' : 'plaintext';
  }

  function tabLabel(key) {
    const info = openModels.get(key);
    if (info?.label) return info.label;
    return key.includes(':') ? key.split(':').pop().split('/').pop() : key.split('/').pop();
  }

  function renderTabs() {
    const bar = document.getElementById('tab-bar');
    if (!bar) return;
    bar.innerHTML = '';
    for (const key of openOrder) {
      const info = openModels.get(key);
      if (!info) continue;
      const isActive = key === currentTabKey;
      const tab = document.createElement('div');
      tab.className = 'tab' + (isActive ? ' active' : '') + (info.dirty ? ' dirty' : '') + (info.transient ? ' transient' : '');
      tab.title = key;

      const name = document.createElement('span');
      name.className = 'tab-name';
      name.textContent = tabLabel(key);

      if (info.readOnly) {
        const ro = document.createElement('span');
        ro.className = 'tab-readonly';
        ro.textContent = '🔒';
        tab.appendChild(name);
        tab.appendChild(ro);
      } else {
        tab.appendChild(name);
      }

      const x = document.createElement('button');
      x.className = 'tab-close';
      x.textContent = '✕';
      x.title = 'Close';
      x.addEventListener('click', ev => { ev.stopPropagation(); closeTab(key); });
      tab.appendChild(x);
      tab.addEventListener('click',    () => focusTab(key));
      tab.addEventListener('dblclick', () => promoteTab(key));
      bar.appendChild(tab);
    }
  }

  function focusTab(key) {
    const info = openModels.get(key);
    if (!info) return;
    currentTabKey   = key;
    currentFilePath = key.includes(':') ? null : key;
    currentReadOnly = info.readOnly;

    const editorEl  = document.getElementById('editor');
    const imgEl     = document.getElementById('img-preview');

    if (info.imgUrl) {
      editorEl.style.display  = 'none';
      imgEl.style.display     = 'flex';
      const imgTag = document.getElementById('img-preview-img');
      imgTag.src = info.imgUrl;
      document.getElementById('img-preview-name').textContent = tabLabel(key);
      if (info.dimText) {
        document.getElementById('img-preview-dim').textContent = info.dimText;
      } else {
        document.getElementById('img-preview-dim').textContent = '';
        imgTag.onload = () => {
          document.getElementById('img-preview-dim').textContent = imgTag.naturalWidth + ' × ' + imgTag.naturalHeight + ' px';
        };
      }
    } else {
      editorEl.style.display  = '';
      imgEl.style.display     = 'none';
      editor.setModel(info.model);
      editor.updateOptions({ readOnly: info.readOnly });
    }

    refreshFileTree();
    renderTabs();
  }

  function closeTab(key) {
    const info = openModels.get(key);
    if (!info) return;
    if (info.dirty && !confirm('Close "' + tabLabel(key) + '" with unsaved changes?')) return;
    if (info.imgUrl) URL.revokeObjectURL(info.imgUrl);
    else if (info.model) info.model.dispose();
    openModels.delete(key);
    if (transientTabKey === key) transientTabKey = null;
    const idx = openOrder.indexOf(key);
    if (idx !== -1) openOrder.splice(idx, 1);
    if (currentTabKey === key) {
      if (openOrder.length > 0) {
        focusTab(openOrder[Math.max(0, idx - 1)]);
      } else {
        openScratchTab('untitled.py', '');
      }
    }
    renderTabs();
  }

  function evictTransient(incomingKey) {
    if (!transientTabKey || transientTabKey === incomingKey) return;
    const info = openModels.get(transientTabKey);
    if (!info) { transientTabKey = null; return; }
    if (info.imgUrl) URL.revokeObjectURL(info.imgUrl);
    else if (info.model) info.model.dispose();
    openOrder.splice(openOrder.indexOf(transientTabKey), 1);
    openModels.delete(transientTabKey);
    transientTabKey = null;
  }

  function promoteTab(key) {
    const info = openModels.get(key);
    if (!info || !info.transient) return;
    info.transient = false;
    if (transientTabKey === key) transientTabKey = null;
    renderTabs();
  }

  function openScratchTab(name, content) {
    const key = 'scratch:' + name;
    if (openModels.has(key)) { focusTab(key); return; }
    const uri   = monaco.Uri.parse('badgeware:///scratch/' + encodeURIComponent(name));
    const model = monaco.editor.createModel(content, langForPath(name), uri);
    openModels.set(key, { model, dirty: false, readOnly: false, label: name });
    openOrder.push(key);
    currentTabKey   = key;
    currentFilePath = null;
    currentReadOnly = false;
    editor.setModel(model);
    editor.updateOptions({ readOnly: false });
    renderTabs();
    refreshFileTree();
  }

  function saveCurrentFile() {
    if (!currentTabKey) return;
    if (currentReadOnly) return;

    if (!currentTabKey.includes(':')) {
      // User file — already auto-saved; just flash confirmation
      const prev = statusEl.textContent;
      statusEl.textContent = '✓ Saved ' + tabLabel(currentTabKey);
      setTimeout(() => { statusEl.textContent = prev; }, 1400);
      return;
    }

    // Scratch tab — prompt for name to save as user file
    const suggested = tabLabel(currentTabKey);
    const input = prompt('Save as:', suggested.endsWith('.py') ? suggested : suggested + '.py');
    if (!input) return;
    const path = normalisePath(input);
    const text = editor.getValue();
    userFS.set(path, { text, binary: false });

    // Re-key the existing model as a permanent user-file tab
    const prevKey = currentTabKey;
    const info    = openModels.get(prevKey);
    if (transientTabKey === prevKey) transientTabKey = null;
    openModels.delete(prevKey);
    const idx = openOrder.indexOf(prevKey);
    openOrder.splice(idx, 1, path);
    openModels.set(path, { ...info, dirty: false, readOnly: false, transient: false, label: null });
    currentTabKey   = path;
    currentFilePath = path;

    refreshFileTree();
    renderTabs();
    statusEl.textContent = '✓ Saved ' + path;
    setTimeout(() => { statusEl.textContent = path; }, 1500);
  }

  /* ── System file tree ───────────────────────────────────────────── */
  function buildDirTree(paths) {
    const root = {};
    for (const p of paths) {
      // Paths ending with / are explicit directory markers
      const isDir = p.endsWith('/');
      const parts = p.split('/').filter(Boolean);
      let node = root;
      const limit = isDir ? parts.length : parts.length - 1;
      for (let i = 0; i < limit; i++) {
        if (!node[parts[i]]) node[parts[i]] = { __dir: true };
        node = node[parts[i]];
      }
      if (!isDir) node[parts[parts.length - 1]] = null;
    }
    return root;
  }

  function renderDirNode(node, pathPrefix, depth) {
    const wrap = document.createElement('div');
    if (depth > 0) wrap.className = 'dir-children';

    const entries = Object.entries(node)
      .filter(([k]) => k !== '__dir')
      .sort(([a, av], [b, bv]) => {
        const ad = av && av.__dir, bd = bv && bv.__dir;
        return (ad === bd) ? a.localeCompare(b) : (ad ? -1 : 1);
      });

    for (const [name, child] of entries) {
      const fullPath = pathPrefix + '/' + name;
      if (child && child.__dir) {
        const details = document.createElement('details');
        details.className = 'tree-dir';
        const summary = document.createElement('summary');
        summary.innerHTML = `<span class="dir-arrow">&#9658;</span><span>${name}/</span>`;
        details.appendChild(summary);
        details.appendChild(renderDirNode(child, fullPath, depth + 1));
        wrap.appendChild(details);
      } else {
        const row = document.createElement('div');
        row.className = 'tree-row';
        row.dataset.path = fullPath;
        row.title = fullPath;
        row.innerHTML = `<span class="row-name">${name}</span><span class="row-badge" title="System file">&#128274;</span>`;
        row.addEventListener('click',    () => openSysFile(fullPath, true));
        row.addEventListener('dblclick', () => openSysFile(fullPath, false));
        wrap.appendChild(row);
      }
    }
    return wrap;
  }

  /* ── File helpers ──────────────────────────────────────────────── */
  /* ── File-type dispatch table ──────────────────────────────────── */
  /* kind: 'text'    — open in Monaco editor                         */
  /* kind: 'image'   — decode bytes → blob URL → img preview         */
  /* kind: 'preview' — parse binary → render canvas → img preview    */
  const FILE_HANDLERS = {
    '.ppf':  { kind: 'preview', keyPrefix: 'ppf', open: buf => ppfPreview(ppfParse(buf)) },
    '.af':   { kind: 'preview', keyPrefix: 'af',  open: buf => afPreview(afParse(buf)) },
    '.png':  { kind: 'image',   mime: 'image/png' },
    '.jpg':  { kind: 'image',   mime: 'image/jpeg' },
    '.jpeg': { kind: 'image',   mime: 'image/jpeg' },
    '.svg':  { kind: 'image',   mime: 'image/svg+xml' },
    '.gif':  { kind: 'image',   mime: 'image/gif' },
    '.bmp':  { kind: 'image',   mime: 'image/bmp' },
    '.webp': { kind: 'image',   mime: 'image/webp' },
    '.py':   { kind: 'text' },
    '.json': { kind: 'text' },
    '.txt':  { kind: 'text' },
    '.md':   { kind: 'text' },
    '.csv':  { kind: 'text' },
    '.toml': { kind: 'text' },
    '.ini':  { kind: 'text' },
    '.mpy':  { kind: 'text' },
  };

  function normalisePath(raw) {
    // Ensure the path starts with / and trim whitespace
    const p = raw.trim();
    return p.startsWith('/') ? p : '/' + p;
  }

  function openBinaryTab(key, buf, handler, transient, mimeOverride) {
    if (openModels.has(key)) {
      if (!transient && openModels.get(key).transient) promoteTab(key);
      focusTab(key);
      return;
    }
    if (transient) evictTransient(key);
    try {
      let imgUrl, dimText;
      if (handler.kind === 'preview') {
        ({ imgUrl, dimText } = handler.open(buf));
      } else {
        imgUrl = URL.createObjectURL(new Blob([buf], { type: mimeOverride || handler.mime }));
      }
      openModels.set(key, { model: null, dirty: false, readOnly: true, imgUrl, dimText, label: key.slice(key.lastIndexOf('/') + 1), transient });
      openOrder.push(key);
      if (transient) transientTabKey = key;
    } catch (_) { return; }
    focusTab(key);
  }

  async function openSysFile(path, transient = false) {
    const ext     = path.slice(path.lastIndexOf('.'));
    const handler = FILE_HANDLERS[ext];
    if (!handler) return;

    if (handler.kind === 'text') {
      const key = 'sys:' + path;
      if (openModels.has(key)) {
        if (!transient && openModels.get(key).transient) promoteTab(key);
        focusTab(key);
        statusEl.textContent = path + ' — read-only';
        return;
      }
      if (transient) evictTransient(key);
      try {
        const text  = await fetch('/simulator/filesystem' + path).then(r => { if (!r.ok) throw new Error(); return r.text(); });
        const uri   = monaco.Uri.parse('badgeware:///sys' + encodeURIComponent(path));
        const model = monaco.editor.createModel(text, langForPath(path), uri);
        openModels.set(key, { model, dirty: false, readOnly: true, transient });
        openOrder.push(key);
        if (transient) transientTabKey = key;
      } catch (_) { return; }
      focusTab(key);
    } else {
      const key = (handler.keyPrefix ?? 'img') + ':sys:' + path;
      try {
        const buf = await fetch('/simulator/filesystem' + path).then(r => { if (!r.ok) throw new Error(); return r.arrayBuffer(); });
        openBinaryTab(key, buf, handler, transient);
      } catch (_) {}
    }
    statusEl.textContent = path + ' — read-only';
  }

  function openUserFile(path, transient = false) {
    const entry = userFS.get(path);
    if (!entry || entry.isDir) return;
    const ext     = path.slice(path.lastIndexOf('.')).toLowerCase();
    const handler = FILE_HANDLERS[ext];
    if (!handler) return;

    if (handler.kind !== 'text') {
      const bytes = entry.binary ? b64ToBytes(entry.data) : new TextEncoder().encode(entry.text);
      openBinaryTab((handler.keyPrefix ?? 'img') + ':' + path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), handler, transient, entry.mimeType);
      return;
    }

    if (entry.binary) return;
    if (openModels.has(path)) {
      if (!transient && openModels.get(path).transient) promoteTab(path);
      focusTab(path);
      return;
    }
    if (transient) evictTransient(path);
    const uri   = monaco.Uri.parse('badgeware:///user' + encodeURIComponent(path));
    const model = monaco.editor.createModel(entry.text, langForPath(path), uri);
    openModels.set(path, { model, dirty: false, readOnly: false, transient });
    openOrder.push(path);
    if (transient) transientTabKey = path;
    focusTab(path);
  }

  /* ── User-tree renderer (hierarchical, with context menu + actions) */
  function renderUserDirNode(node, pathPrefix, depth) {
    const wrap = document.createElement('div');
    if (depth > 0) wrap.className = 'dir-children';

    const entries = Object.entries(node)
      .filter(([k]) => k !== '__dir')
      .sort(([a, av], [b, bv]) => {
        const ad = av && av.__dir, bd = bv && bv.__dir;
        return (ad === bd) ? a.localeCompare(b) : (ad ? -1 : 1);
      });

    for (const [name, child] of entries) {
      const fullPath = pathPrefix + '/' + name;
      if (child && child.__dir) {
        // Directory
        const details = document.createElement('details');
        details.className = 'tree-dir';
        details.open = true;
        const summary = document.createElement('summary');
        const arrow = document.createElement('span');
        arrow.className = 'dir-arrow';
        arrow.innerHTML = '&#9658;';
        const label = document.createElement('span');
        label.textContent = name + '/';
        summary.appendChild(arrow);
        summary.appendChild(label);
        summary.addEventListener('contextmenu', e => showCtxMenu(e, fullPath, true));
        details.appendChild(summary);
        details.appendChild(renderUserDirNode(child, fullPath, depth + 1));
        wrap.appendChild(details);
      } else {
        // File
        const entry = userFS.get(fullPath);
        const row = document.createElement('div');
        row.className = 'tree-row' + (fullPath === currentFilePath ? ' active' : '');
        row.dataset.path = fullPath;
        row.title = fullPath;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'row-name';
        nameSpan.textContent = name;
        nameSpan.appendChild(document.createTextNode(''));  // force text node

        const acts = document.createElement('span');
        acts.className = 'row-actions';

        const delBtn = document.createElement('button');
        delBtn.className = 'row-action ctx-danger';
        delBtn.title = 'Delete';
        delBtn.textContent = '✕';
        delBtn.addEventListener('click', e => { e.stopPropagation(); deleteUserPath(fullPath); });
        acts.appendChild(delBtn);

        row.appendChild(nameSpan);
        row.appendChild(acts);
        row.addEventListener('click',    () => openUserFile(fullPath, true));
        row.addEventListener('dblclick', () => openUserFile(fullPath, false));
        row.addEventListener('contextmenu', e => showCtxMenu(e, fullPath, false));
        wrap.appendChild(row);
      }
    }
    return wrap;
  }

  /* ── Context menu ───────────────────────────────────────────────── */
  let ctxTarget = null;  // { path, isDir }

  function showCtxMenu(e, path, isDir) {
    e.preventDefault();
    ctxTarget = { path, isDir };
    const menu = document.getElementById('file-ctx-menu');
    menu.querySelector('[data-action="open"]').style.display    = isDir ? 'none' : '';
    menu.querySelector('[data-action="new-here"]').style.display = '';
    menu.style.left    = e.clientX + 'px';
    menu.style.top     = e.clientY + 'px';
    menu.style.display = 'block';
    // Clamp within viewport
    requestAnimationFrame(() => {
      const r = menu.getBoundingClientRect();
      if (r.right  > innerWidth)  menu.style.left = (e.clientX - r.width)  + 'px';
      if (r.bottom > innerHeight) menu.style.top  = (e.clientY - r.height) + 'px';
    });
  }

  function hideCtxMenu() {
    document.getElementById('file-ctx-menu').style.display = 'none';
    ctxTarget = null;
  }

  // Capture phase: hide menu unless the click is inside the menu itself
  document.addEventListener('click', e => {
    if (!e.target.closest('#file-ctx-menu')) hideCtxMenu();
  }, true);
  document.addEventListener('contextmenu', e => {
    if (!e.target.closest('#file-ctx-menu')) hideCtxMenu();
  }, true);

  document.getElementById('file-ctx-menu').addEventListener('click', e => {
    const item = e.target.closest('.ctx-item');
    if (!item || !ctxTarget) return;
    const { path, isDir } = ctxTarget;
    hideCtxMenu();

    switch (item.dataset.action) {
      case 'open':
        openUserFile(path, false);
        break;

      case 'rename': {
        const parts   = path.split('/');
        const oldName = parts.pop();
        const dir     = parts.join('/') || '';
        const newName = prompt('Rename to:', oldName);
        if (!newName || newName === oldName) break;
        if (newName.includes('/')) { alert('File name cannot contain /'); break; }
        const newPath = dir + '/' + newName;
        if (userFS.get(newPath) && !confirm(newPath + ' already exists. Overwrite?')) break;
        if (isDir) {
          const prefix = path + '/';
          for (const p of userFS.paths()) {
            if (p !== path + '/' && !p.startsWith(prefix)) continue;
            const np = newPath + p.slice(path.length);
            userFS.set(np, userFS.get(p)); userFS.del(p);
            // Re-key any open model for this file
            if (openModels.has(p)) {
              const info = openModels.get(p);
              openModels.delete(p);
              openOrder.splice(openOrder.indexOf(p), 1, np);
              openModels.set(np, info);
              if (currentTabKey === p) { currentTabKey = np; currentFilePath = np; }
            }
          }
        } else {
          userFS.set(newPath, userFS.get(path));
          userFS.del(path);
          if (openModels.has(path)) {
            const info = openModels.get(path);
            openModels.delete(path);
            openOrder.splice(openOrder.indexOf(path), 1, newPath);
            openModels.set(newPath, info);
            if (currentTabKey === path) { currentTabKey = newPath; currentFilePath = newPath; }
          }
        }
        refreshFileTree();
        renderTabs();
        break;
      }

      case 'delete':
        deleteUserPath(path, isDir);
        break;

      case 'new-here': {
        const dir = isDir ? path : path.slice(0, path.lastIndexOf('/'));
        createUserFile(dir + '/');
        break;
      }

      case 'new-dir-here': {
        const dir = isDir ? path : path.slice(0, path.lastIndexOf('/'));
        createUserDirAt(dir);
        break;
      }
    }
  });

  function deleteUserPath(path, isDir = false) {
    const toDelete = isDir
      ? userFS.paths().filter(p => p === path + '/' || p.startsWith(path + '/'))
      : [path];
    if (!toDelete.length) return;
    const label = isDir ? path + '/ and all its contents' : path;
    if (!confirm('Delete ' + label + '?')) return;
    for (const p of toDelete) {
      userFS.del(p);
      for (const tabKey of [p, 'img:' + p]) {
        if (!openModels.has(tabKey)) continue;
        if (currentTabKey === tabKey) {
          openModels.get(tabKey).dirty = false;
          closeTab(tabKey);
        } else {
          const m = openModels.get(tabKey);
          if (m.imgUrl) URL.revokeObjectURL(m.imgUrl);
          else if (m.model) m.model.dispose();
          openModels.delete(tabKey);
          openOrder.splice(openOrder.indexOf(tabKey), 1);
        }
      }
    }
    renderTabs();
    refreshFileTree();
  }

  /* ── Render file tree ──────────────────────────────────────────── */
  function refreshFileTree() {
    // User files — hierarchical tree
    const userList = document.getElementById('fp-user-list');
    userList.innerHTML = '';
    const paths = userFS.paths();
    if (paths.length === 0) {
      userList.innerHTML = '<div class="fp-empty">No files yet.</div>';
    } else {
      const tree = buildDirTree(paths);
      userList.appendChild(renderUserDirNode(tree, '', 0));
    }

    // System tree — built once, active states updated on each call
    const sysTree = document.getElementById('fp-sys-tree');
    if (!sysTree._built) {
      sysTree._built = true;
      const tree = buildDirTree(systemPaths);
      sysTree.appendChild(renderDirNode(tree, '', 0));
    }
    sysTree.querySelectorAll('.tree-row').forEach(el => {
      el.classList.toggle('active', el.dataset.path === currentFilePath);
    });
  }

  /* ── File operations ───────────────────────────────────────────── */
  function createUserFile(dirPrefix = '/') {
    const name = prompt('File name:', 'untitled.py');
    if (!name) return;
    if (name.includes('/')) { alert('File name cannot contain /. Use the folder button to create directories.'); return; }
    const path = normalisePath(dirPrefix + name);
    if (userFS.get(path) && !confirm(path + ' already exists. Overwrite?')) return;
    userFS.set(path, { text: '', binary: false });
    refreshFileTree();
    openUserFile(path, false);
  }

  function createUserDirAt(parentPath = '') {
    const name = prompt('Folder name:', 'assets');
    if (!name) return;
    if (name.includes('/')) { alert('Folder name cannot contain /'); return; }
    const base    = parentPath.replace(/\/+$/, '');
    const dirPath = (base || '') + '/' + name + '/';
    if (!userFS.get(dirPath)) userFS.set(dirPath, { isDir: true });
    refreshFileTree();
  }

  document.getElementById('fp-new').addEventListener('click',   () => createUserFile('/'));
  document.getElementById('fp-mkdir').addEventListener('click', () => createUserDirAt(''));

  document.getElementById('fp-upload').addEventListener('click', () =>
    document.getElementById('fp-upload-input').click()
  );

  document.getElementById('fp-upload-input').addEventListener('change', async e => {
    for (const file of e.target.files) {
      const path   = normalisePath(file.name);
      const isText = FILE_HANDLERS[path.slice(path.lastIndexOf('.'))]?.kind === 'text' || file.type.startsWith('text/');
      if (isText) {
        userFS.set(path, { text: await file.text(), binary: false });
      } else {
        const buf = await file.arrayBuffer();
        userFS.set(path, { data: bytesToB64(new Uint8Array(buf)), binary: true, mimeType: file.type });
      }
    }
    refreshFileTree();
    e.target.value = '';
  });

  /* ── Auto-save / dirty tracking ───────────────────────────────── */
  editor.onDidChangeModelContent(() => {
    if (!currentTabKey) return;
    const info = openModels.get(currentTabKey);
    if (!info) return;
    // Editing a transient tab promotes it permanently
    if (info.transient) {
      info.transient = false;
      if (transientTabKey === currentTabKey) transientTabKey = null;
      renderTabs();
    }
    if (currentFilePath && !currentReadOnly) {
      // User file — auto-save silently
      userFS.set(currentFilePath, { text: editor.getValue(), binary: false });
      info.dirty = false;
    } else if (!currentReadOnly) {
      // Scratch tab — mark dirty so the user knows to save
      if (!info.dirty) { info.dirty = true; renderTabs(); }
    }
  });

  /* Initial file tree render */
  refreshFileTree();

  initResizeHandlers();

  /* ── Auto-run on load ──────────────────────────────────────────── */
  await runCode();
}
