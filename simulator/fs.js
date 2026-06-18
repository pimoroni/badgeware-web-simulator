/* ── Base64 helpers ──────────────────────────────────────────────────────── */
function b64ToBytes(b64) {
  const s = atob(b64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}
function bytesToB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/* ── User filesystem (localStorage) ─────────────────────────────────────── */
const USER_FS_KEY = 'badgeware.userfs.v1';

const userFS = (() => {
  let data = {};
  try { data = JSON.parse(localStorage.getItem(USER_FS_KEY) || '{}'); } catch {}
  const persist = () => localStorage.setItem(USER_FS_KEY, JSON.stringify(data));
  return {
    get:   (p)    => data[p] ?? null,
    set:   (p, v) => { data[p] = v; persist(); },
    del:   (p)    => { delete data[p]; persist(); },
    paths: ()     => Object.keys(data).sort(),
    /* Entries suitable for postMessage to the worker */
    workerFiles: () => Object.entries(data).map(([name, f]) => ({
      name,
      content: f.binary ? b64ToBytes(f.data) : f.text,
    })),
  };
})();

/* ── System file list — populated after fetch('/simulator/filesystem.json') */
let systemPaths = [];
