/* -- In-card preview gallery (shared core) ---------------------------------
   Powers both the examples gallery (examples.html) and the apps gallery
   (apps.html). It captures a still thumbnail for each card and plays the program
   LIVE in that thumbnail using one shared canvas (see preview.js), with the
   keyboard + touch acting as the badge. Click is the run action (works on touch,
   unlike a hover preview); Edit hands the item off to the main editor.

   The host page supplies what differs between the two galleries:
   - render(galleryEl): populate the grid with sections + `.example[data-key]`
     cards (each carrying .spinner / .still / .example-play and data-act
     play/edit buttons). Returns a `version` string that busts the still cache,
     or null after writing its own error message.
   - getCode(key): the program to run for a card, as a string (or a Promise of
     one; null skips it). Examples fetch a source file; apps synthesise launch().
   - onEdit(key): hand the item off (both navigate to the editor).
   - setStatus(text): surface the rare "couldn't load" message.

   Cards are keyed by data-key, which is opaque to the core. */
import { createPreviewEngine } from './preview.js';

// Animated SVG spinner, shown centred until a card's still has been captured.
// Exported so each host's card markup can drop it in.
export const SPINNER = 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">` +
  `<circle cx="20" cy="20" r="15" fill="none" stroke="rgba(180,190,200,0.18)" stroke-width="4"/>` +
  `<path d="M20 5a15 15 0 0 1 0 30" fill="none" stroke="rgb(224,137,32)" stroke-width="4" stroke-linecap="round">` +
  `<animateTransform attributeName="transform" type="rotate" from="0 20 20" to="360 20 20" dur="0.7s" repeatCount="indefinite"/>` +
  `</path></svg>`);

export function initGallery(galleryEl, { render, getCode, onEdit, setStatus, freshWorkerPerRun = false }) {
  const engine = createPreviewEngine({ freshWorkerPerRun });
  let version = 'dev';                 // stills cache version, busts on content change

  // Per-card program, resolved once and shared by the live preview + still capture.
  const codeCache = new Map();
  function loadCode(key) {
    if (!codeCache.has(key)) codeCache.set(key, Promise.resolve().then(() => getCode(key)));
    return codeCache.get(key);
  }

  async function build() {
    const v = await render(galleryEl);
    if (v == null) return;             // render wrote its own error message
    version = v;
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
  // so we never run everything at once. requestStill is cache-first, so cards seen
  // on a previous visit fill in instantly; the rest are rendered by the simulator.
  function wireStills() {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const fig = e.target;
        io.unobserve(fig);
        loadCode(fig.dataset.key).then((code) => {
          if (code != null) engine.requestStill(fig.dataset.key, code, version).then((url) => showStill(fig, url));
        });
      }
    }, { root: galleryEl, rootMargin: '200px' });
    galleryEl.querySelectorAll('.example').forEach((fig) => io.observe(fig));
  }

  /* -- Live in-card playback -------------------------------------------------
     Clicking/tapping a card plays it LIVE in its thumbnail, moving the shared
     preview canvas (preview.js) into it. One card plays at a time; clicking
     another switches. There's no separate simulator, so this IS the run action -
     and unlike a hover preview it works on touch. */
  let playing = null;
  // Stop a playing card once it scrolls out of view: frees the shared sim to resume
  // capturing the stills below and doesn't leave an offscreen program running.
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
    loadCode(fig.dataset.key).then((code) => {
      if (playing !== fig) return;
      if (code == null) { stopPlaying(); setStatus(`Could not load ${fig.dataset.key}`); return; }
      engine.play(code, () => { if (playing === fig) fig.classList.add('previewing'); });
    });
  }

  // data-act (not data-action) keeps card buttons out of any document-level handler.
  galleryEl.addEventListener('click', (e) => {
    const fig = e.target.closest('.example[data-key]');
    if (!fig) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'edit') { stopPlaying(); onEdit(fig.dataset.key); return; }  // -> main editor
    playCard(fig);   // the image / play badge / anywhere else on the card runs it in place
  });

  /* -- Badge input for the playing card --------------------------------------
     Drive the live program like the real badge. The engine ignores all of this
     unless a card is actually playing. */

  // Keyboard (desktop): arrows = D-pad, space = B, escape = Home - the same map the
  // main app's badge uses. preventDefault while playing so the keys don't also
  // scroll the page out from under the card.
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
