import { idbKv } from './util.js';

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
// unavailable, so dragging still works. See simulator/util.js.
const panelSizes = idbKv('badgeware.prefs', 'panel-sizes');
// Collapsed (hidden) state is persisted in the same store under a suffixed key, so a
// panel reopens in the same state next session. (idbOpen is single-store, so we can't
// just add a second store to this DB.)
const collapsedKey = (id) => id + ':collapsed';

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
    if (saved != null) {
      const parent = handle.parentElement;
      const min = dragResolveSize(handle.dataset.dragMin, cfg.axis, parent) ?? 0;
      const max = dragResolveSize(handle.dataset.dragMax, cfg.axis, parent) ?? Infinity;
      cfg.target.style[cfg.axis] = Math.max(min, Math.min(max, saved)) + 'px';
    }
    // Restore the saved open/hidden state (overriding the data-drag-collapsed
    // default that initHandleDecor applied). Instant, so it doesn't slide on load.
    if (cfg.axis === 'width') {
      const wasCollapsed = await panelSizes.get(collapsedKey(handle.dataset.dragTarget));
      if (wasCollapsed != null) setCollapsed(handle, cfg.target, wasCollapsed, { animate: false });
    }
  }
}

/* -- Panel collapse --------------------------------------------------------
   Vertical handles double as a show/hide toggle for their panel. The width is
   driven entirely by CSS: .panel-collapsed forces width:0, .animating supplies
   the slide (added only while toggling, so a plain drag stays instant).
   `animate` is off when restoring saved state on load; `persistKey` (the panel id)
   records the new state so it sticks across sessions. */
function setCollapsed(handle, target, collapsed, { animate = true, persistKey = null } = {}) {
  if (persistKey) panelSizes.set(collapsedKey(persistKey), collapsed);
  if (collapsed === handle.classList.contains('collapsed')) return;
  handle.classList.toggle('collapsed', collapsed);
  if (!animate) { target.classList.toggle('panel-collapsed', collapsed); return; }
  target.classList.add('animating');
  // Flip the width on the next frame so the just-added transition actually runs.
  requestAnimationFrame(() => target.classList.toggle('panel-collapsed', collapsed));
  let timer;
  const done = (e) => {
    if (e && e.propertyName !== 'width') return;   // ignore unrelated transitions
    target.classList.remove('animating');
    target.removeEventListener('transitionend', done);
    clearTimeout(timer);
  };
  target.addEventListener('transitionend', done);
  timer = setTimeout(done, 400);                   // fallback if transitionend never lands
}

// Tag vertical handles with which side their panel is on (for the chevron) and
// apply any data-drag-collapsed default, synchronously on load so panels open in
// the right state with no flash.
function initHandleDecor() {
  for (const handle of document.querySelectorAll('[data-drag-orientation="vertical"]')) {
    const cfg = dragConfig(handle);
    if (!cfg) continue;
    handle.classList.add(cfg.sign === 1 ? 'panel-before' : 'panel-after');
    if (handle.hasAttribute('data-drag-collapsed')) {
      handle.classList.add('collapsed');
      cfg.target.classList.add('panel-collapsed');   // hidden via CSS, no animation
    }
  }
}

export function initResizeHandlers() {
  for (const handle of document.querySelectorAll('[data-drag-target]')) {
    const cfg = dragConfig(handle);
    if (!cfg) continue;
    const { target, axis, coord, sizeProp, sign } = cfg;
    // Force the resize cursor everywhere for the duration of the drag (see app.css).
    const dragClass = axis === 'width' ? 'dragging-col' : 'dragging-row';

    // A press that travels less than this counts as a click (toggle), not a drag.
    const CLICK_SLOP = 4;
    let pointer = null, start = 0, startSize = 0, dragged = false;

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      pointer   = e.pointerId;
      start     = e[coord];
      startSize = target[sizeProp];
      dragged   = false;
      // Capturing the pointer routes every move/up to the handle even as it
      // passes over the editor or canvas — no full-screen overlay needed.
      handle.setPointerCapture(pointer);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (pointer === null) return;
      // Hold off until the press actually travels, so a click doesn't nudge the size.
      if (!dragged) {
        if (Math.abs(e[coord] - start) < CLICK_SLOP) return;
        dragged = true;
        handle.classList.add('dragging');
        document.documentElement.classList.add(dragClass);
      }
      const parent = handle.parentElement;
      const min = dragResolveSize(handle.dataset.dragMin, axis, parent) ?? 0;
      const max = dragResolveSize(handle.dataset.dragMax, axis, parent) ?? Infinity;
      target.style[axis] = Math.max(min, Math.min(max, startSize + sign * (e[coord] - start))) + 'px';
    });
    const end = (e) => {
      if (pointer === null) return;
      pointer = null;   // capture auto-releases on pointerup/cancel
      if (dragged) {
        handle.classList.remove('dragging');
        document.documentElement.classList.remove(dragClass);
        // Don't persist the 0-width of a collapsed panel — keep its open size.
        if (!handle.classList.contains('collapsed')) panelSizes.set(handle.dataset.dragTarget, target[sizeProp]);
      } else if (axis === 'width' && e.type === 'pointerup') {
        // A click (no real drag) on a vertical handle shows/hides its panel.
        setCollapsed(handle, target, !handle.classList.contains('collapsed'), { persistKey: handle.dataset.dragTarget });
      }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
}

// Decorate + restore now (before Monaco loads) so panels open in the right state
// and at their saved size; the drag/toggle wiring is set up later by initApp() via
// initResizeHandlers().
initHandleDecor();
restorePanelSizes();
