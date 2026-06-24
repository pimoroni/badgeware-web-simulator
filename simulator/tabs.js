/* -- Tab & model management -------------------------------------------------
   The editor's tab system: the tab-record model, Monaco models, the open / close
   / focus lifecycle, file-type dispatch (text vs image/preview), session
   persistence, autosave, and traceback markers. `createTabs(deps)` owns all tab
   state and returns the operations app.js and the file browser drive — mirroring
   filebrowser.js's createFileBrowser(host) seam.

   A tab is a record in openModels, keyed by an opaque string id:
     { source: 'user'|'sys'|'scratch',  // where its content lives
       view:   'editor'|'image',        // which pane renders it
       path,                            // FS path (null for scratch)
       name,                            // display label
       model,                           // Monaco model (null for image tabs)
       imgUrl, dimText,                 // image tabs only
       dirty, transient }
   `source` and `view` are orthogonal (binary-vs-text is a rendering concern;
   user/sys/scratch is a source concern). Read-only-ness is derived, not stored. */
import { userFS } from './fs.js';
import { idbKv } from './util.js';
import { ppfParse, ppfPreview } from './ppf.js';
import { afParse, afPreview } from './af.js';

const APP_BASE = new URL('.', import.meta.url).href;

// The editor session (which tabs are open + which is active) persists in its own
// IndexedDB store, isolated from userFS and the panel-size prefs. One fixed key
// holds the whole snapshot. See simulator/util.js.
const sessionStore = (() => {
  const kv = idbKv('badgeware.session', 'state');
  return { load: () => kv.get('editor'), save: (value) => kv.set('editor', value) };
})();

/* panes: the editor-area elements tabs switches between (app.js owns the lookups) —
   { tabBar, gallery, editorPane, imgPreview }. deps: { editor, setStatus, flashStatus,
   notifyRunTarget, selectMobilePanel } — things tabs can't import or query itself
   (setStatus/flashStatus write boot's status line). The file browser is wired in
   later via connect(), since tabs and the browser are mutually dependent. */
export function createTabs(panes, { editor, setStatus, flashStatus, notifyRunTarget, selectMobilePanel }) {
  let fb = null;   // file browser, late-bound (syncRows / refresh); see connect()

  let currentTabKey   = null;   // id of the active tab, or null when the gallery is up
  let transientTabKey = null;   // id of the one transient (preview) tab, if any
  const openModels    = new Map();  // id → tab record (see file header)
  const openOrder     = [];         // ordered list of ids

  /* -- Tab helpers ----------------------------------------------------------- */
  const baseName   = (p) => p.slice(p.lastIndexOf('/') + 1);
  const activeTab  = () => (currentTabKey ? openModels.get(currentTabKey) ?? null : null);
  // File-tree decoration sources (the file browser pulls these in syncRows). Only
  // file-backed tabs have a path; scratch buffers don't and aren't represented.
  const openPaths     = () => new Set([...openModels.values()].filter((t) => t.path).map((t) => t.path));
  const transientPath = () => (transientTabKey ? openModels.get(transientTabKey)?.path ?? null : null);
  // Read-only = system files and image previews; editable = user text files + scratch.
  const isReadOnly = (t) => t.source === 'sys' || t.view === 'image';
  // The opaque id for a record. The string scheme is unchanged (so Monaco URIs and
  // traceback-marker matching keep working) — it just lives in ONE place.
  const binPrefix  = (path) => FILE_HANDLERS[path.slice(path.lastIndexOf('.')).toLowerCase()]?.keyPrefix ?? 'img';
  function tabKey({ source, view, path, name }) {
    if (source === 'scratch') return 'scratch:' + name;
    const sys = source === 'sys' ? 'sys:' : '';
    return view === 'image' ? binPrefix(path) + ':' + sys + path : sys + path;
  }
  // Single owner of the editor-area view switch: 'gallery' | 'editor' | 'image'.
  function applyView(view) {
    panes.editorPane.style.display = view === 'editor' ? '' : 'none';
    panes.imgPreview.style.display = view === 'image'  ? 'flex' : 'none';
    panes.gallery.style.display    = view === 'gallery' ? 'block' : 'none';
    panes.tabBar.style.display     = view === 'gallery' ? 'none'  : '';
  }

  const langForPath = (p) => (p.endsWith('.py') ? 'python' : p.endsWith('.json') ? 'json' : 'plaintext');

  // Pretty-print a file's text for the editor. JSON gets 2-space indentation (the
  // standard JSON.parse → JSON.stringify round-trip); invalid JSON is shown as-is.
  function formatForPreview(path, text) {
    if (!path.toLowerCase().endsWith('.json')) return text;
    try { return JSON.stringify(JSON.parse(text), null, 2); }
    catch { return text; }
  }
  const normalisePath = (raw) => { const p = raw.trim(); return p.startsWith('/') ? p : '/' + p; };
  const tabLabel = (key) => openModels.get(key)?.name ?? key;

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

  /* -- Session persistence (open tabs + active tab → IndexedDB) ---------------
     User/system files are recorded by path — their content is reproducible from
     userFS / the server; only scratch buffers carry their text, since that lives
     solely in the Monaco model. Writes are debounced and suppressed while
     restoring so the restore can't overwrite the very state it's reading. */
  const SESSION_SAVE_MS = 400;   // debounce before persisting a tab change — tune here
  let restoring    = true;       // stays true through bootstrap() (then flipped off)
  let sessionTimer = null;

  function serializeTab(key) {
    const t = openModels.get(key);
    if (!t) return null;
    if (t.source === 'scratch') {
      return { source: 'scratch', name: t.name, content: t.model ? t.model.getValue() : '', transient: !!t.transient };
    }
    return { source: t.source, path: t.path, transient: !!t.transient };
  }
  const snapshotSession = () => ({ tabs: openOrder.map(serializeTab).filter(Boolean), active: currentTabKey });
  function saveSession() {
    if (restoring) return;
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => sessionStore.save(snapshotSession()), SESSION_SAVE_MS);
  }
  async function restoreSession() {
    const saved = await sessionStore.load();
    if (!saved || !Array.isArray(saved.tabs) || saved.tabs.length === 0) return null;
    for (const t of saved.tabs) {
      if      (t.source === 'scratch') openScratchTab(t.name, t.content || '', { transient: t.transient });
      else if (t.source === 'sys')     await openSysFile(t.path, t.transient);
      else                             openUserFile(t.path, t.transient);   // skips silently if the file is gone
    }
    return saved;   // { tabs, active } — bootstrap() restores the active view
  }

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

  /* -- Runtime error → Monaco markers (wired into the boot traceback parser) */
  function clearRuntimeMarkers() {
    for (const info of openModels.values()) {
      if (info.model) monaco.editor.setModelMarkers(info.model, 'micropython', []);
    }
  }
  function applyTracebackMarkers(errorMsg, frames, lastRunKey) {
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

  /* -- Tab rendering + lifecycle -------------------------------------------- */
  // renderTabs() is pure (no persistence). saveSession() lives at the tab-state
  // mutation sites — focusTab/showGallery/close/promote/rename/delete/etc. — so
  // it's tied to changes, not to re-renders.
  function renderTabs() {
    const bar = panes.tabBar;
    if (!bar) return;
    // <nav id="tab-bar"> ➜ <ul> ➜ <li> per open file. Structure carries meaning:
    // first <span> = name, .material-symbols-outlined <span> = read-only lock, <button> = close.
    const list = document.createElement('ul');
    for (const key of openOrder) {
      const t = openModels.get(key);
      if (!t) continue;

      const tab = document.createElement('li');
      const state = [];   // dynamic state only — structure is tag-based (see app.css)
      if (key === currentTabKey) state.push('active');
      if (t.dirty)               state.push('dirty');
      if (t.transient)           state.push('transient');
      tab.className = state.join(' ');
      tab.title = key;

      const name = document.createElement('span');
      name.textContent = t.name;
      tab.appendChild(name);

      if (isReadOnly(t)) {
        const ro = document.createElement('span');
        ro.className = 'material-symbols-outlined';   // icon font; identifies the lock glyph
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
    fb?.syncRows();   // project active/open/transient onto the file tree (cheap toggles)
  }

  function focusTab(key) {
    const t = openModels.get(key);
    if (!t) return;
    currentTabKey = key;
    applyView(t.view);   // 'editor' or 'image' — owns the gallery/tab-bar/pane toggles

    if (t.view === 'image') {
      const imgEl  = panes.imgPreview;
      const imgTag = imgEl.querySelector('img');
      imgTag.src = t.imgUrl;
      imgEl.querySelector('span').textContent = t.name;
      const dimsEl = imgEl.querySelector('small');
      if (t.dimText) {
        dimsEl.textContent = t.dimText;
      } else {
        dimsEl.textContent = '';
        imgTag.onload = () => {
          dimsEl.textContent = imgTag.naturalWidth + ' × ' + imgTag.naturalHeight + ' px';
        };
      }
    } else {
      editor.setModel(t.model);
      editor.updateOptions({ readOnly: isReadOnly(t) });
    }

    renderTabs();                // also syncs the file-tree row decorations (fb.syncRows)
    saveSession();               // active tab changed (also covers every open*, which ends here)
    notifyRunTarget(key);        // Run targets this tab now → reload-vs-play icon
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
    saveSession();   // tab removed (the active-tab paths above also save via focusTab)
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
    saveSession();   // transient flag is persisted
  }

  function openScratchTab(name, content, { transient = false } = {}) {
    const key = tabKey({ source: 'scratch', name });
    if (openModels.has(key)) { focusTab(key); return key; }
    if (transient) evictTransient(key);
    const uri   = monaco.Uri.parse('badgeware:///scratch/' + encodeURIComponent(name));
    const model = monaco.editor.createModel(content, langForPath(name), uri);
    openModels.set(key, { source: 'scratch', view: 'editor', path: null, name, model, dirty: false, transient });
    openOrder.push(key);
    if (transient) transientTabKey = key;
    focusTab(key);   // sets editor/model/currentTabKey, hides the gallery, renders
    return key;
  }

  // A fresh transient "untitled.py" scratch (name de-duped against open scratches).
  // The default when the mobile Code tab is opened with nothing else to show.
  function newUntitled() {
    let name = 'untitled.py';
    for (let n = 1; openModels.has('scratch:' + name); n++) name = `untitled-${n}.py`;
    openScratchTab(name, '', { transient: true });
  }

  // A permanent untitled scratch (the file browser's "New file" button).
  function newScratch() {
    let name = 'untitled.py';
    for (let n = 1; openModels.has('scratch:' + name); n++) name = `untitled-${n}.py`;
    openScratchTab(name, '');
  }

  function saveCurrentFile() {
    const active = activeTab();
    if (!active || isReadOnly(active)) return;

    if (active.source === 'user') {
      // User file — flush any debounced edit, then flash confirmation
      flushPendingSave();
      flashStatus('✓ Saved ' + active.name, 1400);
      return;
    }

    // Scratch tab — prompt for name to save as user file
    const suggested = active.name;
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

    fb?.refresh();
    renderTabs();
    saveSession();   // scratch tab replaced by a user-file tab
    setStatus(path);                      // the new resting status is the saved file's path
    flashStatus('✓ Saved ' + path);       // …flashed over by the save confirmation
  }

  function openBinaryTab({ source, path }, buf, handler, transient, mimeOverride) {
    const key = tabKey({ source, view: 'image', path });
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
      openModels.set(key, { source, view: 'image', path, name: baseName(path), model: null, imgUrl, dimText, dirty: false, transient });
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
      const key = tabKey({ source: 'sys', view: 'editor', path });
      if (openModels.has(key)) {
        if (openModels.get(key).transient && (!transient || currentTabKey === key)) promoteTab(key);
        focusTab(key);
        setStatus(path + ' — read-only');
        return;
      }
      if (transient) evictTransient(key);
      try {
        const text  = await fetch(APP_BASE + 'filesystem' + path).then(r => { if (!r.ok) throw new Error(); return r.text(); });
        const uri   = monaco.Uri.parse('badgeware:///sys' + encodeURIComponent(path));
        const model = monaco.editor.createModel(formatForPreview(path, text), langForPath(path), uri);
        openModels.set(key, { source: 'sys', view: 'editor', path, name: baseName(path), model, dirty: false, transient });
        openOrder.push(key);
        if (transient) transientTabKey = key;
      } catch (_) { return; }
      focusTab(key);
    } else {
      try {
        const buf = await fetch(APP_BASE + 'filesystem' + path).then(r => { if (!r.ok) throw new Error(); return r.arrayBuffer(); });
        openBinaryTab({ source: 'sys', path }, buf, handler, transient);
      } catch (_) {}
    }
    setStatus(path + ' — read-only');
  }

  function openUserFile(path, transient = false) {
    const entry = userFS.get(path);
    if (!entry || entry.isDir) return;
    const ext     = path.slice(path.lastIndexOf('.')).toLowerCase();
    const handler = FILE_HANDLERS[ext];
    if (!handler) return;

    if (handler.kind !== 'text') {
      const bytes = entry.binary ? entry.data : new TextEncoder().encode(entry.text);
      openBinaryTab({ source: 'user', path }, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), handler, transient, entry.mimeType);
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
    // A user text file is keyed by its bare path (=== tabKey for this record).
    openModels.set(path, { source: 'user', view: 'editor', path, name: baseName(path), model, dirty: false, transient });
    openOrder.push(path);
    if (transient) transientTabKey = path;
    focusTab(path);
  }

  /* -- Gallery (home) view ------------------------------------------------- */
  function showGallery() {
    applyView('gallery');
    currentTabKey = null;
    renderTabs();      // clears the active highlight + syncs row decorations (fb.syncRows)
    saveSession();     // active view changed (→ gallery)
    notifyRunTarget(null);   // Run would launch the OS now (no active tab)
    selectMobilePanel('gallery');
  }

  /* -- File-browser host callbacks ----------------------------------------- */
  function onRenamed(oldPath, newPath) {
    // Re-point a queued write so unsaved edits follow the file to its new path.
    if (pendingSave && pendingSave.path === oldPath) pendingSave.path = newPath;
    if (!openModels.has(oldPath)) return;   // only user text tabs are keyed by bare path
    const t = openModels.get(oldPath);
    openModels.delete(oldPath);
    openOrder.splice(openOrder.indexOf(oldPath), 1, newPath);
    t.path = newPath; t.name = baseName(newPath);   // keep the record in step with its new path
    openModels.set(newPath, t);
    if (currentTabKey === oldPath) currentTabKey = newPath;
    renderTabs();
    saveSession();   // tab path/name changed
  }
  function onDeleted(path) {
    dropPendingSave(path);
    // A deleted file may be open as a text tab and/or an image/preview tab.
    for (const k of [tabKey({ source: 'user', view: 'editor', path }),
                     tabKey({ source: 'user', view: 'image',  path })]) {
      if (!openModels.has(k)) continue;
      if (currentTabKey === k) {
        openModels.get(k).dirty = false;
        closeTab(k);
      } else {
        const m = openModels.get(k);
        if (m.imgUrl) URL.revokeObjectURL(m.imgUrl);
        else if (m.model) m.model.dispose();
        openModels.delete(k);
        openOrder.splice(openOrder.indexOf(k), 1);
      }
    }
    renderTabs();
    saveSession();   // tab(s) removed
  }

  /* -- Run provider: hand the simulator the current code to run ------------ */
  // Flush any pending autosave, persist the active user file, return code + tab +
  // status (null when there's nothing to run, e.g. the gallery). Side-effecting,
  // so it's NOT used for the passive Run-icon state (see notifyRunTarget).
  function getRunRequest() {
    const t = activeTab();
    if (!t) return null;
    flushPendingSave();
    const code = editor.getValue();
    const isUserText = t.source === 'user' && t.view === 'editor';
    if (isUserText) userFS.set(t.path, { text: code, binary: false });
    return { code, tabKey: currentTabKey, status: isUserText ? t.path : '' };
  }

  // Mobile "Code" tab: focus the active tab, else the last open, else a fresh one.
  function focusCodeOrNew() {
    if (currentTabKey)         focusTab(currentTabKey);
    else if (openOrder.length) focusTab(openOrder[openOrder.length - 1]);
    else                       newUntitled();
  }

  /* -- Bootstrap: reopen the saved workspace + honour any deep-link --------- */
  async function bootstrap(startupFile) {
    const restored = await restoreSession();
    if (startupFile) {
      // Explicit ?file= / #name wins the active view, layered over the restored tabs.
      if (startupFile.system) await openSysFile(startupFile.path, false);
      else                    openUserFile(startupFile.path, false);
    } else if (restored && restored.active && openModels.has(restored.active)) {
      focusTab(restored.active);   // restore the previously-active tab
    } else {
      // Nothing saved, or the gallery was the active view, or the saved active tab
      // is gone. (Reopening tabs above focuses the last one, so reassert the gallery.)
      showGallery();
    }
    restoring = false;   // bootstrap done — interactions persist from here
    saveSession();       // capture the initial state (e.g. a fresh deep-link tab)
  }

  /* -- Editor reactions + lifecycle listeners ------------------------------ */
  editor.onDidChangeModelContent(() => {
    const t = activeTab();
    if (!t) return;
    // Editing a transient tab promotes it permanently
    if (t.transient) {
      t.transient = false;
      if (transientTabKey === currentTabKey) transientTabKey = null;
      renderTabs();
      saveSession();   // transient flag is persisted
    }
    if (t.source === 'user' && t.view === 'editor') {
      scheduleSave(t.path, editor.getValue());   // user file → autosave (debounced)
      t.dirty = false;
    } else if (t.source === 'scratch') {
      if (!t.dirty) { t.dirty = true; renderTabs(); }   // mark dirty so the user knows to save
      saveSession();   // scratch text lives only in the model — persist each edit
    }
  });
  // Don't lose the last debounce window of edits / tab state on tab close/reload.
  window.addEventListener('beforeunload', flushPendingSave);
  addEventListener('pagehide', () => { clearTimeout(sessionTimer); if (!restoring) sessionStore.save(snapshotSession()); });

  return {
    // File-browser host callbacks (app.js passes these to createFileBrowser):
    // The active file's path (any source/view), or null for scratch/gallery — so the
    // highlight composes with open/transient on whichever tree the file lives in.
    activePath: () => activeTab()?.path ?? null,
    openPaths, transientPath,
    isTextFile: (p) => FILE_HANDLERS[p.slice(p.lastIndexOf('.')).toLowerCase()]?.kind === 'text',
    openFile:   (path, { transient = false, system = false } = {}) => (system ? openSysFile(path, transient) : openUserFile(path, transient)),
    newScratch, onRenamed, onDeleted,
    // Late-bind the file browser (syncRows / refresh) once it exists.
    connect: (filebrowser) => { fb = filebrowser; },
    // App-facing operations:
    showGallery, openScratchTab, saveCurrentFile, focusCodeOrNew, bootstrap,
    getRunRequest, clearMarkers: clearRuntimeMarkers, applyMarkers: applyTracebackMarkers,
  };
}
