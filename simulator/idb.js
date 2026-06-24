/* -- IndexedDB helpers ------------------------------------------------------
   One home for the open/transaction boilerplate the app's small stores share
   (panel sizes, editor session, user FS). Each store is a single object store of
   string-key → structured-clone value, opened at version 1 and created on first
   run. Loaded before fs.js so userFS can borrow the opener. */

// Open (creating on first run) a one-object-store database. Rejects if
// IndexedDB is unavailable or the open fails, so callers can degrade gracefully.
function idbOpen(dbName, storeName) {
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
function idbKv(dbName, storeName) {
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
