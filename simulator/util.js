/* -- Generic, zero-dependency primitives ------------------------------------
   Two unrelated-but-tiny helpers the rest of the app builds on: a delegated
   click dispatcher and an IndexedDB key/value store. Kept together because both
   are app-agnostic utilities with no deps of their own. */

// Delegated click dispatch: one listener on `root` routes a click on any
// [data-action] descendant to map[action](el, event). The map is read live at
// click time, so entries added later (e.g. via Object.assign) are picked up.
// Clicks with no data-action — or an action absent from the map — are ignored.
export function delegate(root, map) {
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (el && root.contains(el)) map[el.dataset.action]?.(el, e);
  });
}

// Open (creating on first run) a one-object-store database. Rejects if
// IndexedDB is unavailable or the open fails, so callers can degrade gracefully.
export function idbOpen(dbName, storeName) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(storeName);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// A promise-based key/value view over one object store. The connection opens
// lazily and is cached. Reads resolve to undefined and writes to a no-op if
// IndexedDB is unavailable, so callers never have to guard.
export function idbKv(dbName, storeName) {
  let dbp;
  const db  = () => (dbp ??= idbOpen(dbName, storeName));
  const run = (mode, fn) => db().then((d) => new Promise((resolve, reject) => {
    const tx  = d.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror    = () => reject(tx.error);
  }));
  return {
    get: (key)        => run('readonly',  (s) => s.get(key)).catch(() => undefined),
    set: (key, value) => run('readwrite', (s) => s.put(value, key)).catch(() => {}),
  };
}
