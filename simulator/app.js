/* -- badgeware-web editor entry point ---------------------------------------
   The Monaco-dependent half of the app, and the module graph's entry point. The
   simulator + 3D badge boot separately in boot.js (on import); the tab/model
   system lives in tabs.js and the file browser in filebrowser.js. initApp() just
   wires them together — creates the Monaco editor, hands it to createTabs(), and
   connects the file browser, gallery, mobile nav, run provider and keybindings.
   The bottom awaits Monaco (loaded in parallel via the AMD shim in index.html). */
import { userFS, getSystemPaths, setSystemPaths } from './fs.js';
import { bootSimulator } from './boot.js';
import { createFileBrowser } from './filebrowser.js';
import { createTabs } from './tabs.js';
import { createEditor } from './editor.js';
import { initResizeHandlers } from './resize.js';

const APP_BASE = new URL('.', import.meta.url).href;

async function initApp() {
  // Adopt the (already in-flight) simulator boot.
  const { trace, startupFile, run: runCurrent, setRunProvider, notifyRunTarget, setStatus, flashStatus, addActions } = await bootSimulator();
  const mobileNav = document.getElementById('mobile-nav');

  // app.js is the wiring layer: it resolves the DOM by id and injects elements into
  // the leaf modules (which never reach into the document for identity themselves).
  const editorEl  = document.getElementById('editor');

  // Editor instance + its language/theme/completions all live in editor.js.
  const editor = createEditor(editorEl);

  /* -- Mobile tabs ----------------------------------------------------------
     On mobile the panels stack and a top icon bar switches between Gallery /
     Files / Code / Output. selectMobilePanel() flips the visible panel + nav
     highlight; tabs.js calls it (focusTab → 'code', showGallery → 'gallery'), so
     opening a file or example jumps to the Code view. No-ops on desktop. */
  const isMobile = () => matchMedia('(max-width: 767px)').matches;
  function selectMobilePanel(tab) {
    document.body.dataset.mobileTab = tab;
    mobileNav.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'code' && isMobile()) requestAnimationFrame(() => editor.layout());
  }

  // The tab/model system owns all tab state; we hand it the editor-area panes it
  // switches between, plus the editor instance + boot seams (status / run / mobile).
  const tabs = createTabs(
    {
      tabBar:     document.getElementById('tab-bar'),
      editorPane: editorEl,
      imgPreview: document.getElementById('img-preview'),
      help:       document.getElementById('help'),
    },
    { editor, setStatus, flashStatus, notifyRunTarget, selectMobilePanel },
  );

  function setMobileTab(tab) {
    if (tab === 'gallery') { location.href = 'examples.html'; return; }   // gallery is its own page
    if (tab === 'code')    return tabs.focusCodeOrNew();
    selectMobilePanel(tab);   // files / output
  }
  mobileNav.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (btn) setMobileTab(btn.dataset.tab);
  });

  /* -- File browser (left panel) ---------------------------------------------
     The panel (trees, context menu, FS ops) lives in filebrowser.js; tabs.js owns
     the Monaco models/tabs. Both are handed seams so neither touches the other's
     internals; tabs.connect(fb) closes the loop (it needs fb.syncRows/refresh). */
  const fb = createFileBrowser(
    {
      userList:    document.getElementById('fp-user-list'),
      sysTree:     document.getElementById('fp-sys-tree'),
      ctxMenu:     document.getElementById('file-ctx-menu'),
      uploadInput: document.getElementById('fp-upload-input'),
      userHeader:  document.querySelector('#fp-user h2'),
    },
    {
      userFS,
      getSystemPaths,            // imported accessor (fs.js) → current system file list
      activePath: tabs.activePath,
      openPaths:  tabs.openPaths,
      transientPath: tabs.transientPath,
      isTextFile: tabs.isTextFile,
      openFile:   tabs.openFile,
      newScratch: tabs.newScratch,
      onRenamed:  tabs.onRenamed,
      onDeleted:  tabs.onDeleted,
    },
  );
  tabs.connect(fb);

  // Run provider + traceback markers: boot.js calls these into tabs.
  setRunProvider(tabs.getRunRequest);
  trace.clear = tabs.clearMarkers;
  trace.apply = tabs.applyMarkers;

  // Editor keybindings: F5 runs the current content (boot), Ctrl/Cmd+S saves (tabs).
  editor.addAction({
    id:                 'badgeware.run',
    label:              'Run in Simulator',
    keybindings:        [monaco.KeyCode.F5],
    contextMenuGroupId: 'navigation',
    contextMenuOrder:   1,
    run:                runCurrent,
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, tabs.saveCurrentFile);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyN, tabs.newScratch);

  // Toolbar actions handled here. Examples leaves for its own page (examples.html);
  // Help toggles the overlay; Editor focuses the code view.
  addActions({
    gallery: () => { location.href = 'examples.html'; },
    fonts:   () => { location.href = 'fonts.html'; },
    help:    tabs.toggleHelp,
    editor:  tabs.focusCodeOrNew,
  });

  // Commit the home view FIRST: reopen the saved workspace + honour any ?file= /
  // #name deep-link. bootstrap() picks the view itself (a restored tab, or the
  // gallery when there's nothing to restore) and depends only on IndexedDB — no
  // network. Doing it before the system-list fetch below avoids a brief flash of
  // the gallery while that fetch is in flight when the saved state is a tab.
  await tabs.bootstrap(startupFile);

  /* -- Load system file list (populates the System tree) ----------- */
  try {
    const fsData = await fetch(APP_BASE + 'filesystem.json').then(r => r.json());
    // Manifest shape: { files: { "/path": byteSize } } — we only need the paths here.
    setSystemPaths(Object.keys(fsData.files || {}));
    fb.refresh({ rebuildSystem: true });   // real system paths arrived → (re)build the tree
  } catch (_) {}

  fb.refresh();              // initial file tree render
  initResizeHandlers();

  // No auto-run here: bootSimulator() already started main.py in parallel with
  // Monaco loading. The editor is now wired to that running simulator.
}

/* -- Entry point ------------------------------------------------------------
   Wait for Monaco's AMD bundle — index.html loads its loader.js classic (so it
   fetches in parallel with this module graph) and exposes window.monacoReady. The
   simulator already booted on boot.js's import, so the OS runs while Monaco loads. */
await window.monacoReady;
await initApp();
