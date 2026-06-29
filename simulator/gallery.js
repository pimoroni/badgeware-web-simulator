/* -- Example gallery (its own page, examples.html) --------------------------
   Builds the example cards from examples/manifest.json. Thumbnails and the live
   playback are produced by the simulator itself (see preview.js): each card's
   still is captured + cached on demand (a spinner shows until it lands), and
   clicking/tapping a card plays the example LIVE in its thumbnail using one shared
   canvas. No baked screenshots, so there's no build step to keep in sync. Click is
   the run action (works on touch, unlike a hover preview); Edit hands the example
   off to the main editor via index.html?file=examples/<name> (see examples.js). */
import { createPreviewEngine } from './preview.js';

const APP_BASE = new URL('.', import.meta.url).href;

// Animated SVG spinner, shown centred until a card's still has been captured.
const SPINNER = 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">` +
  `<circle cx="20" cy="20" r="15" fill="none" stroke="rgba(180,190,200,0.18)" stroke-width="4"/>` +
  `<path d="M20 5a15 15 0 0 1 0 30" fill="none" stroke="rgb(224,137,32)" stroke-width="4" stroke-linecap="round">` +
  `<animateTransform attributeName="transform" type="rotate" from="0 20 20" to="360 20 20" dur="0.7s" repeatCount="indefinite"/>` +
  `</path></svg>`);

/* galleryEl is the grid container (examples.js owns the lookup). deps:
   { openExample, setStatus } - openExample(file) navigates to the main editor
   (index.html?file=examples/<file>) to edit/run it there; setStatus(text) writes the
   page's status line (used only for the rare "couldn't load" message). */
export function initGallery(galleryEl, { openExample, setStatus }) {
  const engine = createPreviewEngine();
  let version = 'dev';                 // manifest version, busts the still cache

  // Per-file example source, fetched once and shared by hover preview + still capture.
  const codeCache = new Map();
  function loadCode(file) {
    if (!codeCache.has(file)) {
      codeCache.set(file, fetch(APP_BASE + 'examples/' + file, { cache: 'no-cache' })
        .then((r) => (r.ok ? r.text() : null)).catch(() => null));
    }
    return codeCache.get(file);
  }

  const card = (ex) => `
    <figure class="example" data-file="${ex.file}">
      <button class="example-open" data-act="play" title="Play ${ex.file}">
        <img class="spinner" src="${SPINNER}" alt="" aria-hidden="true">
        <img class="still" alt="">
        <span class="example-play material-symbols-outlined" aria-hidden="true">play_arrow</span>
      </button>
      <div class="example-meta">
        <figcaption><b>${ex.file}</b><span>${ex.description}</span></figcaption>
        <button data-act="edit" title="Edit in the editor">Edit<span class="material-symbols-outlined">edit</span></button>
      </div>
    </figure>`;

  // manifest.categories: [{ name, examples: [...] }] in rough difficulty order.
  async function build() {
    let manifest;
    try { manifest = await fetch(APP_BASE + 'examples/manifest.json', { cache: 'no-cache' }).then((r) => r.json()); }
    catch { galleryEl.innerHTML = '<p class="gallery-empty">Couldn’t load the example list.</p>'; return; }
    version = manifest.version || 'dev';
    galleryEl.innerHTML =
      manifest.categories.map((cat) =>
        `<h3>${cat.name}</h3>` +
        `<div class="gallery-grid">${cat.examples.map(card).join('')}</div>`,
      ).join('');
    wireStills();
    engine.prewarm();
  }
  build();

  function showStill(fig, url) {
    if (!url) return;
    const still = fig.querySelector('.still');
    still.onload = () => fig.classList.add('ready');
    still.src = url;
  }

  // Capture (or cache-load) each card's still the first time it nears the viewport,
  // so we never run all examples at once. requestStill is cache-first, so cards seen
  // on a previous visit fill in instantly; the rest are rendered by the simulator.
  function wireStills() {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const fig = e.target;
        io.unobserve(fig);
        loadCode(fig.dataset.file).then((code) => {
          if (code != null) engine.requestStill(fig.dataset.file, code, version).then((url) => showStill(fig, url));
        });
      }
    }, { root: galleryEl, rootMargin: '200px' });
    galleryEl.querySelectorAll('.example').forEach((fig) => io.observe(fig));
  }

  /* -- Live in-card playback -------------------------------------------------
     Clicking/tapping a card plays the example LIVE in its thumbnail, moving the
     shared preview canvas (preview.js) into it. One card plays at a time; clicking
     another switches. There's no separate simulator, so this IS the run action -
     and unlike a hover preview it works on touch. */
  let playing = null;
  // Stop a playing card once it scrolls out of view: that frees the shared sim to
  // resume capturing the stills below (the engine pauses captures while live) and
  // doesn't leave an offscreen example running.
  const offscreenStop = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.target === playing && !e.isIntersecting) stopPlaying();
  }, { root: galleryEl });
  function stopPlaying() {
    if (!playing) return;
    offscreenStop.unobserve(playing);
    playing.classList.remove('previewing', 'playing');
    playing = null;
    engine.stopLive();
    engine.canvas.remove();
  }
  function playCard(fig) {
    if (fig === playing) return;           // already live
    stopPlaying();
    playing = fig;
    offscreenStop.observe(fig);
    fig.classList.add('playing');          // hides the play badge while it runs
    fig.querySelector('.example-open').appendChild(engine.canvas);
    // Reveal (.previewing) only once the first live frame paints - until then the
    // still shows through, so the shared canvas's stale frame never flashes.
    loadCode(fig.dataset.file).then((code) => {
      if (playing !== fig) return;
      if (code == null) { stopPlaying(); setStatus(`Could not load ${fig.dataset.file}`); return; }
      engine.play(code, () => { if (playing === fig) fig.classList.add('previewing'); });
    });
  }

  // data-act (not data-action) keeps card buttons out of any document-level handler.
  galleryEl.addEventListener('click', (e) => {
    const fig = e.target.closest('.example[data-file]');
    if (!fig) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'edit') { stopPlaying(); openExample(fig.dataset.file); return; }  // -> main editor
    playCard(fig);   // the image / play badge / anywhere else on the card runs it in place
  });

  /* -- Badge input for the playing card --------------------------------------
     Drive the live example like the real badge. The engine ignores all of this
     unless a card is actually playing. */

  // Keyboard (desktop): arrows = D-pad, space = B, escape = Home - the same map the
  // main app's badge uses. preventDefault while playing so the keys don't also
  // scroll the page out from under the example.
  const KEY_TO_BTN = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    ' ': 'select', Escape: 'home',
  };
  window.addEventListener('keydown', (e) => {
    const name = playing ? KEY_TO_BTN[e.key] : null;
    if (name && engine.setButton(name, true)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    const name = playing ? KEY_TO_BTN[e.key] : null;
    if (name && engine.setButton(name, false)) e.preventDefault();
  });

  // Touch (mobile): the playing thumbnail becomes a gamepad, mirroring the main
  // simulator's zoomed-in D-pad - swipe left/right/up/down = A/C/Up/Down, tap = B.
  // Only the playing card's screen captures gestures (touch-action:none in CSS);
  // every other card still scrolls/taps-to-play normally. Mouse uses the keyboard.
  const SWIPE_MIN = 24;        // px; a shorter drag counts as a tap
  let gesture = null;          // { x0, y0, x, y } while a touch is down on the live card
  galleryEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const open = e.target.closest('.example-open');
    if (!open || !playing || !playing.contains(open)) return;
    gesture = { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY };
  });
  galleryEl.addEventListener('pointermove', (e) => { if (gesture) { gesture.x = e.clientX; gesture.y = e.clientY; } });
  function endGesture(allowTap) {
    if (!gesture) return;
    const dx = gesture.x - gesture.x0, dy = gesture.y - gesture.y0;
    gesture = null;
    if (Math.hypot(dx, dy) >= SWIPE_MIN)
      engine.pulseButton(Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down'));
    else if (allowTap)
      engine.pulseButton('select');   // tap = B
  }
  galleryEl.addEventListener('pointerup', () => endGesture(true));
  galleryEl.addEventListener('pointercancel', () => endGesture(false));
}
