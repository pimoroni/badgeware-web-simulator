/* -- Example gallery (home view) --------------------------------------------
   Builds the example cards from examples/manifest.json. Thumbnails and hover
   animations are produced by the simulator itself (see preview.js): each card's
   still is captured + cached on demand (a spinner shows until it lands), and
   hovering a card plays the example LIVE in a shared canvas. No baked screenshots,
   so there's no build step to keep in sync. The "Examples" toolbar button that
   RETURNS to this view is wired in app.js to tabs.showGallery. */
import { createPreviewEngine } from './preview.js';

const APP_BASE = new URL('.', import.meta.url).href;

// Animated SVG spinner, shown centred until a card's still has been captured.
const SPINNER = 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">` +
  `<circle cx="20" cy="20" r="15" fill="none" stroke="rgba(180,190,200,0.18)" stroke-width="4"/>` +
  `<path d="M20 5a15 15 0 0 1 0 30" fill="none" stroke="rgb(224,137,32)" stroke-width="4" stroke-linecap="round">` +
  `<animateTransform attributeName="transform" type="rotate" from="0 20 20" to="360 20 20" dur="0.7s" repeatCount="indefinite"/>` +
  `</path></svg>`);

/* galleryEl is the home-view container (app.js owns the lookup). deps:
   { runProgram, openExample, setStatus } - runProgram(code, opts) from boot;
   openExample(name, code) opens the example as a transient editor tab and returns
   its tab key (app.js wires it to tabs.openScratchTab); setStatus(text) writes the
   shared status line (boot owns it) so we never poke that node directly. */
export function initGallery(galleryEl, { runProgram, openExample, setStatus }) {
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
      <button class="example-open" data-act="open" title="Open &amp; run">
        <img class="spinner" src="${SPINNER}" alt="" aria-hidden="true">
        <img class="still" alt="">
      </button>
      <figcaption><b>${ex.file}</b><span>${ex.description}</span></figcaption>
      <div class="example-actions">
        <button data-act="edit">Edit</button>
        <button data-act="run">Run<span class="material-symbols-outlined">play_arrow</span></button>
      </div>
    </figure>`;

  // manifest.categories: [{ name, examples: [...] }] in rough difficulty order.
  async function build() {
    let manifest;
    try { manifest = await fetch(APP_BASE + 'examples/manifest.json', { cache: 'no-cache' }).then((r) => r.json()); }
    catch { galleryEl.innerHTML = '<p class="gallery-empty">Couldn’t load the example list.</p>'; return; }
    version = manifest.version || 'dev';
    // A floating Stop (data-action="stop", so boot's document-level dispatcher and
    // its run-state sync both pick it up) pinned to the gallery's top-right. The
    // sticky wrapper is zero-height so it never displaces the grid. Hidden on mobile.
    galleryEl.innerHTML =
      `<div class="gallery-controls"><button class="gallery-stop" data-action="stop" title="Stop" aria-label="Stop"><span class="material-symbols-outlined">stop</span></button></div>` +
      manifest.categories.map((cat) =>
        `<h3 class="gallery-category">${cat.name}</h3>` +
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

  /* -- Live hover preview ----------------------------------------------------
     Move the shared preview canvas into the hovered card and play the example;
     leave on mouseout (or when a click navigates away). One delegated pair of
     listeners covers every card. */
  let hovered = null;
  function leaveHover() {
    if (!hovered) return;
    hovered.classList.remove('previewing');
    hovered = null;
    engine.stopLive();
    engine.canvas.remove();
  }
  galleryEl.addEventListener('mouseover', (e) => {
    const fig = e.target.closest('.example');
    if (!fig || fig === hovered) return;
    leaveHover();
    hovered = fig;
    fig.querySelector('.example-open').appendChild(engine.canvas);
    // Reveal (.previewing) only once the first live frame paints - until then the
    // still shows through, so the shared canvas's stale frame never flashes.
    loadCode(fig.dataset.file).then((code) => {
      if (code != null && hovered === fig) engine.play(code, () => { if (hovered === fig) fig.classList.add('previewing'); });
    });
  });
  galleryEl.addEventListener('mouseout', (e) => {
    const fig = e.target.closest('.example');
    if (fig && fig === hovered && !fig.contains(e.relatedTarget)) leaveHover();
  });

  // data-act (not data-action) keeps these out of boot's document-level dispatcher.
  galleryEl.addEventListener('click', async (e) => {
    const fig = e.target.closest('.example[data-file]');
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!fig || !act) return;
    leaveHover();                          // navigating away: free the preview sim
    const file = fig.dataset.file;
    const code = await loadCode(file);
    if (code == null) { setStatus(`Could not load ${file}`); return; }
    if (act === 'run') { runProgram(code, { status: file }); return; }   // run only, stay on the gallery
    const key = openExample(file, code);                                 // edit -> opens the editor view
    if (act === 'open') runProgram(code, { tabKey: key, status: file }); // image -> also run it
  });
}
