/* ── File browser panel ──────────────────────────────────────────────────────
   Owns the left-hand file panel: the user + system file trees, the right-click
   context menu, the toolbar (new / new-folder / upload), and all `userFS`
   mutations. It knows nothing about Monaco models or tabs — those stay in app.js,
   reached through the injected `host`:

     host.userFS            — the localStorage-backed FS (see fs.js)
     host.getSystemPaths()  — current system file list (populated after fetch)
     host.openFile(path, { transient, system })  — host opens it (model/tab/preview)
     host.onRenamed(old, new)  — host re-keys any open tab for that path
     host.onDeleted(path)      — host closes any open tab for that path
     host.activePath()         — path of the focused user file (for row highlight)
     host.isTextFile(path)     — bool, used to pick text vs binary on upload

   Returns { refresh(opts) } — call after anything changes the file set; pass
   { rebuildSystem: true } to rebuild the (otherwise build-once) system tree.

   Rendering is template-string + event delegation: each tree is one innerHTML
   build, and one delegated listener per container reads data-path / data-action.
   `bytesToB64` is a global from fs.js. */
function createFileBrowser(host) {
  const userList = document.getElementById('fp-user-list');
  const sysTree  = document.getElementById('fp-sys-tree');
  const menu     = document.getElementById('file-ctx-menu');

  const collapsedDirs = new Set();   // user-tree dirs the user has collapsed
  let sysBuilt = false;

  const esc = (s) => String(s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const normalisePath = (raw) => { const p = raw.trim(); return p.startsWith('/') ? p : '/' + p; };

  /* ── Tree model ──────────────────────────────────────────────────────────
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

  // Render a tree node's entries to an HTML string. `user` toggles the editable
  // (delete button, collapse-state, active highlight) vs read-only system styling.
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
        html += `<details class="tree-dir" data-path="${esc(full)}"${open ? ' open' : ''}>`
              +   `<summary><span class="dir-arrow material-icons">chevron_right</span><span>${esc(name)}/</span></summary>`
              +   `<div class="dir-children">${nodeToHtml(child, full, user, activePath)}</div>`
              + `</details>`;
      } else if (user) {
        const active = full === activePath ? ' active' : '';
        html += `<div class="tree-row${active}" data-path="${esc(full)}" title="${esc(full)}">`
              +   `<span class="row-name">${esc(name)}</span>`
              +   `<span class="row-actions"><button class="row-action ctx-danger" title="Delete" data-action="delete"><span class="material-icons">close</span></button></span>`
              + `</div>`;
      } else {
        html += `<div class="tree-row" data-path="${esc(full)}" title="${esc(full)}">`
              +   `<span class="row-name">${esc(name)}</span>`
              +   `<span class="row-badge material-icons" title="System file">lock</span>`
              + `</div>`;
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

    const paths = host.userFS.paths();
    userList.innerHTML = paths.length
      ? nodeToHtml(buildDirTree(paths), '', true, host.activePath())
      : '<div class="fp-empty">No files yet.</div>';

    if (!sysBuilt) {
      sysBuilt = true;
      sysTree.innerHTML = nodeToHtml(buildDirTree(host.getSystemPaths()), '', false);
    }
    const active = host.activePath();
    sysTree.querySelectorAll('.tree-row').forEach(el =>
      el.classList.toggle('active', el.dataset.path === active));
  }

  /* ── Tree interaction (delegated) ────────────────────────────────────────
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

  sysTree.addEventListener('click', (e) => {
    const row = e.target.closest('.tree-row');
    if (row) host.openFile(row.dataset.path, { transient: true, system: true });
  });
  sysTree.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.tree-row');
    if (row) host.openFile(row.dataset.path, { transient: false, system: true });
  });

  /* ── Context menu ────────────────────────────────────────────────────────*/
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

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.ctx-item');
    if (!item || !ctxTarget) return;
    const { path, isDir } = ctxTarget;
    hideCtxMenu();

    switch (item.dataset.action) {
      case 'open':
        host.openFile(path, { transient: false });
        break;

      case 'rename':
        renamePath(path, isDir);
        break;

      case 'delete':
        deleteUserPath(path, isDir);
        break;

      case 'new-here':
        createUserFile((isDir ? path : path.slice(0, path.lastIndexOf('/'))) + '/');
        break;

      case 'new-dir-here':
        createUserDirAt(isDir ? path : path.slice(0, path.lastIndexOf('/')));
        break;
    }
  });

  /* ── FS operations (mutate userFS, then tell the host about open tabs) ────*/
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

  /* ── Toolbar ─────────────────────────────────────────────────────────────*/
  document.getElementById('fp-new').addEventListener('click',   () => createUserFile('/'));
  document.getElementById('fp-mkdir').addEventListener('click', () => createUserDirAt(''));
  document.getElementById('fp-upload').addEventListener('click', () =>
    document.getElementById('fp-upload-input').click());

  document.getElementById('fp-upload-input').addEventListener('change', async (e) => {
    for (const file of e.target.files) {
      const path = normalisePath(file.name);
      if (host.isTextFile(path) || file.type.startsWith('text/')) {
        host.userFS.set(path, { text: await file.text(), binary: false });
      } else {
        const buf = await file.arrayBuffer();
        host.userFS.set(path, { data: bytesToB64(new Uint8Array(buf)), binary: true, mimeType: file.type });
      }
    }
    refresh();
    e.target.value = '';
  });

  return { refresh };
}
