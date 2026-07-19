/* explorer.js — Badgeware Font Explorer
 *
 * A Google-Fonts-style browser for the .af (vector) and .ppf (pixel) fonts
 * shipped with Badgeware. Loads every font listed in simulator/fonts-manifest.json
 * (the exact files the simulator ships, straight from its filesystem — nothing is
 * vendored), renders a live specimen for each into a <canvas>, and lets you:
 *   - type your own specimen text (updates every card live)
 *   - scale the preview size
 *   - filter by vector / pixel
 *   - open a font for a big specimen, a copy-paste code snippet, and a download.
 */

import { afParse, afRender } from './af.js';
import { ppfParse, ppfRender } from './ppf.js';

const FG = '#f0e8d8';                 // glyph colour (matches badgeware specimens)
const DEFAULT_TEXT = 'The quick brown fox 0123';
// The size control is a whole-number zoom multiplier, not a px size. Pixel fonts
// render at their native pixel size times the multiplier (1x = true pixels, so
// their real sizes are comparable); vector fonts, which have no native size, use
// VECTOR_BASE_PX per 1x. That same px is what the code snippet emits.
const VECTOR_BASE_PX = 20;            // vector font px at 1x

/* All loaded fonts live here: { kind, file, path, name, font, buffer, el, canvas } */
const entries = [];

const state = {
  text: DEFAULT_TEXT,
  scale: 1,           // preview zoom multiplier (1x = native pixels / VECTOR_BASE_PX)
  lores: false,       // badge screen: false = HIRES 320x240, true = LORES 160x120
  filter: 'all',      // 'all' | 'vector' | 'pixel'
};

/* -- DOM handles ---------------------------------------------------------- */
const $ = sel => document.querySelector(sel);
const main       = $('#workspace');
const loadingEl  = $('#loading');
const input      = $('#specimen-input');
const sizeInput  = $('#size-input');
const sizeVal    = $('#size-val');
const filterTabs = $('#filter-tabs');
const resTabs    = $('#res-tabs');

/* Font sources — the same files the simulator ships, loaded straight from the
   emulated filesystem so there's no vendored copy to keep in sync. Vector (.af)
   live under the system assets; pixel (.ppf) live in the ROM. generate_manifest.py
   scans these dirs and writes simulator/fonts-manifest.json. */
const VECTOR_DIR = 'simulator/filesystem/system/assets/fonts/';
const PIXEL_DIR  = 'simulator/filesystem/rom/fonts/';

/* -- Font loading --------------------------------------------------------- */
async function loadAll() {
  const manifest = await (await fetch('simulator/fonts-manifest.json')).json();

  const jobs = [];
  for (const file of manifest.vector) jobs.push(load('vector', VECTOR_DIR + file, file));
  for (const file of manifest.pixel)  jobs.push(load('pixel',  PIXEL_DIR  + file, file));
  await Promise.all(jobs);

  // Keep a stable, friendly order: vector first, then pixel, each alphabetical.
  entries.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : (a.kind === 'vector' ? -1 : 1));
}

async function load(kind, path, file) {
  try {
    const buffer = await (await fetch(path)).arrayBuffer();
    const font   = kind === 'vector' ? afParse(buffer) : ppfParse(buffer);
    const name   = prettyName(kind, file, font);
    entries.push({ kind, file, path, name, font, buffer, el: null, canvas: null });
  } catch (err) {
    console.warn('Skipping', path, err);
  }
}

/* .ppf files carry an embedded name; .af files don't, so derive from filename.
   Pixel-font names end in the cap height (e.g. "Absolute 10") — drop that; the
   size is already conveyed by the cell-size line. */
function prettyName(kind, file, font) {
  if (kind === 'pixel' && font.name) return font.name.replace(/\s+\d+[a-z]?$/i, '');
  return file.replace(/\.(af|ppf)$/i, '').replace(/[-_]/g, ' ');
}

/* -- Specimen rendering --------------------------------------------------- */
/* Draw `text` for one font into a badge-screen canvas — 320x240 (HIRES) or
   160x120 (LORES) — vertically centred, at zoom multiplier `scale`. The canvas
   backing IS the badge resolution; CSS scales it up to the card (pixelated), so
   LORES reads chunkier and HIRES finer, exactly like the real display. Vector
   fonts render at VECTOR_BASE_PX * scale px; pixel fonts at native size * scale
   (snapped to a whole multiplier). Long lines clip at the screen's right edge. */
function drawSpecimen(entry, canvas, text, scale, lores) {
  const W = lores ? 160 : 320;      // badge screen resolution
  const H = lores ? 120 : 240;
  const hpad = lores ? 4 : 8;       // small left margin, in badge pixels
  const ctx = canvas.getContext('2d');
  const t   = text.length ? text : ' ';

  canvas.width  = W;
  canvas.height = H;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);

  if (entry.kind === 'vector') {
    const sizePx = VECTOR_BASE_PX * scale;
    afRender(entry.font, ctx, t, hpad, (H - sizePx) / 2, sizePx, FG);
  } else {
    const gh = entry.font.glyphHeight;
    // The multiplier IS the pixel scale: 1x = true pixels, so native sizes compare.
    const px = Math.max(1, Math.round(scale));
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(px, 0, 0, px, 0, 0);
    ppfRender(entry.font, ctx, t, Math.max(1, Math.round(hpad / px)), Math.round((H / px - gh) / 2), FG);
  }
}

function dimsText(entry) {
  const f = entry.font;
  // Vector: the live rendered px size (tracks the zoom slider), in place of the
  // word "vector". Pixel: just the native pixel height — the width is arbitrary
  // (it varies per glyph), so it's misleading to show.
  return entry.kind === 'vector'
    ? `${Math.round(VECTOR_BASE_PX * state.scale)}px · ${f.glyphCount} glyphs`
    : `${f.glyphHeight}px · ${f.glyphCount} glyphs`;
}

/* -- Gallery -------------------------------------------------------------- */
function buildGallery() {
  loadingEl.remove();

  const vector = entries.filter(e => e.kind === 'vector');
  const pixel  = entries.filter(e => e.kind === 'pixel');

  main.append(
    section('Vector fonts', '.af', vector),
    section('Pixel fonts', '.ppf', pixel),
  );

  refreshSpecimens();
}

function section(title, ext, list) {
  const frag = document.createDocumentFragment();

  const h = document.createElement('h2');
  h.className = 'section-title';
  h.dataset.kind = list[0]?.kind ?? '';
  h.innerHTML = `${title} <span class="count">${ext} · ${list.length}</span>`;
  frag.append(h);

  const grid = document.createElement('div');
  grid.className = 'font-grid';
  grid.dataset.kind = list[0]?.kind ?? '';
  for (const entry of list) grid.append(card(entry));
  frag.append(grid);

  return frag;
}

function card(entry) {
  const el = document.createElement('div');
  el.className = 'font-card';
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `${entry.name} — open details`);

  const specimen = document.createElement('div');
  specimen.className = 'specimen' + (entry.kind === 'pixel' ? ' pixel' : '');
  const canvas = document.createElement('canvas');
  specimen.append(canvas);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `
    <div class="name-block">
      <span class="name">${escapeHtml(entry.name)}</span>
      <span class="dims">${dimsText(entry)}</span>
    </div>
    <span class="badge ${entry.kind}">${entry.kind === 'vector' ? 'Vector' : 'Pixel'}</span>`;

  el.append(specimen, meta);
  el.addEventListener('click', () => openModal(entry));
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openModal(entry); }
  });

  entry.el = el;
  entry.canvas = canvas;
  return el;
}

/* Redraw every visible card's specimen (after a text / size / filter change). */
function refreshSpecimens() {
  for (const entry of entries) {
    if (entry.canvas && entry.el.style.display !== 'none') {
      drawSpecimen(entry, entry.canvas, state.text, state.scale, state.lores);
      const dims = entry.el.querySelector('.dims');   // vector px size tracks the zoom
      if (dims) dims.textContent = dimsText(entry);
    }
  }
}

function applyFilter() {
  for (const entry of entries) {
    const show = state.filter === 'all' || state.filter === entry.kind;
    entry.el.style.display = show ? '' : 'none';
  }
  // Hide section headers/grids that have no visible members.
  for (const grid of document.querySelectorAll('.font-grid')) {
    const kind = grid.dataset.kind;
    const visible = state.filter === 'all' || state.filter === kind;
    grid.style.display = visible ? '' : 'none';
    grid.previousElementSibling.style.display = visible ? '' : 'none';
  }
  refreshSpecimens();
}

/* -- Detail modal --------------------------------------------------------- */
const backdrop = $('#modal-backdrop');

function openModal(entry) {
  $('#modal-name').textContent = entry.name;
  const badge = $('#modal-badge');
  badge.textContent = entry.kind === 'vector' ? 'Vector' : 'Pixel';
  badge.className = 'badge ' + entry.kind;

  $('#modal-dims').innerHTML = modalDims(entry);

  const specimen = $('#modal-specimen');
  specimen.className = entry.kind === 'pixel' ? 'pixel' : '';
  specimen.innerHTML = '';
  const canvas = document.createElement('canvas');
  specimen.append(canvas);
  // Render the modal specimen a touch larger than the card thumbnails.
  drawSpecimen(entry, canvas, state.text.length ? state.text : DEFAULT_TEXT, Math.max(state.scale, 3), state.lores);

  renderSnippet(entry);

  const dl = $('#modal-download');
  dl.onclick = () => downloadFont(entry);

  backdrop.classList.add('open');
  document.body.style.overflow = 'hidden';
  $('#modal-close').focus();
  backdrop.dataset.entry = entry.file;   // for the live specimen refresh

  // Deep-link the open font so the URL is shareable (like Google Fonts).
  if (location.hash !== '#font=' + entry.file) {
    history.replaceState(null, '', '#font=' + encodeURIComponent(entry.file));
  }
}

function modalDims(entry) {
  const f = entry.font;
  const rows = [
    ['Type',   entry.kind === 'vector' ? 'Vector (.af)' : 'Pixel (.ppf)'],
    ['Glyphs', f.glyphCount],
    ['File',   entry.file],
  ];
  if (entry.kind === 'pixel') {
    rows.splice(2, 0, ['Cell size', `${f.cellWidth}×${f.glyphHeight} px`]);
  }
  const kb = (entry.buffer.byteLength / 1024).toFixed(1);
  rows.push(['Size', `${kb} kB`]);
  return rows.map(([k, v]) => `<span><b>${k}:</b> ${escapeHtml(String(v))}</span>`).join('');
}

function closeModal() {
  backdrop.classList.remove('open');
  document.body.style.overflow = '';
  delete backdrop.dataset.entry;
  if (location.hash.startsWith('#font=')) history.replaceState(null, '', location.pathname + location.search);
}

/* Open the font named in the URL hash (#font=<file>), if any. */
function openFromHash() {
  const m = /^#font=(.+)$/.exec(location.hash);
  if (!m) return;
  const entry = entries.find(e => e.file === decodeURIComponent(m[1]));
  if (entry) openModal(entry);
}

/* -- Code snippet --------------------------------------------------------- */
function snippetFor(entry) {
  const name    = entry.file.replace(/\.(af|ppf)$/i, '');   // bare name, no extension
  const sample  = (state.text.length ? state.text : 'Hello, badge!').replace(/"/g, '\\"');
  // Vector fonts take a px size; pixel fonts take an integer scale (both in the
  // same screen.text() argument slot) — matching what the preview shows.
  const sizeArg = entry.kind === 'vector'
    ? `, ${Math.round(VECTOR_BASE_PX * state.scale)}`
    : `, ${Math.max(1, Math.round(state.scale))}`;
  const sizeCmt = entry.kind === 'vector' ? '  # size in px' : '  # pixel scale';
  // Pixel fonts are the built-in ROM set: `font.<name>` loads /rom/fonts/<name>.ppf
  // directly. Vector fonts are assets, loaded by name via font.load(). (A pixel
  // name that isn't a valid identifier falls back to font.load.)
  const isPixel  = entry.kind === 'pixel';
  const useAttr  = isPixel && /^[A-Za-z_]\w*$/.test(name);
  const comment  = isPixel
    ? `# ${name} is a built-in ROM pixel font:`
    : `# Copy the font to /system/assets/fonts on your badge, then:`;
  const loadLine = useAttr ? `my_font = font.${name}` : `my_font = font.load("${name}")`;
  return [
    comment,
    loadLine,
    `screen.font = my_font`,
    `screen.pen = color.white`,
    `screen.text("${sample}", 10, 10${sizeArg})${sizeCmt}`,
  ].join('\n');
}

/* Very small Python-ish highlighter: comments, strings, and font.* calls. */
function highlight(code) {
  return escapeHtml(code)
    .replace(/(#[^\n]*)/g, '<span class="tok-comment">$1</span>')
    .replace(/(&quot;[^&]*&quot;)/g, '<span class="tok-str">$1</span>')
    .replace(/\b(font\.\w+)\b/g, '<span class="tok-fn">$1</span>');
}

function renderSnippet(entry) {
  const code = snippetFor(entry);
  $('#modal-code').innerHTML = highlight(code);
  $('#modal-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(code);
      flashCopied($('#modal-copy'));
    } catch { /* clipboard blocked — no-op */ }
  };
}

function flashCopied(btn) {
  const orig = btn.innerHTML;
  btn.innerHTML = '<span class="material-symbols-outlined">check</span>Copied';
  setTimeout(() => { btn.innerHTML = orig; }, 1400);
}

/* -- Download ------------------------------------------------------------- */
function downloadFont(entry) {
  const blob = new Blob([entry.buffer], { type: 'application/octet-stream' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = entry.file;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* -- Utilities ------------------------------------------------------------ */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let refreshRAF = 0;
function scheduleRefresh() {
  cancelAnimationFrame(refreshRAF);
  refreshRAF = requestAnimationFrame(() => {
    refreshSpecimens();
    // Also keep an open modal in sync with the live text/size.
    if (backdrop.dataset.entry) {
      const entry = entries.find(e => e.file === backdrop.dataset.entry);
      if (entry) {
        const canvas = $('#modal-specimen canvas');
        if (canvas) drawSpecimen(entry, canvas, state.text.length ? state.text : DEFAULT_TEXT, Math.max(state.scale, 3), state.lores);
        renderSnippet(entry);
      }
    }
  });
}

/* -- Wire up controls ----------------------------------------------------- */
function initControls() {
  input.value = state.text;
  input.addEventListener('input', () => { state.text = input.value; scheduleRefresh(); });

  // Float multiplier; show one decimal without trailing-zero / float-noise ("1×",
  // "1.5×"). Pixel fonts snap to a whole multiplier in drawSpecimen; vector fonts
  // (and the code snippet) use the continuous value.
  const fmtScale = (s) => (Math.round(s * 10) / 10) + '×';
  sizeInput.value = state.scale;
  sizeVal.textContent = fmtScale(state.scale);
  sizeInput.addEventListener('input', () => {
    state.scale = +sizeInput.value;
    sizeVal.textContent = fmtScale(state.scale);
    scheduleRefresh();
  });

  // HIRES (320x240) / LORES (160x120) badge-screen toggle.
  resTabs.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.lores = btn.dataset.res === 'lores';
    for (const b of resTabs.children) b.classList.toggle('active', b === btn);
    scheduleRefresh();
  });

  filterTabs.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    for (const b of filterTabs.children) b.classList.toggle('active', b === btn);
    applyFilter();
  });

  $('#modal-close').addEventListener('click', closeModal);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && backdrop.classList.contains('open')) closeModal();
  });
}

/* -- Boot ----------------------------------------------------------------- */
(async function main_() {
  initControls();
  try {
    await loadAll();
    buildGallery();
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
  } catch (err) {
    loadingEl.textContent = 'Could not load fonts: ' + err.message;
    console.error(err);
  }
})();
