/* -- Resize handles ----------------------------------------------------------
   One code path for every panel/section resizer. A handle is fully declarative
   via data-attributes — no per-handle JavaScript:

     data-drag-target       id of the element to resize
     data-drag-orientation  "vertical"   → a vertical bar that resizes WIDTH
                            "horizontal" → a horizontal bar that resizes HEIGHT
     data-drag-min          lower clamp  (px, or NNvw / NNvh / NN%)
     data-drag-max          upper clamp  (same units; % is of the handle's parent)

   The grow direction is inferred from DOM order: a target that sits *before* the
   handle grows as you drag right/down; one *after* the handle (a panel on the
   trailing edge) inverts. So no explicit "which side" flag is needed.

   Sizes are persisted to IndexedDB on drag-end and restored on load (desktop
   only — the mobile layout makes panels full-width, where an inline px size
   would fight the responsive CSS). */

// Below this width the mobile layout takes over (matches the CSS @media query).
const MOBILE_MAX = 767;

// Resolve a min/max spec (px | NNvw | NNvh | NN%) to pixels. Live each call.
function dragResolveSize(spec, axis, parent) {
  if (!spec) return null;
  const n = parseFloat(spec);
  if (Number.isNaN(n)) return null;
  if (spec.endsWith('vw')) return window.innerWidth  * n / 100;
  if (spec.endsWith('vh')) return window.innerHeight * n / 100;
  if (spec.endsWith('%'))  return (axis === 'width' ? parent.clientWidth : parent.clientHeight) * n / 100;
  return n;   // plain px
}

// Panel sizes (keyed by target id) live in their own IndexedDB store so a schema
// bump can't collide with userFS. The KV degrades to no-ops if IndexedDB is
// unavailable, so dragging still works. See simulator/idb.js.
const panelSizes = idbKv('badgeware.prefs', 'panel-sizes');

// Per-handle geometry derived from its attributes.
function dragConfig(handle) {
  const target = document.getElementById(handle.dataset.dragTarget);
  if (!target) return null;
  const isWidth = handle.dataset.dragOrientation === 'vertical';   // vertical bar ↔ width
  return {
    target,
    axis:     isWidth ? 'width'  : 'height',
    coord:    isWidth ? 'clientX' : 'clientY',
    sizeProp: isWidth ? 'offsetWidth' : 'offsetHeight',
    // A target before the handle grows in the + direction; one after inverts.
    sign: (handle.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_PRECEDING) ? 1 : -1,
  };
}

// Restore saved sizes as early as possible (called at load, before the editor),
// so panels don't visibly jump. Skipped on mobile, where panels are full-width.
async function restorePanelSizes() {
  if (window.innerWidth <= MOBILE_MAX) return;
  for (const handle of document.querySelectorAll('[data-drag-target]')) {
    const cfg = dragConfig(handle);
    if (!cfg) continue;
    const saved = await panelSizes.get(handle.dataset.dragTarget);
    if (saved == null) continue;
    const parent = handle.parentElement;
    const min = dragResolveSize(handle.dataset.dragMin, cfg.axis, parent) ?? 0;
    const max = dragResolveSize(handle.dataset.dragMax, cfg.axis, parent) ?? Infinity;
    cfg.target.style[cfg.axis] = Math.max(min, Math.min(max, saved)) + 'px';
  }
}

function initResizeHandlers() {
  for (const handle of document.querySelectorAll('[data-drag-target]')) {
    const cfg = dragConfig(handle);
    if (!cfg) continue;
    const { target, axis, coord, sizeProp, sign } = cfg;
    // Force the resize cursor everywhere for the duration of the drag (see app.css).
    const dragClass = axis === 'width' ? 'dragging-col' : 'dragging-row';

    let pointer = null, start = 0, startSize = 0;

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      pointer   = e.pointerId;
      start     = e[coord];
      startSize = target[sizeProp];
      // Capturing the pointer routes every move/up to the handle even as it
      // passes over the editor or canvas — no full-screen overlay needed.
      handle.setPointerCapture(pointer);
      handle.classList.add('dragging');
      document.documentElement.classList.add(dragClass);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (pointer === null) return;
      const parent = handle.parentElement;
      const min = dragResolveSize(handle.dataset.dragMin, axis, parent) ?? 0;
      const max = dragResolveSize(handle.dataset.dragMax, axis, parent) ?? Infinity;
      target.style[axis] = Math.max(min, Math.min(max, startSize + sign * (e[coord] - start))) + 'px';
    });
    const end = () => {
      if (pointer === null) return;
      pointer = null;   // capture auto-releases on pointerup/cancel
      handle.classList.remove('dragging');
      document.documentElement.classList.remove(dragClass);
      panelSizes.set(handle.dataset.dragTarget, target[sizeProp]);   // remember the final size
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
}

// Restore now (before Monaco loads) so panels open at their saved size; the drag
// wiring itself is set up later by initApp() via initResizeHandlers().
restorePanelSizes();
