const worker = self

WorkerGlobalScope.worker = worker

worker.running = false
worker.paused = true
worker.input = 0
worker.debug = false

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

    // Handle a flip from a 160x120x4 byte buffer
    worker.flip_lores = (data) => {
      worker.lores_canvas_image.data.set(data);
      worker.lores_canvas_context.putImageData(worker.lores_canvas_image, 0, 0);
      worker.canvas_context.drawImage(worker.lores_canvas, 0, 0, 320, 240);
    }

    // Handle a flip from a 320x240x4 byte buffer
    worker.flip_hires = (data) => {
      worker.canvas_image.data.set(data);
      worker.canvas_context.putImageData(worker.canvas_image, 0, 0);
    }

    // Use requestAnimationFrame to pace the update loop, since this will
    // trigger a draw to the canvas element
    worker.call_user_update_function = async (timestamp) => {
      if (!worker.paused) {
        await mp.runPython(`
try:
    _update(update)
except NameError:
    pass
`)
      }
      if (worker.running) {
        requestAnimationFrame(worker.call_user_update_function)
      }
    }

    worker.onmessage = async ({ data: { program, canvas, stop, buttons, pause, file, debug } }) => {
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

      if (program) {
        if (worker.debug) console.log(`WORKER: Got program`)
        mp.runPython(`import badgeware`)
        try {
          mp.runPython(program)
        } catch (error) {
          mp.runPython(`badgeware.fatal_error("Error loading code...", """${error}""")`)
          worker.running = true
          worker.paused = true
          return
        }
        worker.running = true
        worker.paused = true
        await mp.runPython(`
try:
    _update(update)
except NameError:
    pass
`)
        requestAnimationFrame(worker.call_user_update_function)
        worker.postMessage({ running: true })
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

    // Prints "MicroPython 1.26.0" (or similar) to stdout on startup
    // Not strictly necessary, but useful.
    mp.runPython(`import platform
__version__ = platform.platform().split("-")[1]
print(f"MicroPython {__version__}")`)
    worker.postMessage({ ready: true })
  })

})