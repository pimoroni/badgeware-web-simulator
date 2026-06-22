const worker = self

WorkerGlobalScope.worker = worker

worker.running = false
worker.paused = true
worker.input = 0
worker.debug = false
worker.main = null

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

import(new URL('./micropython.mjs', import.meta.url).href).then((mp_mjs) => {
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

        // Iterate through directories and create each node in turn
        directories.forEach(mkdir_recursive);

        // Use the file list to create lazy-loading file entries in the FS
        // I am in awe that this works.
        paths.forEach((file) => {
          createKnownLazyFile(`${file}`, new URL(`./filesystem${file}`, import.meta.url).href, file_sizes[file])
        })
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

    worker.onmessage = async ({ data: { program, canvas, stop, buttons, pause, file, files, debug } }) => {
      if (typeof buttons !== 'undefined') {
        if (worker.debug) console.log(`WORKER: Got buttons`)
        worker.input = buttons
        return
      }

      if (typeof debug !== 'undefined') {
        worker.debug = debug
      }

      if (canvas) {
        // Received but unused: the host still transfers a canvas (it doubles as a
        // host-side "running" sentinel), but the worker no longer draws to it —
        // frames go straight to the host via send_frame(). (Host-side canvas can
        // be removed as a follow-up.)
        worker.canvas = canvas
        if (worker.debug) console.log(`WORKER: Got canvas ${worker.canvas.width}x${worker.canvas.height}`)
      }

      // Inject user files into the WASM FS before the program runs
      if (files && files.length) {
        for (const f of files) {
          try {
            mkdir_recursive(dirname(f.name))
            mp.FS.createDataFile(null, f.name, f.content, true, true)
          } catch (_) {}
        }
      }

      if (program) {
        if (worker.debug) console.log(`WORKER: Got program`)
        await mp.runPython(`import badgeware`)

        // Arm execution *before* running the user program. A program may block
        // in its own `while True:` here (never returning) or fall through to the
        // `_update(update)` loop below; in both cases the WASM module's
        // cooperative pause is gated on `worker.running`, so it must be set now
        // for either path to be pausable. Posting `running` starts the host's
        // visibility observer, which drives `worker.paused` via pause/resume.
        worker.running = true
        worker.postMessage({ running: true })

        try {
          await mp.runPython(program)
        } catch (error) {
          const msg = error.message ?? String(error)
          try {
            await mp.runPython(`badgeware.fatal_error("Error!", ${JSON.stringify(msg)})`)
          } catch (_) {
            worker.postMessage({stdout: msg})
          }
          worker.paused = true
          return
        }

        // The program returned (it didn't block), so drive the frame loop.
        worker.main = mp.runPython(`
try:
    while True:
        _update(update)
except NameError:
    pass
`)
        await worker.main
      }

      // Allow the host to request the worker download a file to MicroPython's
      // virtual filesystem, or create one with the supplied content.
      if (file) {
        if (file.url) {
          if (worker.debug) console.log(`WORKER: Fetching file ${file.name}`);
          await fetch(file.url)
            .then(async (response) => {
              if(response.ok) {
                let data = new Uint8ClampedArray(await response.arrayBuffer());
                mp.FS.createDataFile(null, file.name, data, true, true);
                if (worker.debug) console.log(`Saving /${name}.py`);
              }
            })
            .catch((err) => { if (worker.debug) console.log(err) });
        }
        if (file.code) {
          if (worker.debug) console.log(`WORKER: Saving file ${file.name}`);
          mkdir_recursive(dirname(file.name))
          mp.FS.createDataFile(null, file.name, file.code, true, true);
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
        worker.paused = true
        worker.running = false
      }
    }

    // Print a banner matching the hardware REPL, e.g.
    // "MicroPython 1.28.0; Pimoroni Tufty 2350 with RP2350"
    mp.runPython(`import platform, sys
__version__ = platform.platform().split("-")[1]
print(f"MicroPython {__version__}; {sys.implementation._machine}")`)
    worker.postMessage({ ready: true })
  })

})