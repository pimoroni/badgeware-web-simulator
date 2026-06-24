/* -- DOM helpers ------------------------------------------------------------
   Shared by the click-command dispatchers (boot.js run/stop/etc. controls,
   filebrowser.js context menu + toolbar). Loaded before both. */

// Delegated click dispatch: one listener on `root` routes a click on any
// [data-action] descendant to map[action](el, event). The map is read live at
// click time, so entries added later (e.g. via Object.assign) are picked up.
// Clicks with no data-action — or an action absent from the map — are ignored.
function delegate(root, map) {
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (el && root.contains(el)) map[el.dataset.action]?.(el, e);
  });
}
