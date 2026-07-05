/* -- User filesystem (IndexedDB-backed, synchronous in-memory cache) ---------
   The cache `data` (path → entry) is the source of truth for every read, so the
   public API stays synchronous and existing callers are unchanged. IndexedDB is
   an async durable mirror: each set/del updates the cache immediately and
   enqueues a write on a serialized promise chain (so set/del ordering for a
   given key is preserved). Await `userFS.ready` once at boot before first use,
   so the cache is populated from disk.

   Entry shapes:
     text file    { text: string,     binary: false }
     binary file  { data: Uint8Array, binary: true, mimeType }
     directory    { isDir: true }

   Binary payloads are stored as native Uint8Array — IndexedDB structured-clones
   them directly, so there's no base64 round-trip on read or write. */
import { idbOpen } from './util.js';

const USER_FS_DB    = 'badgeware.userfs';
const USER_FS_STORE = 'files';

export const userFS = (() => {
  let data = {};
  let db   = null;

  // Read every record into the in-memory cache in one cursor pass.
  const loadAll = () => new Promise((resolve, reject) => {
    const out = {};
    const req = db.transaction(USER_FS_STORE, 'readonly').objectStore(USER_FS_STORE).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) { out[cur.key] = cur.value; cur.continue(); }
      else resolve(out);
    };
    req.onerror = () => reject(req.error);
  });

  // Serialize writes so a set followed by a del (or vice versa) hits IndexedDB in
  // call order. Callers fire-and-forget; failures are logged, not surfaced.
  let writeChain = Promise.resolve();
  const enqueue = (work) => {
    writeChain = writeChain.then(work).catch((e) => console.error('userFS write failed', e));
    return writeChain;
  };
  const write = (apply) => enqueue(() => new Promise((resolve, reject) => {
    const tx = db.transaction(USER_FS_STORE, 'readwrite');
    apply(tx.objectStore(USER_FS_STORE));
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  }));

  const ready = (async () => {
    db   = await idbOpen(USER_FS_DB, USER_FS_STORE);   // shared opener (simulator/util.js)
    data = await loadAll();
  })();

  return {
    ready,
    // Re-pull the whole store into the cache. The simulator worker writes user
    // files straight into the same IndexedDB store (see micropython.worker.js);
    // IndexedDB fires no cross-context change events, so the host calls this on the
    // worker's {fsChanged} ping to pick those writes up. Flush our own pending
    // writes first so a concurrent local edit isn't clobbered by a stale re-read.
    reload: async () => { await ready; await writeChain; data = await loadAll(); },
    get:   (p)    => data[p] ?? null,
    set:   (p, v) => { data[p] = v; write((store) => store.put(v, p)); },
    del:   (p)    => { delete data[p]; write((store) => store.delete(p)); },
    paths: ()     => Object.keys(data).sort(),
    /* Entries suitable for postMessage to the worker (binary payloads are bytes) */
    workerFiles: () => Object.entries(data).map(([name, f]) => ({
      name,
      content: f.binary ? f.data : f.text,
    })),
  };
})();

/* -- System file list — populated after fetch('/simulator/filesystem.json') via
   setSystemPaths(). An accessor pair rather than a bare export, since ESM import
   bindings are read-only (the old code reassigned the shared `let` from app.js). */
let _systemPaths = [];
export const getSystemPaths = () => _systemPaths;
export const setSystemPaths = (paths) => { _systemPaths = paths; };
