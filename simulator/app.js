/* -- badgeware-web editor entry point ---------------------------------------
   The Monaco-dependent half of the app. The simulator + 3D badge are booted
   separately in boot.js (kicked off before this bundle loads); initApp() adopts
   that in-flight boot and wires the editor, tabs and file browser to it. */
const APP_BASE = new URL('.', document.currentScript.src).href;

async function initApp() {
  // Adopt the (already in-flight) simulator boot.
  const { trace, startupFile, run: runCurrent, runProgram, setRunProvider, addActions } = await bootSimulator();
  const statusEl   = document.getElementById('status');    // save / read-only messages
  const galleryEl  = document.getElementById('gallery');   // example gallery (home view)
  const tabBarEl   = document.getElementById('tab-bar');   // hidden while the gallery is up

  /* -- Mobile tabs ----------------------------------------------------------
     On mobile the panels stack and a top icon bar switches between Gallery /
     Files / Code / Output. selectMobilePanel() flips the visible panel + nav
     highlight; setMobileTab() (a nav click) also flips the editor's sub-view.
     focusTab() and showGallery() call selectMobilePanel(), so opening a file or
     example automatically jumps to the Code view. No-ops harmlessly on desktop. */
  const mobileNav = document.getElementById('mobile-nav');
  const isMobile  = () => matchMedia('(max-width: 767px)').matches;
  function selectMobilePanel(tab) {
    document.body.dataset.mobileTab = tab;
    mobileNav.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'code' && isMobile()) requestAnimationFrame(() => editor.layout());
  }
  function setMobileTab(tab) {
    if (tab === 'gallery') return showGallery();
    if (tab === 'code') {
      if (currentTabKey)         focusTab(currentTabKey);
      else if (openOrder.length) focusTab(openOrder[openOrder.length - 1]);   // last open file
      else                       newUntitled();   // nothing open → a fresh transient buffer
      return;
    }
    selectMobilePanel(tab);   // files / output
  }
  mobileNav.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (btn) setMobileTab(btn.dataset.tab);
  });

  configureMonaco(monaco);

  /* -- Editor ------------------------------------------------------ */
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

  /* -- File / model state (needed early so model functions can reference them) */
  let currentFilePath = null;   // FS path when a user file is active, otherwise null
  let currentReadOnly = false;
  let currentTabKey   = null;   // key into openModels for the active tab
  let transientTabKey = null;   // key of the one transient (preview) tab, if any
  const openModels    = new Map();  // tabKey → { model, dirty, readOnly, transient, label? }
  const openOrder     = [];         // ordered list of open tabKeys

  /* -- File browser (left panel) ---------------------------------------------
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
  if (!startupFile) showGallery();   // home view is the example gallery (the OS runs on the badge regardless)

  /* -- Runtime error → Monaco markers (wired into the boot's traceback parser) */
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

  /* -- Auto-save debounce ---------------------------------------------------
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

  // Tell the simulator how to fetch the current code to run: flush any pending
  // autosave, persist the active file, and hand back code + tab + status. The
  // boot.js command dispatch (Run button) and the F5 action below both use it.
  setRunProvider(() => {
    if (!currentTabKey) return null;   // gallery / no active tab — nothing to run
    flushPendingSave();   // cancel any queued write; we persist the latest below
    const code = editor.getValue();
    if (currentFilePath && !currentReadOnly) {
      userFS.set(currentFilePath, { text: code, binary: false });
    }
    return {
      code,
      tabKey: currentTabKey,
      status: currentFilePath && !currentReadOnly ? currentFilePath : '',
    };
  });

  // F5 keybinding inside the editor — runs the current editor content.
  editor.addAction({
    id:                   'badgeware.run',
    label:                'Run in Simulator',
    keybindings:          [monaco.KeyCode.F5],
    contextMenuGroupId:   'navigation',
    contextMenuOrder:     1,
    run:                  runCurrent,
  });

  // Ctrl/Cmd+S — explicit save
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveCurrentFile);

  /* -- Example gallery (home view) -----------------------------------------
     Built from examples/manifest.json. The card image opens the example as a
     transient, editable tab AND runs it; Edit / Run do one or the other. The
     toolbar "Examples" button returns here. */
  function showGallery() {
    document.getElementById('editor').style.display = 'none';
    document.getElementById('img-preview').style.display = 'none';
    tabBarEl.style.display = 'none';     // no open-file tabs while browsing examples
    galleryEl.style.display = 'block';   // '' would fall back to the CSS display:none
    currentTabKey = null; currentFilePath = null; currentReadOnly = false;
    renderTabs();      // clear the active-tab highlight
    fb.markActive();
    selectMobilePanel('gallery');
  }
  addActions({ gallery: showGallery });   // wire the toolbar "Examples" button

  async function buildGallery() {
    let manifest;
    try { manifest = await fetch(APP_BASE + 'examples/manifest.json').then((r) => r.json()); }
    catch { galleryEl.innerHTML = '<p class="gallery-empty">Couldn’t load the example list.</p>'; return; }
    galleryEl.innerHTML = '<div class="gallery-grid">' + manifest.examples.map((ex) => {
      const clip = ex.clip || ex.screenshot.replace(/([^/]+)$/, 'anim/$1');   // screenshots/<n> → screenshots/anim/<n>
      return `
      <figure class="example" data-file="${ex.file}">
        <button class="example-open" data-act="open" title="Open &amp; run">
          <img class="still" src="${ex.screenshot}" alt="" loading="lazy">
          <img class="anim" data-clip="${clip}" alt="">
        </button>
        <figcaption><b>${ex.file}</b><span>${ex.description}</span></figcaption>
        <div class="example-actions">
          <button data-act="edit">Edit</button>
          <button data-act="run">Run</button>
        </div>
      </figure>`;
    }).join('') + '</div>';
  }
  buildGallery();

  // Lazy-load each card's animated clip the first time it's hovered; CSS swaps to
  // it on :hover. (mouseover bubbles, so one delegated listener covers every card.)
  galleryEl.addEventListener('mouseover', (e) => {
    const anim = e.target.closest('.example')?.querySelector('img.anim[data-clip]');
    if (anim) { anim.src = anim.dataset.clip; anim.removeAttribute('data-clip'); }
  });

  galleryEl.addEventListener('click', async (e) => {
    const fig = e.target.closest('.example[data-file]');
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!fig || !act) return;
    const file = fig.dataset.file;
    const code = await fetch(APP_BASE + 'examples/' + file).then((r) => (r.ok ? r.text() : null)).catch(() => null);
    if (code == null) { statusEl.textContent = `Could not load ${file}`; return; }
    if (act === 'run') { runProgram(code, { status: file }); return; }   // run only, stay on the gallery
    const key = openScratchTab(file, code, { transient: true });          // edit → opens the editor view
    if (act === 'open') runProgram(code, { tabKey: key, status: file });  // image → also run it
  });

  /* -- Load system file list --------------------------------------- */
  try {
    const fsData = await fetch(APP_BASE + 'filesystem.json').then(r => r.json());
    // Manifest shape: { files: { "/path": byteSize } } — we only need the paths here.
    systemPaths = Object.keys(fsData.files || {});
    // Real system paths just arrived — (re)build the system tree.
    fb.refresh({ rebuildSystem: true });
  } catch (_) {}

  /* -- File browser state ------------------------------------------ */
  function setCurrentFile(tabKey, readOnly = false) {
    currentTabKey   = tabKey;
    // User-file keys are bare FS paths starting with '/'; others have a scheme prefix
    currentFilePath = (tabKey && !tabKey.includes(':')) ? tabKey : null;
    currentReadOnly = readOnly;
    editor.updateOptions({ readOnly });
    renderTabs();
    fb.refresh();
  }

  /* -- Tab / model management -------------------------------------- */
  function langForPath(p) {
    return p.endsWith('.py') ? 'python' : p.endsWith('.json') ? 'json' : 'plaintext';
  }

  // Pretty-print a file's text for the editor. JSON gets 2-space indentation (the
  // standard JSON.parse → JSON.stringify round-trip); invalid JSON is shown as-is.
  function formatForPreview(path, text) {
    if (!path.toLowerCase().endsWith('.json')) return text;
    try { return JSON.stringify(JSON.parse(text), null, 2); }
    catch { return text; }
  }

  function tabLabel(key) {
    const info = openModels.get(key);
    if (info?.label) return info.label;
    return key.includes(':') ? key.split(':').pop().split('/').pop() : key.split('/').pop();
  }

  function renderTabs() {
    const bar = document.getElementById('tab-bar');
    if (!bar) return;
    // <nav id="tab-bar"> ➜ <ul> ➜ <li> per open file. Structure carries meaning:
    // first <span> = name, .material-icons <span> = read-only lock, <button> = close.
    const list = document.createElement('ul');
    for (const key of openOrder) {
      const info = openModels.get(key);
      if (!info) continue;

      const tab = document.createElement('li');
      // Dynamic state only — structure is tag-based (see app.css).
      const state = [];
      if (key === currentTabKey) state.push('active');
      if (info.dirty)            state.push('dirty');
      if (info.transient)        state.push('transient');
      tab.className = state.join(' ');
      tab.title = key;

      const name = document.createElement('span');
      name.textContent = tabLabel(key);
      tab.appendChild(name);

      if (info.readOnly) {
        const ro = document.createElement('span');
        ro.className = 'material-icons';   // icon font; identifies the lock glyph
        ro.textContent = 'lock';
        tab.appendChild(ro);
      }

      const x = document.createElement('button');
      x.textContent = '✕';
      x.title = 'Close';
      x.addEventListener('click', ev => { ev.stopPropagation(); closeTab(key); });
      tab.appendChild(x);

      tab.addEventListener('click',    () => focusTab(key));
      tab.addEventListener('dblclick', () => promoteTab(key));
      list.appendChild(tab);
    }
    bar.replaceChildren(list);
  }

  function focusTab(key) {
    const info = openModels.get(key);
    if (!info) return;
    currentTabKey   = key;
    currentFilePath = key.includes(':') ? null : key;
    currentReadOnly = info.readOnly;

    const editorEl  = document.getElementById('editor');
    const imgEl     = document.getElementById('img-preview');
    galleryEl.style.display = 'none';   // focusing a tab leaves the gallery
    tabBarEl.style.display  = '';       // restore the tab bar

    if (info.imgUrl) {
      editorEl.style.display  = 'none';
      imgEl.style.display     = 'flex';
      const imgTag = imgEl.querySelector('img');
      imgTag.src = info.imgUrl;
      imgEl.querySelector('span').textContent = tabLabel(key);
      dimsEl = imgEl.querySelector('small');
      if (info.dimText) {
        dimsEl.textContent = info.dimText;
      } else {
        dimsEl.textContent = '';
        imgTag.onload = () => {
          dimsEl.textContent = imgTag.naturalWidth + ' × ' + imgTag.naturalHeight + ' px';
        };
      }
    } else {
      editorEl.style.display  = '';
      imgEl.style.display     = 'none';
      editor.setModel(info.model);
      editor.updateOptions({ readOnly: info.readOnly });
    }

    fb.markActive();   // highlight only — don't rebuild the tree (would break dblclick)
    renderTabs();
    selectMobilePanel('code');   // on mobile, focusing a tab jumps to the Code view
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

  function openScratchTab(name, content, { transient = false } = {}) {
    const key = 'scratch:' + name;
    if (openModels.has(key)) { focusTab(key); return key; }
    if (transient) evictTransient(key);
    const uri   = monaco.Uri.parse('badgeware:///scratch/' + encodeURIComponent(name));
    const model = monaco.editor.createModel(content, langForPath(name), uri);
    openModels.set(key, { model, dirty: false, readOnly: false, transient, label: name });
    openOrder.push(key);
    if (transient) transientTabKey = key;
    focusTab(key);   // sets editor/model/currentTabKey, hides the gallery, renders
    return key;
  }

  // A fresh transient "untitled.py" scratch (name de-duped against open scratches).
  // The default when the Code tab is opened with nothing else to show.
  function newUntitled() {
    let name = 'untitled.py';
    for (let n = 1; openModels.has('scratch:' + name); n++) name = `untitled-${n}.py`;
    openScratchTab(name, '', { transient: true });
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

    // Replace the scratch tab with a real user-file tab. We can't reuse the scratch
    // model — its URI is badgeware:///scratch/<name>, which is immutable and would
    // collide when a new scratch later takes the same name ("model already exists").
    // So open the saved path freshly (a model under the user:// URI, or focus it if
    // already open), then dispose the scratch model + tab, freeing the scratch URI.
    const prevKey = currentTabKey;
    const info    = openModels.get(prevKey);

    openUserFile(path, false);   // creates the user-file model + tab and focuses it

    if (transientTabKey === prevKey) transientTabKey = null;
    openModels.delete(prevKey);
    const idx = openOrder.indexOf(prevKey);
    if (idx !== -1) openOrder.splice(idx, 1);
    if (info?.model) info.model.dispose();

    fb.refresh();
    renderTabs();
    statusEl.textContent = '✓ Saved ' + path;
    setTimeout(() => { statusEl.textContent = path; }, 1500);
  }

  /* -- File helpers ------------------------------------------------ */
  /* -- File-type dispatch table ------------------------------------ */
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
      if (openModels.get(key).transient && (!transient || currentTabKey === key)) promoteTab(key);
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
        if (openModels.get(key).transient && (!transient || currentTabKey === key)) promoteTab(key);
        focusTab(key);
        statusEl.textContent = path + ' — read-only';
        return;
      }
      if (transient) evictTransient(key);
      try {
        const text  = await fetch(APP_BASE + 'filesystem' + path).then(r => { if (!r.ok) throw new Error(); return r.text(); });
        const uri   = monaco.Uri.parse('badgeware:///sys' + encodeURIComponent(path));
        const model = monaco.editor.createModel(formatForPreview(path, text), langForPath(path), uri);
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
      // Promote a transient preview to a permanent tab on an explicit open
      // (dblclick / Enter), OR on a re-click of the file that's already the
      // current preview. The re-click rule is an INTENTIONAL choice, not just a
      // dblclick fallback: a second click commits with no timing/distance
      // constraint, which is far more accessible than a true double-click (and
      // mirrors the keyboard model: Space previews, Enter commits). See TODO.md
      // for the rationale + trade-off — please don't "fix" it back to strict
      // dblclick.
      if (openModels.get(path).transient && (!transient || currentTabKey === path)) promoteTab(path);
      focusTab(path);
      return;
    }
    if (transient) evictTransient(path);
    const uri   = monaco.Uri.parse('badgeware:///user' + encodeURIComponent(path));
    const model = monaco.editor.createModel(formatForPreview(path, entry.text), langForPath(path), uri);
    openModels.set(path, { model, dirty: false, readOnly: false, transient });
    openOrder.push(path);
    if (transient) transientTabKey = path;
    focusTab(path);
  }

  /* -- Auto-save / dirty tracking --------------------------------- */
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

  // No auto-run here: bootSimulator() already started main.py in parallel with
  // Monaco loading. The editor is now wired to that running simulator.
}
