/* -- File browser panel ------------------------------------------------------
   Owns the left-hand file panel: the user + system file trees, the right-click
   context menu, the toolbar (new / new-folder / upload), and all `userFS`
   mutations. It knows nothing about Monaco models or tabs — those stay in app.js.

   els  — the panel's DOM, looked up + injected by app.js (the module never reaches
   into the document for identity): { userList, sysTree, ctxMenu, uploadInput,
   userHeader }. host — data + callbacks it can't reach itself:

     host.userFS            — the IndexedDB-backed FS (see fs.js)
     host.getSystemPaths()  — current system file list (populated after fetch)
     host.openFile(path, { transient, system })  — host opens it (model/tab/preview)
     host.onRenamed(old, new)  — host re-keys any open tab for that path
     host.onDeleted(path)      — host closes any open tab for that path
     host.activePath()         — path of the focused user file (highlight)
     host.openPaths()          — Set of paths with an open tab (bolder row)
     host.transientPath()      — path of the transient/preview tab, or null (italic)
     host.isTextFile(path)     — bool, used to pick text vs binary on upload

   Returns { refresh(opts), syncRows() } — refresh after the file SET changes
   (pass { rebuildSystem: true } to rebuild the build-once system tree); syncRows
   after a TAB change to re-decorate rows without a rebuild.

   Rendering is template-string + event delegation: each tree is one innerHTML
   build, and one delegated listener per container reads data-path / data-action. */
import { delegate } from './util.js';

export function createFileBrowser(els, host) {
  const { userList, sysTree, ctxMenu: menu, uploadInput, userHeader } = els;

  const collapsedDirs = new Set();   // user-tree dirs the user has collapsed
  let sysBuilt = false;

  const esc = (s) => String(s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const normalisePath = (raw) => { const p = raw.trim(); return p.startsWith('/') ? p : '/' + p; };

  /* -- Tree model ----------------------------------------------------------
     Build a nested {name: child|null} tree from a flat path list. Paths ending
     in "/" are explicit directory markers. */
  function buildDirTree(paths) {
    const root = {};
    for (const p of paths) {
      const isDir = p.endsWith('/');
      const parts = p.split('/').filter(Boolean);
      let node = root;
      const limit = isDir ? parts.length : parts.length - 1;
      for (let i = 0; i < limit; i++) node = (node[parts[i]] ||= { __dir: true });
      if (!isDir) node[parts[parts.length - 1]] = null;
    }
    return root;
  }

  // Render a tree node's entries to a string of <li> elements (the caller wraps
  // them in a <ul>). Directories stay as <details>/<summary> for free, accessible
  // collapse; their children recurse into a nested <ul class="dir-children">. File
  // rows are tabbable (tabindex=0) so the keyboard reaches them too, not just the
  // directory summaries. `user` toggles editable (delete button, collapse-state,
  // active highlight) vs read-only system styling.
  function nodeToHtml(node, prefix, user, activePath) {
    const entries = Object.entries(node)
      .filter(([k]) => k !== '__dir')
      .sort(([a, av], [b, bv]) => {
        const ad = av && av.__dir, bd = bv && bv.__dir;
        return (ad === bd) ? a.localeCompare(b) : (ad ? -1 : 1);
      });

    let html = '';
    for (const [name, child] of entries) {
      const full = prefix + '/' + name;
      if (child && child.__dir) {
        const open = user ? !collapsedDirs.has(full) : false;   // user dirs default open
        html += `<li><details class="tree-dir" data-path="${esc(full)}"${open ? ' open' : ''}>`
              +   `<summary><span class="dir-arrow material-symbols-outlined">chevron_right</span><span>${esc(name)}/</span></summary>`
              +   `<ul class="dir-children">${nodeToHtml(child, full, user, activePath)}</ul>`
              + `</details></li>`;
      } else if (user) {
        const active = full === activePath ? ' active' : '';
        html += `<li><div class="tree-row${active}" tabindex="0" data-path="${esc(full)}" title="${esc(full)}">`
              +   `<span class="row-name">${esc(name)}</span>`
              +   `<span class="row-actions"><button class="row-action" title="Delete" data-action="delete"><span class="material-symbols-outlined">delete</span></button></span>`
              + `</div></li>`;
      } else {
        html += `<li><div class="tree-row" tabindex="0" data-path="${esc(full)}" title="${esc(full)}">`
              +   `<span class="row-name">${esc(name)}</span>`
              +   `<span class="row-badge material-symbols-outlined" title="System file">lock</span>`
              + `</div></li>`;
      }
    }
    return html;
  }

  function refresh(opts) {
    if (opts && opts.rebuildSystem) sysBuilt = false;

    // Remember which user dirs are collapsed before we blow the DOM away.
    userList.querySelectorAll('details.tree-dir[data-path]').forEach(d => {
      if (d.open) collapsedDirs.delete(d.dataset.path); else collapsedDirs.add(d.dataset.path);
    });

    // Rebuilding userList drops keyboard focus; note the focused row's path so we
    // can restore it (so Space-to-preview keeps focus for the next Tab).
    const focused = document.activeElement;
    const refocusPath = (userList.contains(focused) && focused.classList.contains('tree-row'))
      ? focused.dataset.path : null;

    const paths = host.userFS.paths();
    userList.innerHTML = paths.length
      ? `<ul class="tree">${nodeToHtml(buildDirTree(paths), '', true, host.activePath())}</ul>`
      : '<div class="fp-empty">No files yet.</div>';

    if (refocusPath) {
      userList.querySelector(`.tree-row[data-path="${refocusPath.replace(/["\\]/g, '\\$&')}"]`)?.focus();
    }

    if (!sysBuilt) {
      sysBuilt = true;
      sysTree.innerHTML = `<ul class="tree">${nodeToHtml(buildDirTree(host.getSystemPaths()), '', false)}</ul>`;
    }
    syncRows();   // re-apply active/open/transient decorations after the rebuild
  }

  // Project tab state onto the row decorations — active (highlight), open (bolder)
  // and transient (italic preview) — on both trees, via class toggles only (no
  // rebuild). tabs.js calls this on every tab change instead of refresh() so a
  // click can't replace a row mid-double-click (which would swallow the dblclick)
  // and keyboard focus is preserved.
  function syncRows() {
    const active    = host.activePath();
    const open      = host.openPaths();
    const transient = host.transientPath();
    for (const el of [...userList.querySelectorAll('.tree-row'), ...sysTree.querySelectorAll('.tree-row')]) {
      const p = el.dataset.path;
      el.classList.toggle('active',    p === active);
      el.classList.toggle('open',      open.has(p));
      el.classList.toggle('transient', p === transient);
    }
  }

  /* -- Tree interaction (delegated) ----------------------------------------
     <details> handles its own open/close natively; we only wire opens/deletes
     and the context menu. */
  userList.addEventListener('click', (e) => {
    const del = e.target.closest('[data-action="delete"]');
    if (del) { e.stopPropagation(); deleteUserPath(del.closest('.tree-row').dataset.path); return; }
    const row = e.target.closest('.tree-row');
    if (row) host.openFile(row.dataset.path, { transient: true });
  });
  userList.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.tree-row');
    if (row) host.openFile(row.dataset.path, { transient: false });
  });
  userList.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.tree-row');
    if (row) { showCtxMenu(e, row.dataset.path, false); return; }
    const summary = e.target.closest('summary');
    if (summary) showCtxMenu(e, summary.closest('details').dataset.path, true);
  });
  // Keyboard on a focused file row: Space previews (transient, like single-click),
  // Enter opens for keeps (like double-click), Delete/Backspace removes it (so the
  // delete button needn't be a tab stop — it stays mouse-hover only). Directories
  // use the native <summary> toggle, so only act when a row itself holds focus.
  userList.addEventListener('keydown', (e) => {
    if (!e.target.classList.contains('tree-row')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      host.openFile(e.target.dataset.path, { transient: e.key === ' ' });
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      const path = e.target.dataset.path;
      // Remember the row to land on (next sibling, else previous) before the rebuild.
      const rows = [...userList.querySelectorAll('.tree-row')];
      const i = rows.indexOf(e.target);
      const nextPath = (rows[i + 1] || rows[i - 1])?.dataset.path;
      deleteUserPath(path);
      if (nextPath && !host.userFS.get(path)) {   // deletion happened → move focus on
        userList.querySelector(`.tree-row[data-path="${nextPath.replace(/["\\]/g, '\\$&')}"]`)?.focus();
      }
    }
  });

  sysTree.addEventListener('click', (e) => {
    const row = e.target.closest('.tree-row');
    if (row) host.openFile(row.dataset.path, { transient: true, system: true });
  });
  sysTree.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.tree-row');
    if (row) host.openFile(row.dataset.path, { transient: false, system: true });
  });
  sysTree.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (!e.target.classList.contains('tree-row')) return;
    e.preventDefault();
    host.openFile(e.target.dataset.path, { transient: e.key === ' ', system: true });
  });

  /* -- Context menu --------------------------------------------------------*/
  let ctxTarget = null;   // { path, isDir }

  function showCtxMenu(e, path, isDir) {
    e.preventDefault();
    ctxTarget = { path, isDir };
    menu.querySelector('[data-action="open"]').style.display = isDir ? 'none' : '';
    menu.querySelector('[data-action="new-here"]').style.display = '';
    menu.style.left = e.clientX + 'px';
    menu.style.top  = e.clientY + 'px';
    menu.style.display = 'block';
    requestAnimationFrame(() => {     // clamp within the viewport
      const r = menu.getBoundingClientRect();
      if (r.right  > innerWidth)  menu.style.left = (e.clientX - r.width)  + 'px';
      if (r.bottom > innerHeight) menu.style.top  = (e.clientY - r.height) + 'px';
    });
  }
  function hideCtxMenu() { menu.style.display = 'none'; ctxTarget = null; }

  // Capture phase: dismiss the menu on any click/contextmenu outside it.
  document.addEventListener('click',       e => { if (!e.target.closest('#file-ctx-menu')) hideCtxMenu(); }, true);
  document.addEventListener('contextmenu', e => { if (!e.target.closest('#file-ctx-menu')) hideCtxMenu(); }, true);

  // Each action runs against the target captured when the menu opened, then
  // dismisses it. hideCtxMenu() clears ctxTarget, so snapshot it first.
  const dirOf = (t) => (t.isDir ? t.path : t.path.slice(0, t.path.lastIndexOf('/')));   // dir to create into
  const onTarget = (fn) => () => { if (!ctxTarget) return; const t = ctxTarget; hideCtxMenu(); fn(t); };
  delegate(menu, {
    open:           onTarget((t) => host.openFile(t.path, { transient: false })),
    rename:         onTarget((t) => renamePath(t.path, t.isDir)),
    delete:         onTarget((t) => deleteUserPath(t.path, t.isDir)),
    'new-here':     onTarget((t) => createUserFile(dirOf(t) + '/')),
    'new-dir-here': onTarget((t) => createUserDirAt(dirOf(t))),
  });

  /* -- FS operations (mutate userFS, then tell the host about open tabs) ----*/
  function renamePath(path, isDir) {
    const parts   = path.split('/');
    const oldName = parts.pop();
    const dir     = parts.join('/') || '';
    const newName = prompt('Rename to:', oldName);
    if (!newName || newName === oldName) return;
    if (newName.includes('/')) { alert('File name cannot contain /'); return; }
    const newPath = dir + '/' + newName;
    if (host.userFS.get(newPath) && !confirm(newPath + ' already exists. Overwrite?')) return;

    if (isDir) {
      const prefix = path + '/';
      for (const p of host.userFS.paths()) {
        if (p !== prefix && !p.startsWith(prefix)) continue;
        const np = newPath + p.slice(path.length);
        host.userFS.set(np, host.userFS.get(p));
        host.userFS.del(p);
        host.onRenamed(p, np);
      }
    } else {
      host.userFS.set(newPath, host.userFS.get(path));
      host.userFS.del(path);
      host.onRenamed(path, newPath);
    }
    refresh();
  }

  function deleteUserPath(path, isDir = false) {
    const toDelete = isDir
      ? host.userFS.paths().filter(p => p === path + '/' || p.startsWith(path + '/'))
      : [path];
    if (!toDelete.length) return;
    const label = isDir ? path + '/ and all its contents' : path;
    if (!confirm('Delete ' + label + '?')) return;
    for (const p of toDelete) { host.userFS.del(p); host.onDeleted(p); }
    refresh();
  }

  function createUserFile(dirPrefix = '/') {
    const name = prompt('File name:', 'untitled.py');
    if (!name) return;
    if (name.includes('/')) { alert('File name cannot contain /. Use the folder button to create directories.'); return; }
    const path = normalisePath(dirPrefix + name);
    if (host.userFS.get(path) && !confirm(path + ' already exists. Overwrite?')) return;
    host.userFS.set(path, { text: '', binary: false });
    refresh();
    host.openFile(path, { transient: false });
  }

  function createUserDirAt(parentPath = '') {
    const name = prompt('Folder name:', 'assets');
    if (!name) return;
    if (name.includes('/')) { alert('Folder name cannot contain /'); return; }
    const base    = parentPath.replace(/\/+$/, '');
    const dirPath = (base || '') + '/' + name + '/';
    if (!host.userFS.get(dirPath)) host.userFS.set(dirPath, { isDir: true });
    refresh();
  }

  /* -- Toolbar -------------------------------------------------------------
     New file / folder / upload — same data-action dispatch, scoped to the user
     section's header (the tree below has its own delete data-action). */
  delegate(userHeader, {
    'new-file': () => host.newScratch(),
    'new-dir':  () => createUserDirAt(''),
    'upload':   () => uploadInput.click(),
  });

  uploadInput.addEventListener('change', async (e) => {
    for (const file of e.target.files) {
      const path = normalisePath(file.name);
      if (host.isTextFile(path) || file.type.startsWith('text/')) {
        host.userFS.set(path, { text: await file.text(), binary: false });
      } else {
        const buf = await file.arrayBuffer();
        host.userFS.set(path, { data: new Uint8Array(buf), binary: true, mimeType: file.type });
      }
    }
    refresh();
    e.target.value = '';
  });

  return { refresh, syncRows };
}
