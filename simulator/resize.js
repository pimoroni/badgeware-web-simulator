/* ── Resize handlers ─────────────────────────────────────────────────────── */
function initResizeHandlers() {

  /* ── Vertical resize (user list height) ────────────────────────── */
  {
    const handle  = document.getElementById('fp-v-resize');
    const wrap    = document.getElementById('fp-user-wrap');
    const overlay = document.getElementById('drag-overlay');
    const MIN_H = 40, SYS_MIN = 80;
    let dragging = false, startY = 0, startH = 0;

    handle.addEventListener('mousedown', e => {
      dragging = true; startY = e.clientY; startH = wrap.offsetHeight;
      handle.classList.add('dragging'); overlay.classList.add('active');
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const panelH = document.getElementById('file-panel').clientHeight;
      const maxH   = panelH - SYS_MIN - handle.offsetHeight;
      wrap.style.height = Math.max(MIN_H, Math.min(maxH, startH + (e.clientY - startY))) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false; handle.classList.remove('dragging'); overlay.classList.remove('active');
    });
  }

  /* ── Left resize handle ────────────────────────────────────────── */
  {
    const handle  = document.getElementById('left-resize-handle');
    const panel   = document.getElementById('file-panel');
    const overlay = document.getElementById('drag-overlay');
    const MIN_W = 100, MAX_W = 450;
    let dragging = false, startX = 0, startW = 0;

    handle.addEventListener('mousedown', e => {
      dragging = true; startX = e.clientX; startW = panel.offsetWidth;
      handle.classList.add('dragging'); overlay.classList.add('active');
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      panel.style.width = Math.max(MIN_W, Math.min(MAX_W, startW + (e.clientX - startX))) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false; handle.classList.remove('dragging'); overlay.classList.remove('active');
    });
  }

  /* ── Panel resize ─────────────────────────────────────────────── */
  {
    const handle   = document.getElementById('resize-handle');
    const panel    = document.getElementById('side-panel');
    const overlay  = document.getElementById('drag-overlay');
    // Canvas scales with panel width; keep it wide enough to be usable.
    const MIN_W = 220;

    let dragging = false, startX = 0, startW = 0;

    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      startX   = e.clientX;
      startW   = panel.offsetWidth;
      handle.classList.add('dragging');
      overlay.classList.add('active');
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const maxW  = Math.floor(window.innerWidth * 0.7);
      const newW  = Math.max(MIN_W, Math.min(maxW, startW + (startX - e.clientX)));
      panel.style.width = newW + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      overlay.classList.remove('active');
    });
  }

}
