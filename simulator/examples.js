/* -- Examples page entry point ----------------------------------------------
   The examples gallery on its own page (examples.html): no Monaco, no editor, no
   file browser, and no separate simulator panel. The gallery (gallery.js) plays
   each example LIVE in its own thumbnail via the preview engine (preview.js), so
   this entry is tiny - it just builds the grid and wires the page navigation.

   A card's Edit (or a click on the card itself, which plays it) hands the example
   to the main editor at index.html?file=examples/<file>, where boot.js loads it as
   an editable scratch buffer (see boot.js's startup override). */
import { initGallery } from './gallery.js';

const galleryEl = document.getElementById('gallery');
const statusEl  = document.getElementById('status');

initGallery(galleryEl, {
  openExample: (file) => { location.href = 'index.html?file=examples/' + encodeURIComponent(file); },
  setStatus:   (text) => { if (statusEl) statusEl.textContent = text; },
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
  if (act === 'fonts') { location.href = 'fonts.html'; return; }
  if (act === 'help') { toggleHelp(); return; }
  if (act === 'gallery' || tab === 'gallery') {
    if (helpOn) toggleHelp(false);
    else galleryEl.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

// On mobile the editor page's layout keys off this; the gallery is the only view.
document.body.dataset.mobileTab = 'gallery';
