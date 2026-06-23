/* ── badgeware-web entry point ──────────────────────────────────────────────
   Two phases that run in parallel:
     • bootSimulator()  — spins up the simulator + 3D badge and runs main.py.
       Has no dependency on Monaco, so it's kicked off immediately (see bottom
       of file) rather than waiting for the editor bundle to download.
     • initApp()        — called once Monaco is ready; builds the editor and
       wires the UI to the already-running simulator. */
const APP_BASE = new URL('.', document.currentScript.src).href;

/* ── Simulator boot (Monaco-independent) ───────────────────────────────────
   Resolves to a shared context the editor wires itself into. Idempotent. */
let _bootCtx = null;
function bootSimulator() {
  if (_bootCtx) return _bootCtx;
  _bootCtx = (async () => {
    await userFS.ready;   // populate the in-memory FS cache before any read below
    const stdoutEl = document.getElementById('stdout');
    const statusEl = document.getElementById('status');
    const stopBtn  = document.getElementById('stop-btn');

    const appendOut = (text, cls) => {
      const span = document.createElement('span');
      span.textContent = text + '\n';
      if (cls) span.className = cls;
      stdoutEl.appendChild(span);
      stdoutEl.scrollTop = stdoutEl.scrollHeight;
    };

    const simulator = await BadgewareSimulator();
    const { applyCanvasToScreen, pauseScreen, rotateView } = initBadge3D(simulator, appendOut);

    /* Run / Stop state (the Stop button is meaningful only while running). */
    let isRunning = false;
    const setRunning = (running) => { isRunning = running; stopBtn.disabled = !running; };
    const onSimulatorStopped = () => {
      if (!isRunning) return;
      setRunning(false);
      statusEl.textContent = 'Stopped (error)';
    };

    /* Incremental MicroPython traceback parsing. The editor attaches marker
       hooks (trace.clear / trace.apply) later; until then they're no-ops. */
    const trace = { frames: [], lastRunKey: null, clear: null, apply: null };
    // Returns true when `text` is part of a Python traceback (header, a `File …`
    // frame, or the terminal exception line) so the console can render it red.
    function parseTracebackLine(text) {
      const fileMatch = text.match(/^\s+File "([^"]+)", line (\d+)/);
      if (fileMatch) {
        trace.frames.push({ file: fileMatch[1], line: parseInt(fileMatch[2], 10) });
        return true;
      }
      // Header — the runtime may prefix it (e.g. "- ERROR: Traceback …"), so match
      // anywhere in the line rather than only at the start.
      if (text.includes('Traceback (most recent call last):')) {
        trace.frames = [];
        return true;
      }
      // Terminal error line: non-whitespace start, frames already accumulated.
      if (trace.frames.length > 0 && /^\w/.test(text)) {
        if (trace.apply) trace.apply(text, trace.frames, trace.lastRunKey);
        trace.frames = [];
        onSimulatorStopped();   // a fatal exception ends the program
        return true;
      }
      // Standalone runtime error line (e.g. "- ERROR: …") with no traceback.
      if (text.startsWith('- ERROR')) return true;
      return false;
    }
    simulator.stdout = async (text) => {
      const isError = parseTracebackLine(text);
      appendOut(text, isError ? 'out-error' : undefined);
    };

    /* Shared run/stop, used by both the boot run and the editor's Run button. */
    const runProgram = async (code, { tabKey = null, status = '' } = {}) => {
      if (trace.clear) trace.clear();
      trace.frames = [];
      trace.lastRunKey = tabKey;
      stdoutEl.innerHTML = '';
      appendOut('▶ Running…', 'out-dim');
      statusEl.textContent = 'Running…';
      setRunning(true);
      // simulator.run() tears down the old worker first; drop the screen texture
      // so the render loop never touches a destroyed frame source.
      pauseScreen();
      try {
        await simulator.run(code, userFS.workerFiles());
        applyCanvasToScreen();
        statusEl.textContent = status;
      } catch (err) {
        appendOut('✕ ' + err, 'out-error');
        statusEl.textContent = 'Error';
        setRunning(false);
      }
    };
    const stopProgram = async () => {
      pauseScreen();
      await simulator.stop();
      setRunning(false);
      statusEl.textContent = 'Stopped';
    };

    // Startup program: a `?file=NAME` / `#NAME` URL override deep-links a specific
    // file to run + open in the editor; otherwise the system boot script (which
    // launches the menu). NAME resolves against the user FS first, then the system
    // filesystem (so `?file=blink.py` or `?file=/system/apps/clock/main.py`).
    const qFile = new URLSearchParams(location.search).get('file');
    const hFile = location.hash ? decodeURIComponent(location.hash.slice(1)) : '';
    const override = (qFile || hFile || '').trim();

    let defaultCode = null, startupFile = null, warn = null;
    if (override) {
      const path  = override.startsWith('/') ? override : '/' + override;
      const entry = userFS.get(path);
      if (entry && !entry.binary && !entry.isDir) {
        defaultCode = entry.text;
        startupFile = { path, tabKey: path, system: false };
      } else if (!entry) {
        defaultCode = await fetch(APP_BASE + 'filesystem' + path)
          .then(r => r.ok ? r.text() : null).catch(() => null);
        if (defaultCode != null) startupFile = { path, tabKey: 'sys:' + path, system: true };
      }
      if (defaultCode == null) warn = `⚠ Could not load "${override}" — running the default instead.`;
    }
    if (defaultCode == null) {
      startupFile = null;
      defaultCode = await fetch(APP_BASE + 'filesystem/system/main.py')
        .then(r => r.ok ? r.text() : null)
        .catch(() => null)
        ?? 'badge.mode(HIRES)\n\ndef update():\n    screen.text("Hello!", 10, 10)\n';
    }
    // Run it now, in parallel with Monaco loading — don't await the program itself.
    runProgram(defaultCode, { tabKey: startupFile ? startupFile.tabKey : null });
    if (warn) appendOut(warn, 'out-dim');

    return { stdoutEl, statusEl, rotateView, trace, runProgram, stopProgram, defaultCode, startupFile };
  })();
  return _bootCtx;
}

async function initApp() {
  // Adopt the (already in-flight) simulator boot.
  const { stdoutEl, statusEl, rotateView, trace, runProgram, stopProgram, defaultCode, startupFile } = await bootSimulator();

  configureMonaco(monaco);

  /* ── Editor ────────────────────────────────────────────────────── */
  const editor = monaco.editor.create(document.getElementById('editor'), {
    value:          '# Loading…',
    language:       'python',
    theme:          'badgeware',
    fontSize:       16,
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

  /* ── File / model state (needed early so model functions can reference them) */
  let currentFilePath = null;   // FS path when a user file is active, otherwise null
  let currentReadOnly = false;
  let currentTabKey   = null;   // key into openModels for the active tab
  let transientTabKey = null;   // key of the one transient (preview) tab, if any
  const openModels    = new Map();  // tabKey → { model, dirty, readOnly, transient, label? }
  const openOrder     = [];         // ordered list of open tabKeys

  /* ── File browser (left panel) ─────────────────────────────────────────────
     The panel (trees, context menu, FS ops) lives in filebrowser.js; we own the
     tabs/Monaco models and hand it this host so it never touches them directly. */
  const fb = createFileBrowser({
    userFS,
    getSystemPaths: () => systemPaths,
    activePath:     () => currentFilePath,
    isTextFile:     (p) => FILE_HANDLERS[p.slice(p.lastIndexOf('.')).toLowerCase()]?.kind === 'text',
    openFile: (path, { transient = false, system = false } = {}) =>
      system ? openSysFile(path, transient) : openUserFile(path, transient),
    // Quick experiment: an untitled scratch buffer (no FS entry until "Save as").
    newScratch: () => {
      let name = 'untitled.py';
      for (let n = 1; openModels.has('scratch:' + name); n++) name = `untitled-${n}.py`;
      openScratchTab(name, '');
    },
    onRenamed: (oldPath, newPath) => {
      // Re-point a queued write so unsaved edits follow the file to its new path.
      if (pendingSave && pendingSave.path === oldPath) pendingSave.path = newPath;
      if (!openModels.has(oldPath)) return;
      const info = openModels.get(oldPath);
      openModels.delete(oldPath);
      openOrder.splice(openOrder.indexOf(oldPath), 1, newPath);
      openModels.set(newPath, info);
      if (currentTabKey === oldPath) { currentTabKey = newPath; currentFilePath = newPath; }
      renderTabs();
    },
    onDeleted: (path) => {
      dropPendingSave(path);
      for (const tabKey of [path, 'img:' + path]) {
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
      renderTabs();
    },
  });

  // Bootstrap the editor: a URL deep-link file (opened at the end of init, once the
  // model helpers + FILE_HANDLERS exist) or the default scratch main.py.
  if (!startupFile) openScratchTab('main.py', defaultCode);

  /* ── Runtime error → Monaco markers (wired into the boot's traceback parser) */
  function clearRuntimeMarkers() {
    for (const info of openModels.values()) {
      if (info.model) monaco.editor.setModelMarkers(info.model, 'micropython', []);
    }
  }

  function applyTracebackMarkers(errorMsg, frames, lastRunKey) {
    // Group frames by model (multiple frames can hit the same file)
    const markersByModel = new Map();
    for (const frame of frames) {
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

  trace.clear = clearRuntimeMarkers;
  trace.apply = applyTracebackMarkers;

  /* ── Run / Stop action ─────────────────────────────────────────── */
  const runBtn  = document.getElementById('run-btn');
  const stopBtn = document.getElementById('stop-btn');

  /* ── Auto-save debounce ───────────────────────────────────────────────────
     Coalesce rapid keystrokes into one IndexedDB write per idle gap instead of
     one write per character. Tune AUTOSAVE_DEBOUNCE_MS: higher = fewer writes,
     but more unsaved text at risk if the tab dies mid-edit. */
  const AUTOSAVE_DEBOUNCE_MS = 400;
  let pendingSave = null;     // { path, text } awaiting its timer, or null
  let saveTimer   = null;

  function flushPendingSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (pendingSave) {
      userFS.set(pendingSave.path, { text: pendingSave.text, binary: false });
      pendingSave = null;
    }
  }
  // Discard a queued write for `path` (e.g. the file was just deleted) so the
  // timer can't recreate it after the fact.
  function dropPendingSave(path) {
    if (pendingSave && pendingSave.path === path) {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      pendingSave = null;
    }
  }
  function scheduleSave(path, text) {
    // Switching files mid-debounce: persist the previous file now so a queued
    // write can never land on the wrong path.
    if (pendingSave && pendingSave.path !== path) flushPendingSave();
    pendingSave = { path, text };
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushPendingSave, AUTOSAVE_DEBOUNCE_MS);
  }
  // Don't lose the last debounce window's worth of edits on tab close/reload.
  window.addEventListener('beforeunload', flushPendingSave);

  const runCode = async () => {
    flushPendingSave();   // cancel any queued write; we persist the latest below
    const code = editor.getValue();
    // Auto-save to user FS if a named file is open
    if (currentFilePath && !currentReadOnly) {
      userFS.set(currentFilePath, { text: code, binary: false });
    }
    await runProgram(code, {
      tabKey: currentTabKey,
      status: currentFilePath && !currentReadOnly ? currentFilePath : '',
    });
  };

  const stopCode = stopProgram;

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
    const fsData = await fetch(APP_BASE + 'filesystem.json').then(r => r.json());
    // Manifest shape: { files: { "/path": byteSize } } — we only need the paths here.
    systemPaths = Object.keys(fsData.files || {});
    // Real system paths just arrived — (re)build the system tree.
    fb.refresh({ rebuildSystem: true });
  } catch (_) {}

  /* ── File browser state ────────────────────────────────────────── */
  function setCurrentFile(tabKey, readOnly = false) {
    currentTabKey   = tabKey;
    // User-file keys are bare FS paths starting with '/'; others have a scheme prefix
    currentFilePath = (tabKey && !tabKey.includes(':')) ? tabKey : null;
    currentReadOnly = readOnly;
    editor.updateOptions({ readOnly });
    renderTabs();
    fb.refresh();
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
        ro.className = 'tab-readonly material-icons';
        ro.textContent = 'lock';
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

    fb.refresh();
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
    fb.refresh();
  }

  function saveCurrentFile() {
    if (!currentTabKey) return;
    if (currentReadOnly) return;

    if (!currentTabKey.includes(':')) {
      // User file — flush any debounced edit, then flash confirmation
      flushPendingSave();
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

    fb.refresh();
    renderTabs();
    statusEl.textContent = '✓ Saved ' + path;
    setTimeout(() => { statusEl.textContent = path; }, 1500);
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
        const text  = await fetch(APP_BASE + 'filesystem' + path).then(r => { if (!r.ok) throw new Error(); return r.text(); });
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
        const buf = await fetch(APP_BASE + 'filesystem' + path).then(r => { if (!r.ok) throw new Error(); return r.arrayBuffer(); });
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
      const bytes = entry.binary ? entry.data : new TextEncoder().encode(entry.text);
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
      // User file — auto-save silently (debounced)
      scheduleSave(currentFilePath, editor.getValue());
      info.dirty = false;
    } else if (!currentReadOnly) {
      // Scratch tab — mark dirty so the user knows to save
      if (!info.dirty) { info.dirty = true; renderTabs(); }
    }
  });

  // URL deep-link (?file= / #name): open the requested file now that FILE_HANDLERS
  // and the open helpers exist (calling these at the early bootstrap would TDZ-throw).
  if (startupFile) {
    if (startupFile.system) openSysFile(startupFile.path, false);
    else                    openUserFile(startupFile.path, false);
  }

  /* Initial file tree render */
  fb.refresh();

  initResizeHandlers();

  /* ── Mobile tab switching ──────────────────────────────────────── */
  {
    const mobileNav = document.getElementById('mobile-nav');
    const setMobileTab = (tab) => {
      document.body.dataset.mobileTab = tab;
      mobileNav.querySelectorAll('[data-tab]').forEach(b =>
        b.classList.toggle('active', b.dataset.tab === tab)
      );
      if (tab === 'code') requestAnimationFrame(() => editor.layout());
    };
    setMobileTab('code');
    mobileNav.addEventListener('click', e => {
      const btn = e.target.closest('[data-tab]');
      if (btn) setMobileTab(btn.dataset.tab);
    });
  }

  // No auto-run here: bootSimulator() already started main.py in parallel with
  // Monaco loading. The editor is now wired to that running simulator.
}

// Kick off the simulator boot the moment this script parses — well before the
// Monaco editor bundle finishes downloading. initApp() (run from the Monaco
// require() callback) adopts this same in-flight boot.
bootSimulator();
