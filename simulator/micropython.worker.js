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

import("/simulator/micropython.mjs").then((mp_mjs) => {
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

    // Fetch JSON Manifest generated with "python3 filesystem.py > filesystem.json"
    await fetch("/simulator/filesystem.json").then(async (response) => {
      if(response.ok) {
        // Pray we don't have a parsing error...
        const lazy_files = (await response.json())["files"]

        // Get a unique list of directories we need to create from the above
        const directories = [... new Set(lazy_files.map(dirname))]

        // Iterate through directories and create each node in turn
        directories.forEach(mkdir_recursive);

        // Use the file list to create lazy-loading file entries in the FS
        // I am in awe that this works.
        lazy_files.forEach((file) => {
          mp.FS.createLazyFile("", `${file}`, `/simulator/filesystem${file}`, true, false)
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

    // Handle a flip from a 160x120x4 byte buffer
    worker.flip_lores = (data) => {
      worker.lores_canvas_image.data.set(data);
      worker.lores_canvas_context.putImageData(worker.lores_canvas_image, 0, 0);
      worker.canvas_context.drawImage(worker.lores_canvas, 0, 0, 320, 240);
      worker.update_caselights();
    }

    // Forward case-light values [v0..v3] (0.0–1.0) to the host
    worker.set_case_lights = (v0, v1, v2, v3) => {
      worker.postMessage({ caselights: [v0, v1, v2, v3] });
    }

    // Handle a flip from a 320x240x4 byte buffer
    worker.flip_hires = (data) => {
      worker.canvas_image.data.set(data);
      worker.canvas_context.putImageData(worker.canvas_image, 0, 0);
      worker.update_caselights();
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
        worker.canvas = canvas
        if (worker.debug) console.log(`WORKER: Got canvas ${worker.canvas.width}x${worker.canvas.height}`)

        // 320x240 for mode(HIRES)
        worker.canvas_context = worker.canvas.getContext('2d')
        worker.canvas_context.imageSmoothingEnabled = false
        worker.canvas_image = worker.canvas_context.getImageData(0, 0, worker.canvas.width, worker.canvas.height)

        // 160x120 for mode(LORES) - create an extra offscreen canvas
        // we'll draw to this at 160x120 and then use drawImage to hires canvas
        worker.lores_canvas = new OffscreenCanvas(160, 120)
        worker.lores_canvas_context = worker.lores_canvas.getContext('2d')
        worker.canvas_context.imageSmoothingEnabled = false
        worker.lores_canvas_image = worker.lores_canvas_context.getImageData(0, 0, 160, 120)
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