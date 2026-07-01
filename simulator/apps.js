/* -- Apps page entry point --------------------------------------------------
   The apps gallery on its own page (apps.html): the same in-card preview engine
   as the examples gallery, but the cards are on-badge apps rather than single
   example files. Two sections: the built-ins that ship on the badge ("Come with
   your badge", /system/apps) and the vendored community apps ("Contributed by
   users", /system/contrib).

   The list is derived from filesystem.json -- any /system/{apps,contrib}/<slug>/
   icon.png is an app (this naturally skips the launcher menu, which has no icon,
   exactly like the on-badge menu). Each card plays the app LIVE by launching it
   in the shared simulator (`launch("/system/.../<slug>")`, the same call the OS
   uses), and Edit opens the app's source (__init__.py) in the main editor. */
import { initGallery, SPINNER } from './gallery.js';

const APP_BASE  = new URL('.', import.meta.url).href;
const FS_BASE   = APP_BASE + 'filesystem';   // static files under simulator/filesystem
const galleryEl = document.getElementById('gallery');
const statusEl  = document.getElementById('status');

// Section order + titles, keyed by the /system subdirectory they live in.
const SECTIONS = [
  { dir: 'apps',    title: 'Come with your badge' },
  { dir: 'contrib', title: 'Contributed by users' },
];

// Apps to keep out of the gallery. mass_storage is the USB Mass Storage (MSC)
// mode -- it's not a normal app and can't run in the browser simulator.
const EXCLUDE = new Set(['mass_storage']);

// slug -> display name, matching the on-badge menu ("bee_amazed" -> "Bee Amazed").
const prettyName = (slug) =>
  slug.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

const apps = new Map();   // key -> { key, slug, name, path }

// One app card. The launcher icon sits in the meta row beside the name; the
// thumbnail above plays the app live (same machinery as the examples cards).
const card = (a) => `
  <figure class="example app" data-key="${a.key}">
    <button class="example-open" data-act="play" title="Play ${a.name}">
      <img class="spinner" src="${SPINNER}" alt="" aria-hidden="true">
      <img class="still" alt="">
      <span class="example-play material-symbols-outlined" aria-hidden="true">play_arrow</span>
    </button>
    <div class="example-meta">
      <img class="app-icon" src="${FS_BASE}${a.path}/icon.png" alt="" aria-hidden="true">
      <figcaption><b>${a.name}</b></figcaption>
      <button data-act="edit" title="Open in the editor">Edit<span class="material-symbols-outlined">edit</span></button>
    </div>
  </figure>`;

// Build the two sections from filesystem.json. The still-cache version is a cheap
// signature over every app file's size, so editing any app busts its thumbnail.
async function render(el) {
  let fs;
  try { fs = await fetch(APP_BASE + 'filesystem.json', { cache: 'no-cache' }).then((r) => r.json()); }
  catch { el.innerHTML = '<p class="gallery-empty">Couldn’t load the app list.</p>'; return null; }

  const byDir = {};
  let sig = 0;
  for (const [path, size] of Object.entries(fs.files || {})) {
    const dirMatch = path.match(/^\/system\/(apps|contrib)\//);
    if (dirMatch) sig += size;                  // any change under an app dir bumps the version
    const icon = path.match(/^\/system\/(apps|contrib)\/([^/]+)\/icon\.png$/);
    if (!icon) continue;
    const [, dir, slug] = icon;
    if (EXCLUDE.has(slug)) continue;
    const a = { key: `${dir}/${slug}`, slug, name: prettyName(slug), path: `/system/${dir}/${slug}` };
    (byDir[dir] ||= []).push(a);
    apps.set(a.key, a);
  }
  for (const dir of Object.keys(byDir)) byDir[dir].sort((x, y) => x.name.localeCompare(y.name));

  const sections = SECTIONS.filter((s) => byDir[s.dir]?.length);
  if (!sections.length) { el.innerHTML = '<p class="gallery-empty">No apps found.</p>'; return null; }

  el.innerHTML = sections.map((s) =>
    `<h3 class="section-title">${s.title} <span class="count">${byDir[s.dir].length}</span></h3>` +
    `<div class="gallery-grid">${byDir[s.dir].map(card).join('')}</div>`,
  ).join('');
  // The leading scheme tag (v3) lets us bust every cached still at once if the
  // capture logic changes; `sig` busts an individual app when its files change.
  return 'apps-v3-' + sig;
}

// The card's program launches the app the same way the OS does. We first put the
// badge filesystem root on sys.path (exactly what the launcher menu does) so an
// app chdir'd into its own directory can still import the shared driver modules
// that live at '/' (lsm6ds3, breakout_bme280, ...).
const getCode = (key) => {
  const a = apps.get(key);
  return a ? `import sys\nsys.path.insert(0, "/")\nlaunch(${JSON.stringify(a.path)})\n` : null;
};

initGallery(galleryEl, {
  render, getCode,
  // Apps launch() a fresh package each time, which needs a clean VM per run.
  freshWorkerPerRun: true,
  onEdit: (key) => {
    const a = apps.get(key);
    if (a) location.href = 'index.html?file=' + encodeURIComponent(a.path + '/__init__.py');
  },
  setStatus: (text) => { if (statusEl) statusEl.textContent = text; },
});

// Help overlay: the toolbar's ? swaps the gallery for the static help panel.
const helpEl = document.getElementById('help');
let helpOn = false;
function toggleHelp(on = !helpOn) {
  helpOn = on;
  helpEl.style.display = on ? 'block' : 'none';
  galleryEl.style.display = on ? 'none' : '';
}

// Page navigation: Editor + the mobile Editor tab leave for the main editor;
// Examples / Font Explorer go to their pages; Apps returns to the top.
document.addEventListener('click', (e) => {
  const act = e.target.closest('[data-action]')?.dataset.action;
  const tab = e.target.closest('[data-tab]')?.dataset.tab;
  if (act === 'editor' || tab === 'code') { location.href = 'index.html'; return; }
  if (act === 'gallery') { location.href = 'examples.html'; return; }
  if (act === 'fonts') { location.href = 'fonts.html'; return; }
  if (act === 'help') { toggleHelp(); return; }
  if (act === 'apps' || tab === 'apps') {
    if (helpOn) toggleHelp(false);
    else galleryEl.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

// On mobile the shared layout keys off this; the gallery is the only view.
document.body.dataset.mobileTab = 'gallery';
