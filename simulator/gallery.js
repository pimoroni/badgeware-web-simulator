/* -- Example gallery (home view) --------------------------------------------
   Builds the example cards from examples/manifest.json, lazy-loads each card's
   animated hover clip, and on click runs / edits / opens the example. The
   "Examples" toolbar button that RETURNS to this view is wired in app.js to
   tabs.showGallery — this module only owns the cards and their clicks. */
const APP_BASE = new URL('.', import.meta.url).href;

/* galleryEl is the home-view container (app.js owns the lookup). deps:
   { runProgram, openExample, setStatus } — runProgram(code, opts) from boot;
   openExample(name, code) opens the example as a transient editor tab and returns
   its tab key (app.js wires it to tabs.openScratchTab); setStatus(text) writes the
   shared status line (boot owns it) so we never poke that node directly. */
export function initGallery(galleryEl, { runProgram, openExample, setStatus }) {
  const card = (ex, bust) => {
    const still = ex.screenshot + bust;
    const clip  = (ex.clip || ex.screenshot.replace(/([^/]+)$/, 'anim/$1')) + bust;   // screenshots/<n> → screenshots/anim/<n>
    return `
      <figure class="example" data-file="${ex.file}">
        <button class="example-open" data-act="open" title="Open &amp; run">
          <img class="still" src="${still}" alt="" loading="lazy">
          <img class="anim" data-clip="${clip}" alt="">
        </button>
        <figcaption><b>${ex.file}</b><span>${ex.description}</span></figcaption>
        <div class="example-actions">
          <button data-act="edit">Edit</button>
          <button data-act="run">Run</button>
        </div>
      </figure>`;
  };

  // manifest.categories: [{ name, examples: [...] }] in rough difficulty order.
  // Each category is a header + its own grid; cards keep data-file so the one
  // delegated click/hover handler below still covers them all. Screenshots are
  // name-keyed, so a regenerated clip reuses its URL — ?v=<manifest.version> busts
  // stale browser/CDN copies (bump version whenever the screenshots are redone).
  async function build() {
    let manifest;
    try { manifest = await fetch(APP_BASE + 'examples/manifest.json', { cache: 'no-cache' }).then((r) => r.json()); }
    catch { galleryEl.innerHTML = '<p class="gallery-empty">Couldn’t load the example list.</p>'; return; }
    const bust = manifest.version ? `?v=${manifest.version}` : '';
    galleryEl.innerHTML = manifest.categories.map((cat) =>
      `<h3 class="gallery-category">${cat.name}</h3>` +
      `<div class="gallery-grid">${cat.examples.map((ex) => card(ex, bust)).join('')}</div>`,
    ).join('');
  }
  build();

  // Lazy-load each card's animated clip the first time it's hovered; CSS swaps to
  // it on :hover. (mouseover bubbles, so one delegated listener covers every card.)
  galleryEl.addEventListener('mouseover', (e) => {
    const anim = e.target.closest('.example')?.querySelector('img.anim[data-clip]');
    if (anim) { anim.src = anim.dataset.clip; anim.removeAttribute('data-clip'); }
  });

  // data-act (not data-action) keeps these out of boot's document-level dispatcher —
  // a data-action="run" here would also trigger boot's Run. The shared prelude
  // (fetch the example) then branches, so it's one handler, not a delegate map.
  galleryEl.addEventListener('click', async (e) => {
    const fig = e.target.closest('.example[data-file]');
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!fig || !act) return;
    const file = fig.dataset.file;
    const code = await fetch(APP_BASE + 'examples/' + file, { cache: 'no-cache' }).then((r) => (r.ok ? r.text() : null)).catch(() => null);
    if (code == null) { setStatus(`Could not load ${file}`); return; }
    if (act === 'run') { runProgram(code, { status: file }); return; }   // run only, stay on the gallery
    const key = openExample(file, code);                                 // edit → opens the editor view
    if (act === 'open') runProgram(code, { tabKey: key, status: file }); // image → also run it
  });
}
