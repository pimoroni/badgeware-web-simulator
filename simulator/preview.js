/* -- Gallery preview engine -------------------------------------------------
   One reused BadgewareSimulator that backs the whole gallery: it both plays an
   example LIVE into a shared canvas while a card is hovered, and quietly captures
   a still PNG of each example for the card thumbnails. Stills are cached (Cache
   API) keyed by file + manifest version, so the simulator runs each example at
   most once per version per browser - after that the gallery is instant and the
   build-time screenshot step is no longer needed.

   Only one simulator runs here (on top of the main badge), and hover always wins:
   starting a live preview bumps a run token that any in-flight capture watches, so
   a capture mid-flight just bails and re-queues. The worker is kept warm between
   runs (sim.run soft-resets in place), so only the very first run pays WASM spin-up. */
import { BadgewareSimulator } from './badgeware.js';

const STILL_CACHE = 'badge-stills-v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyFor = (file, version) => `/_still/${encodeURIComponent(file)}?v=${version}`;

export function createPreviewEngine() {
  // The single canvas shared by live preview + still capture. The gallery moves it
  // into whichever card is hovered; when detached it still receives capture frames.
  const canvas = document.createElement('canvas');
  canvas.className = 'preview-canvas';
  canvas.width = 320; canvas.height = 240;
  const ctx = canvas.getContext('2d');
  const paint = ({ buffer, width, height }) => {
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    ctx.putImageData(new ImageData(new Uint8ClampedArray(buffer), width, height), 0, 0);
  };

  let sim = null;
  let runToken = 0;        // bumped on every run; a capture bails if it changes under it
  let live = false;        // a card is being hovered (live preview owns the sim)
  let frameHook = null;    // capture's per-frame counter (null during live preview)
  let onLiveFrame = null;  // fired once on the first frame of a live run (reveal hook)
  const queue = [];        // pending captures: { code, resolve }
  let draining = false;

  async function ensureSim() {
    if (sim) return sim;
    sim = await BadgewareSimulator();          // headless: no target, no 3D view
    sim.stdout = async () => {};
    sim.onframe = (f) => {
      paint(f);
      if (frameHook) frameHook();
      // The canvas is shared, so it still shows the previous run's last frame until
      // a new one lands. Reveal a live preview only on its own first frame (gated by
      // onLiveFrame, armed after the run starts) so there's no one-frame stale flash.
      if (onLiveFrame) { const cb = onLiveFrame; onLiveFrame = null; cb(); }
    };
    return sim;
  }

  // Run code in the shared worker (soft-reset in place after the first spawn) and
  // unpause it - headless there's no IntersectionObserver to resume us. Returns the
  // run's token so callers can detect being preempted by a later run.
  async function startRun(code) {
    const s = await ensureSim();
    s.buttons = 0;           // clear any badge buttons held over from a prior run
    const token = ++runToken;
    frameHook = null;
    await s.run(code, []);
    await s.resume();
    return token;
  }

  /* -- Live hover preview --------------------------------------------------- */
  // onReady (optional) fires once the first frame of THIS run has painted - the
  // caller reveals the canvas then, so the stale shared frame never flashes.
  async function play(code, onReady) {
    live = true;             // blocks the capture queue until stopLive()
    onLiveFrame = null;      // disarm any reveal left over from a prior play()
    await startRun(code);    // bumps runToken -> any in-flight capture bails
    onLiveFrame = onReady || null;   // arm now: the next frame belongs to this run
  }
  async function stopLive() {
    live = false;
    if (sim) await sim.stop();   // halt the program, keep the worker warm
    drain();                     // resume still generation
  }

  /* -- Still capture -------------------------------------------------------- */
  // Run an example just long enough to render, then read the canvas. Returns a PNG
  // data URL, or null if a hover preempted us (the job stays queued for later).
  async function capture(code, { minFrames = 6, maxWaitMs = 4000 } = {}) {
    const token = await startRun(code);
    let frames = 0;
    frameHook = () => { frames++; };
    const t0 = performance.now();
    while (runToken === token && frames < minFrames && performance.now() - t0 < maxWaitMs) await sleep(50);
    frameHook = null;
    if (runToken !== token) return null;   // preempted by a live preview
    await sleep(80);                         // let one more frame settle in
    if (runToken !== token) return null;
    return canvas.toDataURL('image/png');
  }

  function enqueueCapture(code) {
    return new Promise((resolve) => { queue.push({ code, resolve }); drain(); });
  }

  async function drain() {
    if (draining || live) return;
    draining = true;
    try {
      while (queue.length && !live) {
        const url = await capture(queue[0].code);
        if (url === null) break;            // preempted -> leave queued, resume after stopLive()
        queue.shift().resolve(url);
      }
    } finally {
      draining = false;
      if (sim && !live && !queue.length) sim.stop();   // go idle, keep the worker warm
    }
  }

  /* -- Still cache (Cache API, falls back to an in-memory map) --------------- */
  const memCache = new Map();
  const cacheOk = typeof caches !== 'undefined';

  async function cachedStill(file, version) {
    const key = keyFor(file, version);
    if (memCache.has(key)) return memCache.get(key);
    if (!cacheOk) return null;
    try {
      const hit = await (await caches.open(STILL_CACHE)).match(key);
      if (!hit) return null;
      const url = URL.createObjectURL(await hit.blob());
      memCache.set(key, url);
      return url;
    } catch { return null; }
  }

  async function storeStill(file, version, dataUrl) {
    const blob = await (await fetch(dataUrl)).blob();
    const url = URL.createObjectURL(blob);
    memCache.set(keyFor(file, version), url);
    if (cacheOk) {
      try { await (await caches.open(STILL_CACHE)).put(keyFor(file, version), new Response(blob)); } catch {}
    }
    return url;
  }

  // Resolve a thumbnail for an example: cache hit -> instant; otherwise queue a
  // capture, cache it, and return a blob URL. null if the example never rendered.
  async function requestStill(file, code, version) {
    const cached = await cachedStill(file, version);
    if (cached) return cached;
    const dataUrl = await enqueueCapture(code);
    if (!dataUrl) return null;
    return storeStill(file, version, dataUrl);
  }

  /* -- Badge button input (only meaningful while a live preview plays) -------
     The host (gallery.js) maps keyboard keys + touch swipes onto these. The wire
     protocol matches the main simulator: a button bitmask posted to the worker as
     simulator.buttons (see badgeware.js / badge3d.js). Names: up/down/left/right/
     select(B)/home. No-ops unless a card is actually playing (live). */
  const buttonMask = (name) => sim && ({
    up:    sim.BUTTON_UP,   down:  sim.BUTTON_DOWN,
    left:  sim.BUTTON_LEFT, right: sim.BUTTON_RIGHT,
    select: sim.BUTTON_SELECT, home: sim.BUTTON_HOME,
  })[name];
  function setButton(name, down) {
    if (!live) return false;
    const mask = buttonMask(name);
    if (!mask) return false;
    if (down) sim.buttons |= mask; else sim.buttons &= ~mask;
    sim.micropython?.postMessage({ buttons: sim.buttons });
    return true;
  }
  // A brief press->release, for discrete swipe/tap gestures (matches badge3d.js).
  function pulseButton(name, ms = 120) {
    if (!setButton(name, true)) return false;
    setTimeout(() => setButton(name, false), ms);
    return true;
  }

  // Build the simulator object early so the first real run only pays worker +
  // WASM spin-up, not object construction. (The worker itself spawns on first run.)
  function prewarm() { ensureSim(); }

  return { canvas, play, stopLive, requestStill, cachedStill, prewarm, setButton, pulseButton };
}
