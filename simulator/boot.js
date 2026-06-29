/* -- Simulator boot & controls ----------------------------------------------
   The Monaco-independent half of the app. It spins up the worker-backed
   simulator + 3D badge, owns stdout/traceback rendering and run/stop state, and
   wires the toolbar command buttons (run / stop / spin / clear). It's kicked off
   the moment this script parses — well before the Monaco editor bundle finishes
   downloading — so main.py is already running by the time the editor is built.

   app.js (the editor half) adopts the same in-flight boot via bootSimulator()
   and hands back a single seam, setRunProvider(): a callback describing how to
   fetch the current editor content to run. Everything else here is self-
   contained. */
import { BadgewareSimulator } from './badgeware.js';
import { initBadge3D } from './badge3d.js';
import { userFS } from './fs.js';
import { delegate } from './util.js';

const BOOT_BASE = new URL('.', import.meta.url).href;

/* Resolves to a shared context the editor wires itself into. Idempotent. */
let _bootCtx = null;
export function bootSimulator() {
  if (_bootCtx) return _bootCtx;
  _bootCtx = (async () => {
    await userFS.ready;   // populate the in-memory FS cache before any read below
    const stdoutEl    = document.querySelector('#stdout > div');   // the scrolling log inside the view
    const statusEl    = document.getElementById('status');
    const badge3dWrap = document.getElementById('badge-3d-wrap');  // the 3D badge's container (injected into badge3d)
    const runIcons = document.querySelectorAll('[data-action="run"] .material-symbols-outlined');   // play ↔ reload glyph

    // The status line is boot's surface, and setStatus is its ONLY writer — so the
    // run-state messages below and the transient "flash" messages from other modules
    // (tabs: saved / read-only; gallery: load errors) can't clobber each other. A
    // pending flash-restore is cancelled by any later write, so it can never land on
    // top of a newer message (e.g. a save toast settling over a "Running…").
    let flashTimer = null;
    const setStatus   = (text) => { clearTimeout(flashTimer); statusEl.textContent = text; };
    const flashStatus = (text, ms = 1500) => {
      const prev = statusEl.textContent;
      setStatus(text);
      flashTimer = setTimeout(() => { statusEl.textContent = prev; }, ms);
    };

    const appendOut = (text, cls) => {
      const span = document.createElement('span');
      span.textContent = text + '\n';
      if (cls) span.className = cls;
      stdoutEl.appendChild(span);
      stdoutEl.scrollTop = stdoutEl.scrollHeight;
    };

    const simulator = await BadgewareSimulator();
    const { applyCanvasToScreen, pauseScreen, rotateView } = initBadge3D(simulator, appendOut, badge3dWrap);

    // The badge canvas spills down to overlap the OUTPUT title bar. CSS can't read
    // a sibling's height, so mirror #stdout h2's measured height into --badge-spill
    // (the margin reads it; see #badge-3d-wrap in app.css). A ResizeObserver keeps
    // it exact across font swaps, the clear-icon size, and breakpoint changes — so
    // the overlap is never a hand-tuned magic number again.
    const outputTitle = document.querySelector('#stdout h2');
    if (outputTitle && 'ResizeObserver' in window) {
      const syncBadgeSpill = () => badge3dWrap.style.setProperty('--badge-spill', outputTitle.offsetHeight + 'px');
      new ResizeObserver(syncBadgeSpill).observe(outputTitle);
      syncBadgeSpill();
    }

    /* Run / Stop state (the Stop button is meaningful only while running). */
    let isRunning  = false;
    let runningKey = null;   // tabKey of the running program (null = OS / no tab)
    let runTarget  = null;   // tabKey the Run button would launch now; app keeps it current
    // Run shows a reload glyph only when it would re-launch what's already running.
    // Switch the active tab to something else and it falls back to a fresh play.
    const syncRunIcon = () => {
      const reload = isRunning && runTarget === runningKey;
      runIcons.forEach((i) => {
        i.textContent = reload ? 'refresh' : 'play_arrow';
        i.closest('[data-action="run"]')?.classList.toggle('reloading', reload);
      });
    };
    const setRunning = (running) => {
      isRunning = running;
      // Queried live (not cached): the gallery adds its own [data-action="stop"]
      // after boot, and it needs to track run-state like the toolbar/mobile ones.
      document.querySelectorAll('[data-action="stop"]').forEach((b) => { b.disabled = !running; });
      syncRunIcon();
    };
    const onSimulatorStopped = () => {
      if (!isRunning) return;
      setRunning(false);
      setStatus('Stopped (error)');
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

    /* Shared run/stop, used by the boot run and the toolbar's Run/Stop. */
    const runProgram = async (code, { tabKey = null, status = '' } = {}) => {
      if (trace.clear) trace.clear();
      trace.frames = [];
      trace.lastRunKey = tabKey;
      runningKey = tabKey;   // what's now running, for the Run-vs-Reload icon
      stdoutEl.innerHTML = '';
      appendOut('▶ Running…', 'out-dim');
      setStatus('Running…');
      setRunning(true);
      // simulator.run() tears down the old worker first; drop the screen texture
      // so the render loop never touches a destroyed frame source.
      pauseScreen();
      try {
        await simulator.run(code, userFS.workerFiles());
        applyCanvasToScreen();
        setStatus(status);
      } catch (err) {
        appendOut('✕ ' + err, 'out-error');
        setStatus('Error');
        setRunning(false);
      }
    };
    const stopProgram = async () => {
      pauseScreen();
      await simulator.stop();
      setRunning(false);
      setStatus('Stopped');
    };

    /* (Re)launch the badge OS (the menu). Fetched fresh rather than reusing
       defaultCode, which may be a deep-linked file when ?file= is set. */
    const runOS = async () => {
      const code = await fetch(BOOT_BASE + 'filesystem/system/main.py')
        .then(r => r.ok ? r.text() : null).catch(() => null);
      if (code != null) await runProgram(code, { status: 'badgeOS' });
      else appendOut('✕ Could not load badgeOS', 'out-error');
    };

    /* The editor supplies how to fetch the current code to run (flush + save +
       return { code, tabKey, status }); null when there's nothing to run (gallery
       view, or before Monaco is ready). In that case Run (re)launches the OS — so
       the button is never a dead no-op, and a crashed OS is always recoverable
       (notably on mobile, where there's no separate badgeOS button). */
    let runProvider = null;
    const run = async () => {
      const req = runProvider && runProvider();
      if (req) await runProgram(req.code, { tabKey: req.tabKey, status: req.status });
      else     await runOS();
    };

    /* -- Command dispatch ------------------------------------------------------
       Buttons carry data-action; delegate() routes them via this map. Document-
       level is safe: these action names are disjoint from the file browser's
       (open/rename/delete/…), and unknown actions are ignored — so file-browser
       clicks fall through untouched. Going broad lets the run/stop controls live
       wherever they need to (toolbar, side panel, the floating mobile bar). Spins
       are 180° steps. app.js extends this map via addActions() (e.g. "gallery"). */
    const actions = {
      run,
      stop:        stopProgram,
      'run-os':    runOS,
      'spin-prev': () => rotateView(-1),
      'spin-next': () => rotateView(+1),
      clear:       () => { stdoutEl.innerHTML = ''; },
    };
    delegate(document, actions);   // shared dispatcher — see simulator/util.js

    // Startup program: a `?file=NAME` / `#NAME` URL override deep-links a specific
    // file to run + open in the editor; otherwise the system boot script (which
    // launches the menu). `examples/<name>` loads a gallery example (examples.html
    // links here) as an editable scratch buffer; anything else resolves against the
    // user FS first, then the system filesystem (so `?file=blink.py` or
    // `?file=/system/apps/clock/main.py`).
    const qFile = new URLSearchParams(location.search).get('file');
    const hFile = location.hash ? decodeURIComponent(location.hash.slice(1)) : '';
    const override = (qFile || hFile || '').trim();

    let defaultCode = null, startupFile = null, warn = null;
    if (override) {
      const exMatch = override.match(/^\/?examples\/(.+)$/);
      if (exMatch) {
        // A gallery example — not a real FS file, so it opens as a scratch tab.
        const name = exMatch[1];
        defaultCode = await fetch(BOOT_BASE + 'examples/' + name)
          .then(r => r.ok ? r.text() : null).catch(() => null);
        if (defaultCode != null) startupFile = { scratch: true, name, code: defaultCode, tabKey: 'scratch:' + name };
      } else {
        const path  = override.startsWith('/') ? override : '/' + override;
        const entry = userFS.get(path);
        if (entry && !entry.binary && !entry.isDir) {
          defaultCode = entry.text;
          startupFile = { path, tabKey: path, system: false };
        } else if (!entry) {
          defaultCode = await fetch(BOOT_BASE + 'filesystem' + path)
            .then(r => r.ok ? r.text() : null).catch(() => null);
          if (defaultCode != null) startupFile = { path, tabKey: 'sys:' + path, system: true };
        }
      }
      if (defaultCode == null) warn = `⚠ Could not load "${override}" — running the default instead.`;
    }
    if (defaultCode == null) {
      startupFile = null;
      defaultCode = await fetch(BOOT_BASE + 'filesystem/system/main.py')
        .then(r => r.ok ? r.text() : null)
        .catch(() => null)
        ?? 'badge.mode(HIRES)\n\ndef update():\n    screen.text("Hello!", 10, 10)\n';
    }
    // Run it now, in parallel with Monaco loading — don't await the program itself.
    runProgram(defaultCode, { tabKey: startupFile ? startupFile.tabKey : null });
    if (warn) appendOut(warn, 'out-dim');

    // The editor half consumes these: trace markers, the startup file to open,
    // run() for the F5 keybinding, and setRunProvider() to supply current code.
    return {
      trace,
      defaultCode,
      startupFile,
      run,
      runProgram,   // run arbitrary code (the gallery uses this to run an example)
      setRunProvider: (fn) => { runProvider = fn; },
      // The editor tells us which tab Run would target now (null = gallery/OS), so
      // the Run icon can show reload-vs-play. Side-effect-free, unlike runProvider.
      notifyRunTarget: (key) => { runTarget = key ?? null; syncRunIcon(); },
      // The status line is boot's surface (it owns the run-state messages). Other
      // modules with transient messages write through these rather than reaching for
      // the node: setStatus(text) sets it; flashStatus(text, ms) shows a message then
      // restores whatever was there (tabs: saved/read-only; gallery: load errors).
      setStatus, flashStatus,
      // Let the editor half register extra data-action commands (e.g. "gallery").
      addActions: (extra) => Object.assign(actions, extra),
    };
  })();
  return _bootCtx;
}

// Kick off the simulator boot the moment this script parses — well before the
// Monaco editor bundle finishes downloading. app.js's initApp() adopts this
// same in-flight boot.
bootSimulator();
