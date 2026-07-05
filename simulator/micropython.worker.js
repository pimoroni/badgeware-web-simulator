import { idbOpen } from './util.js'

const worker = self

WorkerGlobalScope.worker = worker

worker.running = false
worker.paused = true
worker.input = 0
worker.debug = false
worker.main = null          // promise for the in-flight program run, or null
worker.stopping = false     // true while interrupting the run on purpose
worker.servicing = false    // true while the request serialiser is draining
worker.pendingRequest = null // latest stop/run request awaiting service

// Simulated `machine` peripheral state, shared with the WASM module.
// The C `machine` module reads/writes this object via EM_ASM:
//   gpio       - last value driven by Pin.value(x), keyed by gpio number
//   gpio_in    - input states the host may set, keyed by gpio number
//   pwm        - {freq, duty} keyed by gpio number (duty is a u16, 0..65535)
//   caselights - normalised 0..1 duty for CL0..CL3 (GPIO0..3)
//   adc        - ADC sample values (u16) keyed by channel, host-settable
worker.machine = {
  gpio: {},
  gpio_in: {},
  pwm: {},
  caselights: [0, 0, 0, 0],
  adc: {},
}

// Snapshot used to avoid posting unchanged caselight values every frame.
worker._caselights_last = "0,0,0,0"

// We ship two builds: a JSPI (Wasm stack switching) one and an Asyncify one.
// JSPI is lighter/faster but isn't in mainline Safari yet, so pick at runtime:
// use JSPI when the engine exposes it, otherwise fall back to Asyncify. Each
// build self-declares its async mode to api.js, so loading the right .mjs is the
// only decision here.
worker.async_backend =
  (typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function')
    ? 'jspi'
    : 'asyncify'
console.log(`WORKER: MicroPython async backend: ${worker.async_backend}`)

import(new URL(`./${worker.async_backend}/micropython.mjs`, import.meta.url).href).then((mp_mjs) => {
  const stdoutWriter = (line) => {
    if (worker.debug) console.log(`WORKER: stdout: ${line}`)
    worker.postMessage({stdout: line})
  }

  mp_mjs.loadMicroPython({
    heapsize: 7 * 1024 * 1024,
    linebuffer: true,
    stdout: stdoutWriter,
    stderr: stdoutWriter
  }).then(async (mp) => {

    const dirname = (file) => {
      return file.substring(0, file.lastIndexOf("/"))
    }

    const mkdir_recursive = (path) => {
      let parts = path.split("/")
      let dir = ""
      parts.forEach((part) => {
        dir += "/" + part
        try {
          mp.FS.mkdir(dir)
        } catch {
          // Directory probably exits. No sweat.
        }
      })
    }

    /* -- User-file persistence (simulator -> editor) --------------------------
       A running program's file writes land in Emscripten's in-memory FS, which is
       torn down on reset - so they'd be invisible to the editor and lost on exit.
       We mirror the *user* region of the FS into the very same IndexedDB store the
       editor uses (badgeware.userfs / files, see fs.js), in the same entry shape,
       so files saved by the simulator show up in the Files panel and survive.

       Firmware/system files (the lazy-loaded manifest) are read-only: writing,
       truncating, renaming or deleting one raises EROFS. A coalesced {fsChanged}
       ping tells the host to reload its cache and repaint the tree. The forward
       direction (editor -> simulator) stays as injectFiles() below. */
    const USER_FS_DB = 'badgeware.userfs'
    const USER_FS_STORE = 'files'
    const EROFS = 69   // WASI errno used by this Emscripten build (see ERRNO_CODES)
    const SYS_PREFIXES = ['/dev', '/proc', '/tmp', '/sys', '/home']

    let dbPromise = null
    const db = () => (dbPromise ??= idbOpen(USER_FS_DB, USER_FS_STORE))
    const idbTx = (mode, fn) => db().then((d) => new Promise((res, rej) => {
      const t = d.transaction(USER_FS_STORE, mode)
      fn(t.objectStore(USER_FS_STORE))
      t.oncomplete = () => res()
      t.onerror = () => rej(t.error)
    }))

    // Serialise writes so per-key ordering is preserved; callers fire-and-forget.
    let writeChain = Promise.resolve()
    const enqueue = (work) => {
      writeChain = writeChain.then(work).catch((e) => console.error('WORKER: userfs persist failed', e))
      return writeChain
    }

    // Coalesce change notifications to the host into one message per microtask.
    let pingPending = false
    const notifyHost = () => {
      if (pingPending) return
      pingPending = true
      Promise.resolve().then(() => { pingPending = false; worker.postMessage({ fsChanged: true }) })
    }

    const idbPut = (key, value) => { enqueue(() => idbTx('readwrite', (s) => s.put(value, key))); notifyHost() }
    const idbDel = (key)        => { enqueue(() => idbTx('readwrite', (s) => s.delete(key))); notifyHost() }

    // Move every key under oldPath (a directory) to newPath in one cursor pass. A
    // directory rename rewires a single FS pointer, so the per-file hooks never
    // fire - we reconcile the persisted subtree here instead.
    const idbReKey = (oldPath, newPath) => {
      enqueue(() => idbTx('readwrite', (store) => {
        const req = store.openCursor()
        req.onsuccess = () => {
          const cur = req.result
          if (!cur) return
          const k = String(cur.key)
          if (k === oldPath || k === oldPath + '/' || k.startsWith(oldPath + '/')) {
            store.put(cur.value, newPath + k.slice(oldPath.length))
            store.delete(k)
          }
          cur.continue()
        }
      }))
      notifyHost()
    }

    const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', wav: 'audio/wav', json: 'application/json' }
    const guessMime = (p) => MIME[(p.split('.').pop() || '').toLowerCase()] || 'application/octet-stream'

    // Pick the editor's text-vs-binary entry shape from the bytes themselves: valid
    // UTF-8 with no zero bytes is stored as text (matching how the editor saves .py
    // and friends); anything else is stored as binary with a guessed mime type.
    const toEntry = (path, bytes) => {
      if (!bytes.includes(0)) {
        try {
          return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), binary: false }
        } catch (_) {}
      }
      return { data: new Uint8Array(bytes), binary: true, mimeType: guessMime(path) }
    }

    // A user path is anything outside the system mounts and not the root itself.
    // Firmware files live here too but are skipped via their read-only flag.
    const isUserPath = (p) => !!p && p !== '/' && !SYS_PREFIXES.some((x) => p === x || p.startsWith(x + '/'))

    // While true, FS mutations don't persist or notify - used for host-driven
    // staging (firmware lazy-load, editor file injection) that already mirrors the
    // store, so it must never echo back and cause a reload loop.
    let persistSuppressed = false
    const withSuppressed = (fn) => {
      const prev = persistSuppressed
      persistSuppressed = true
      try { return fn() } finally { persistSuppressed = prev }
    }

    const guardReadOnly = (node) => { if (node && node.__ro) throw new mp.FS.ErrnoError(EROFS) }

    const persistNode = (node) => {
      if (persistSuppressed || !node || node.__ro) return
      const path = mp.FS.getPath(node)
      if (!isUserPath(path)) return
      if (mp.FS.isDir(node.mode)) { idbPut(path + '/', { isDir: true }); return }
      if (!mp.FS.isFile(node.mode)) return
      // Snapshot the bytes now (slice copies), so a later write or unlink can't
      // change what this queued persist writes.
      const bytes = node.contents ? node.contents.slice(0, node.usedBytes) : new Uint8Array(0)
      idbPut(path, toEntry(path, bytes))
    }
    const forgetNode = (path, isDir) => { if (!persistSuppressed && isUserPath(path)) idbDel(isDir ? path + '/' : path) }

    // Wrap a node's ops in place so the user region enforces read-only firmware and
    // mirrors writes to IndexedDB. Children created under a wrapped dir are wrapped
    // in turn (via mknod), so wrapping the root covers the whole tree. We copy the
    // base ops as OWN properties (not via prototype) because createLazyFile below
    // re-wraps a node's stream ops by enumerating its own keys - inherited ops would
    // be dropped (notably llseek), breaking firmware reads.
    //
    // A FILE is persisted on close (only if it was written), never on create or
    // truncate. That mirrors the hardware: written bytes aren't durable until the
    // file is flushed/closed, so `open(p,"w").write(x)` with no close persists
    // nothing until the handle is finalised (on GC), whereas `with open(p,"w") as f:
    // f.write(x)` closes deterministically. We deliberately don't flush unclosed
    // writes early - that would make the simulator more forgiving than a real badge.
    // DIRECTORIES persist on creation (mkdir), since they carry no unflushed state.
    const wrapNode = (node) => {
      if (!node || node.__wrapped) return node
      if (mp.FS.isDir(node.mode)) {
        node.__wrapped = true
        const base = node.node_ops
        const ops = Object.assign({}, base)
        ops.mknod = (parent, name, mode, dev) => { const child = base.mknod(parent, name, mode, dev); wrapNode(child); if (mp.FS.isDir(child.mode)) persistNode(child); return child }
        ops.unlink = (parent, name) => { const child = parent.contents[name]; guardReadOnly(child); const p = mp.FS.getPath(child); base.unlink(parent, name); forgetNode(p, false) }
        ops.rmdir = (parent, name) => { const child = parent.contents[name]; guardReadOnly(child); const p = mp.FS.getPath(child); base.rmdir(parent, name); forgetNode(p, true) }
        ops.setattr = (n, attr) => { if (attr.size !== undefined) guardReadOnly(n); base.setattr(n, attr) }
        ops.rename = (oldNode, newDir, newName) => {
          guardReadOnly(oldNode)
          const isDir = mp.FS.isDir(oldNode.mode)
          const oldPath = mp.FS.getPath(oldNode)
          base.rename(oldNode, newDir, newName)
          const newPath = mp.FS.getPath(oldNode)
          if (persistSuppressed) return
          if (isDir) idbReKey(oldPath, newPath)
          else { forgetNode(oldPath, false); persistNode(oldNode) }
        }
        node.node_ops = ops
      } else if (mp.FS.isFile(node.mode)) {
        node.__wrapped = true
        const nbase = node.node_ops
        const nops = Object.assign({}, nbase)
        // Truncate (e.g. open(p,"w")) counts as a write intent: mark dirty so an
        // empty-but-closed file still persists, but wait for close to write it.
        nops.setattr = (n, attr) => { if (attr.size !== undefined) guardReadOnly(n); nbase.setattr(n, attr); if (attr.size !== undefined) n.__dirty = true }
        node.node_ops = nops
        const sbase = node.stream_ops
        const sops = Object.assign({}, sbase)
        sops.write = (stream, buffer, offset, length, position, canOwn) => { guardReadOnly(stream.node); const r = sbase.write(stream, buffer, offset, length, position, canOwn); stream.node.__dirty = true; return r }
        sops.close = (stream) => { if (sbase.close) sbase.close(stream); if (stream.node.__dirty) { stream.node.__dirty = false; persistNode(stream.node) } }
        node.stream_ops = sops
      }
      return node
    }

    // Install: wrap the existing root so every node created afterwards is wrapped.
    wrapNode(mp.FS.root)

    // Create a lazy file whose length we already know (from the manifest), so
    // Emscripten skips its synchronous HEAD probe. Emscripten's stock
    // createLazyFile fetches the length on first stat/read via a blocking HEAD,
    // then a second request for the content (and on gzip it downloads the whole
    // file just to learn the uncompressed length). We always read whole module
    // files, so seeding the length and fetching the file in one GET on first
    // read removes a blocking round-trip per file.
    //
    // micropython.mjs is a build artefact, so if its LazyUint8Array shape ever
    // changes we fall back to the stock (slower) behaviour rather than break.
    const createKnownLazyFile = (path, url, size) => {
      const node = mp.FS.createLazyFile("", path, url, true, false)
      // Firmware/system files are read-only: the parent dir's ops refuse to
      // unlink/rename them (via __ro), and any write raises EROFS rather than the
      // generic "cannot write to lazy file" error. We may relax this to copy-on-
      // write later (keeping the manifest as a "factory restore" source).
      node.__ro = true
      const sbase = node.stream_ops
      node.stream_ops = Object.assign(Object.create(sbase), { write() { throw new mp.FS.ErrnoError(EROFS) } })
      const arr = node.contents
      if (!arr || typeof arr.setDataGetter !== 'function' || !('lengthKnown' in arr)) {
        return node  // unexpected internals — leave Emscripten's default behaviour
      }
      arr._length = size
      arr._chunkSize = size || 1   // whole file is a single chunk
      arr.chunks = []
      arr.lengthKnown = true
      arr.setDataGetter(() => {
        if (arr.chunks[0] === undefined) {
          const xhr = new XMLHttpRequest()
          xhr.open('GET', url, false)
          xhr.responseType = 'arraybuffer'
          xhr.send(null)
          if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) {
            throw new Error(`Failed to load ${url}: ${xhr.status}`)
          }
          arr.chunks[0] = new Uint8Array(xhr.response)
        }
        return arr.chunks[0]
      })
      return node
    }

    // Fetch JSON Manifest generated with "python3 filesystem.py > filesystem.json"
    // Shape: { "files": { "/path": byteSize, ... } }
    await fetch(new URL('./filesystem.json', import.meta.url).href).then(async (response) => {
      if(response.ok) {
        // Pray we don't have a parsing error...
        const file_sizes = (await response.json())["files"]
        const paths = Object.keys(file_sizes)

        // Get a unique list of directories we need to create from the above
        const directories = [... new Set(paths.map(dirname))]

        // Firmware is host-provided, read-only staging: suppress persistence so
        // building the system tree doesn't echo back into the user store.
        withSuppressed(() => {
          // Iterate through directories and create each node in turn
          directories.forEach(mkdir_recursive);

          // Use the file list to create lazy-loading file entries in the FS
          // I am in awe that this works.
          paths.forEach((file) => {
            createKnownLazyFile(`${file}`, new URL(`./filesystem${file}`, import.meta.url).href, file_sizes[file])
          })
        })

        // Remember the read-only set for a future "factory restore" affordance.
        worker.firmwarePaths = new Set(paths)
      }
    })

    worker.update_caselights = () => {
      // Forward caselight PWM values to the host for visualisation, but only
      // when they've actually changed to avoid flooding the message channel.
      const caselights = worker.machine.caselights
      const key = caselights.join(",")
      if (key !== worker._caselights_last) {
        worker._caselights_last = key
        worker.postMessage({ caselights: caselights.slice() })
      }
    }

    // Send the raw RGBA framebuffer to the host for the 3D screen texture. We
    // transfer a copy so the host can upload it directly (DataTexture) instead
    // of re-reading our canvas every frame. See badge3d.js uploadFrame().
    worker.send_frame = (data, width, height) => {
      const copy = data.slice(0, width * height * 4)   // own, exact-size buffer to transfer
      worker.postMessage({ frame: { buffer: copy.buffer, width, height } }, [copy.buffer])
    }

    // Handle a flip from a 160x120x4 byte buffer
    worker.flip_lores = (data) => {
      worker.update_caselights();
      worker.send_frame(data, 160, 120);
    }

    // Forward case-light values [v0..v3] (0.0–1.0) to the host
    worker.set_case_lights = (v0, v1, v2, v3) => {
      worker.postMessage({ caselights: [v0, v1, v2, v3] });
    }

    // Handle a flip from a 320x240x4 byte buffer
    worker.flip_hires = (data) => {
      worker.update_caselights();
      worker.send_frame(data, 320, 240);
    }

    // How long to wait for an interrupted program to actually unwind before we
    // give up and ask the host to hard-reset us. A genuinely stuck *native* call
    // (a deadlocked fetch, a tight C loop) can't be interrupted from JS; a tight
    // Python loop always can, because the VM hook yields to us between bytecodes.
    const STOP_TIMEOUT_MS = 1500

    // Inject host-provided user files into the WASM FS (editor -> simulator). These
    // already mirror the user store, so we stage them with persistence suppressed to
    // avoid echoing straight back. Existing entries are overwritten so a warm worker
    // (soft reset, FS intact) still picks up edits made in the editor.
    const injectFiles = (files) => {
      if (!files || !files.length) return
      withSuppressed(() => {
        for (const f of files) {
          const name = f.name.startsWith('/') ? f.name : '/' + f.name
          // Directory markers (trailing slash) / entries with no payload: just
          // ensure the directory exists so empty user folders survive.
          if (name.endsWith('/') || f.content == null) {
            mkdir_recursive(name.replace(/\/+$/, ''))
            continue
          }
          try {
            mkdir_recursive(dirname(name))
            try { mp.FS.unlink(name) } catch (_) {}
            mp.FS.createDataFile(null, name, f.content, true, true)
          } catch (_) {}
        }
      })
    }

    // Run a user program to completion in the live instance. Stored in
    // `worker.main` so a later start/stop can interrupt and await it. Both the
    // program's own blocking loop and the `_update()` fall-through loop unwind
    // through here, so either is interruptible.
    const runProgram = async (program) => {
      worker.stopping = false

      // Arm execution *before* any user code runs. A program may block in its
      // own `while True:` here (never returning) or fall through to the
      // `_update(update)` loop below; in both cases the WASM module's cooperative
      // pause/stop is gated on `worker.running`, so it must be set now for either
      // path to be pausable. Posting `running` starts the host's visibility
      // observer, which drives `worker.paused` via pause/resume. Everything is
      // inside the try so worker.main never rejects (it is awaited fire-and-
      // forget; an unhandled rejection would otherwise escape here).
      worker.running = true
      worker.paused = false
      worker.postMessage({ running: true })

      try {
        await mp.runPython(`sys.path.insert(0, "/")`)
        await mp.runPython(`import badgeware`)
        await mp.runPython(program)
        // The program returned (it didn't block), so drive the frame loop.
        await mp.runPython(`
try:
    while True:
        _update(update)
except NameError:
    pass
`)
      } catch (error) {
        if (worker.stopping) {
          // Interrupted on purpose (stop / restart): the KeyboardInterrupt that
          // unwound the run is expected — swallow it silently.
        } else {
          const msg = error.message ?? String(error)
          try {
            await mp.runPython(`badgeware.fatal_error("Error!", ${JSON.stringify(msg)})`)
          } catch (_) {
            worker.postMessage({ stdout: msg })
          }
          worker.paused = true
        }
      } finally {
        worker.running = false
      }
    }

    // Interrupt the running program (if any) and wait for it to unwind. Returns
    // true once stopped, false if it didn't within STOP_TIMEOUT_MS (stuck).
    const stopCurrent = async () => {
      if (!worker.main) return true
      worker.stopping = true
      try { mp.interrupt() } catch (_) {}
      // Release the C pause loop (mp_js_yield_hook) if we're paused, so the VM
      // resumes and raises the pending KeyboardInterrupt.
      worker.running = false
      worker.paused = false
      const stopped = await Promise.race([
        worker.main.then(() => true, () => true),
        new Promise((resolve) => setTimeout(() => resolve(false), STOP_TIMEOUT_MS)),
      ])
      if (stopped) {
        worker.main = null
        worker.stopping = false
      }
      return stopped
    }

    // Return the live instance to roughly a fresh-boot state without tearing
    // down the WASM module: reset simulated hardware state, drop every module
    // imported since boot (so badgeware + user modules re-import fresh) and clear
    // the user globals added to __main__. Relies on the boot snapshot taken once
    // the instance is ready (see below).
    const softReset = async () => {
      worker.machine.gpio = {}
      worker.machine.gpio_in = {}
      worker.machine.pwm = {}
      worker.machine.caselights = [0, 0, 0, 0]
      worker.machine.adc = {}
      worker._caselights_last = "0,0,0,0"
      if (worker.update_caselights) worker.update_caselights()
      try {
        await mp.runPython(`
def __soft_reset():
    import sys
    g = globals()
    boot_g = g.get("__boot_globals__", set())
    boot_m = g.get("__boot_modules__", set())
    for k in [x for x in list(g) if x not in boot_g and x != "__soft_reset"]:
        del g[k]
    # sys.modules holds only frozen/filesystem modules (not builtins), so this
    # drops badgeware + user modules and they re-import fresh next run.
    for m in [x for x in list(sys.modules) if x not in boot_m]:
        del sys.modules[m]
__soft_reset()
del __soft_reset
`)
      } catch (_) {}
    }

    // Single serialiser for everything that touches the VM. Asyncify allows only
    // one suspended VM call in flight at a time, so stop/run requests (which each
    // interrupt + soft-reset + maybe start a program) must never overlap — under
    // Asyncify overlapping causes "cannot start an async operation when one is
    // already in flight", under JSPI an unhandled WebAssembly.Exception. Requests
    // coalesce: only `worker.pendingRequest` (the latest) is serviced.
    //   pendingRequest = { kind: "run", program, files } | { kind: "stop" } | null
    const service = async () => {
      if (worker.servicing) return
      worker.servicing = true
      try {
        while (worker.pendingRequest) {
          const req = worker.pendingRequest
          worker.pendingRequest = null
          if (!(await stopCurrent())) {
            // Couldn't interrupt a stuck native call — ask the host to hard-reset.
            worker.postMessage({ stuck: true })
            worker.pendingRequest = null
            break
          }
          await softReset()
          if (req.kind === "run") {
            injectFiles(req.files)
            // Fire-and-forget: runProgram loops for the life of the program and a
            // later request's stopCurrent() interrupts/awaits it. It is fully
            // guarded so it resolves rather than rejects; the .catch is a belt-
            // and-braces guard against an unhandled rejection escaping.
            worker.main = runProgram(req.program)
            worker.main.catch(() => {})
          }
        }
      } finally {
        worker.servicing = false
      }
    }

    worker.onmessage = async ({ data: { program, stop, buttons, pause, file, files, debug } }) => {
      if (typeof buttons !== 'undefined') {
        if (worker.debug) console.log(`WORKER: Got buttons`)
        worker.input = buttons
        return
      }

      if (typeof debug !== 'undefined') {
        worker.debug = debug
      }

      if (program) {
        if (worker.debug) console.log(`WORKER: Got program`)
        // Queue as the latest request and let the serialiser drain it (it may be
        // mid-service of a previous request; that's fine, it loops).
        worker.pendingRequest = { kind: "run", program, files }
        service().catch(() => {})
        return
      }

      // Allow the host to request the worker download a file to MicroPython's
      // virtual filesystem, or create one with the supplied content.
      if (file) {
        // Host-driven staging (deep-link etc), like injectFiles: suppress
        // persistence so it doesn't echo back into the user store.
        if (file.url) {
          if (worker.debug) console.log(`WORKER: Fetching file ${file.name}`);
          await fetch(file.url)
            .then(async (response) => {
              if(response.ok) {
                let data = new Uint8ClampedArray(await response.arrayBuffer());
                withSuppressed(() => {
                  try { mp.FS.unlink(file.name) } catch (_) {}
                  mp.FS.createDataFile(null, file.name, data, true, true);
                });
                if (worker.debug) console.log(`WORKER: Saved ${file.name}`);
              }
            })
            .catch((err) => { if (worker.debug) console.log(err) });
        }
        if (file.code) {
          if (worker.debug) console.log(`WORKER: Saving file ${file.name}`);
          withSuppressed(() => {
            mkdir_recursive(dirname(file.name))
            try { mp.FS.unlink(file.name) } catch (_) {}
            mp.FS.createDataFile(null, file.name, file.code, true, true);
          });
        }
      }

      if (typeof pause !== 'undefined') {
        if(pause) {
          if (worker.debug) console.log(`WORKER: Pausing execution.`)
        } else {
          if (worker.debug) console.log(`WORKER: Resuming execution.`)
        }
        worker.paused = pause
      }

      if (stop) {
        // Interrupt and soft-reset in place, leaving the instance idle, through
        // the same serialiser so it can't overlap a run request.
        worker.pendingRequest = { kind: "stop" }
        service().catch(() => {})
      }
    }

    // Print a banner matching the hardware REPL, e.g.
    // "MicroPython 1.28.0; Pimoroni Tufty 2350 with RP2350", then snapshot the
    // boot module/global sets so softReset() can tell user state from boot state.
    mp.runPython(`import platform, sys
__version__ = platform.platform().split("-")[1]
print(f"MicroPython {__version__}; {sys.implementation._machine}")
__boot_modules__ = set(sys.modules)
__boot_globals__ = set(globals()) | {"__boot_modules__", "__boot_globals__"}`)
    worker.postMessage({ ready: true })
  })

})