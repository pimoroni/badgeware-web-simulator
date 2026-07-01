/* -- Examples page entry point ----------------------------------------------
   The examples gallery on its own page (examples.html): no Monaco, no editor, no
   file browser, and no separate simulator panel. The gallery (gallery.js) plays
   each example LIVE in its own thumbnail via the preview engine (preview.js), so
   this entry is tiny - it just builds the grid and wires the page navigation.

   A card's Edit (or a click on the card itself, which plays it) hands the example
   to the main editor at index.html?file=examples/<file>, where boot.js loads it as
   an editable scratch buffer (see boot.js's startup override). */
import { initGallery, SPINNER } from './gallery.js';

const APP_BASE  = new URL('.', import.meta.url).href;
const galleryEl = document.getElementById('gallery');
const statusEl  = document.getElementById('status');

// One example card. Keyed by its file; the core reads data-key for still/playback.
const card = (ex) => `
  <figure class="example" data-key="${ex.file}">
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

// Build the grid from examples/manifest.json (categories in rough difficulty order).
async function render(el) {
  let manifest;
  try { manifest = await fetch(APP_BASE + 'examples/manifest.json', { cache: 'no-cache' }).then((r) => r.json()); }
  catch { el.innerHTML = '<p class="gallery-empty">Couldn’t load the example list.</p>'; return null; }
  el.innerHTML = manifest.categories.map((cat) =>
    `<h3 class="section-title">${cat.name} <span class="count">${cat.examples.length}</span></h3>` +
    `<div class="gallery-grid">${cat.examples.map(card).join('')}</div>`,
  ).join('');
  return manifest.version || 'dev';
}

// The card's program is the example's own source (the core caches this per key).
const getCode = (file) =>
  fetch(APP_BASE + 'examples/' + file, { cache: 'no-cache' }).then((r) => (r.ok ? r.text() : null)).catch(() => null);

initGallery(galleryEl, {
  render, getCode,
  onEdit:    (file) => { location.href = 'index.html?file=examples/' + encodeURIComponent(file); },
  setStatus: (text) => { if (statusEl) statusEl.textContent = text; },
});

// Help overlay: the toolbar's ? swaps the gallery for a static help panel (controls
// + links) and back. A plain show/hide since there's no tab system on this page.
const helpEl = document.getElementById('help');
let helpOn = false;
function toggleHelp(on = !helpOn) {
  helpOn = on;
  helpEl.style.display = on ? 'block' : 'none';
  galleryEl.style.display = on ? 'none' : '';   // '' falls back to the .examples-page rule
}

// Page navigation: the toolbar's Editor button and the mobile Editor tab leave for
// the main editor; Examples returns to the (top of the) gallery; Help toggles the
// overlay above.
document.addEventListener('click', (e) => {
  const act = e.target.closest('[data-action]')?.dataset.action;
  const tab = e.target.closest('[data-tab]')?.dataset.tab;
  if (act === 'editor' || tab === 'code') { location.href = 'index.html'; return; }
  if (act === 'apps')  { location.href = 'apps.html'; return; }
  if (act === 'fonts') { location.href = 'fonts.html'; return; }
  if (act === 'help') { toggleHelp(); return; }
  if (act === 'gallery' || tab === 'gallery') {
    if (helpOn) toggleHelp(false);
    else galleryEl.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

// On mobile the editor page's layout keys off this; the gallery is the only view.
document.body.dataset.mobileTab = 'gallery';
