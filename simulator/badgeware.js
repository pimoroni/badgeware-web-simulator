
const _simulatorBase = new URL('.', document.currentScript.src).href;

// `target` is optional: embeds pass their <figure> (for debug/stdout attributes
// and scroll pause/resume); the main app drives the simulator headlessly and
// passes nothing.
const BadgewareSimulator = async (target = null) => {
    let simulator = {
        target:        target,
        micropython:   null,
        program:       null,   // last program requested (re-run on hard reset)
        files:         [],      // user files accompanying that program
        canvas:        null,
        buttons:       0,
        BUTTON_UP:     0b000010,
        BUTTON_DOWN:   0b000001,
        BUTTON_LEFT:   0b010000,
        BUTTON_RIGHT:  0b000100,
        BUTTON_SELECT: 0b001000,
        BUTTON_HOME:   0b100000,
        debug:         target?.getAttribute("debug")?.toLowerCase() === "true",
        dom_stdout:    null
    }

    const debug_log = (message) => {
        if(!simulator.debug) return
        console.log(`DEBUG: ${message}`)
    }

    // Keyboard input is handled by the host: the 3D badge canvas (badge3d.js) or
    // an embed's 2D canvas (attachBadgeKeys below) posts { buttons } to the worker.

    simulator.resume = async () => {
        if(simulator.micropython) {
            debug_log(`HOST: Asking worker to resume.`)
            await simulator.micropython.postMessage({pause: false})
        }
    }

    simulator.pause = async () => {
        if(simulator.micropython) {
            debug_log(`HOST: Asking worker to pause.`)
            await simulator.micropython.postMessage({pause: true})
        }
    }

    /*
        Fetch a file from "url" into the simulator's virtual filesystem at "path"
    */
    simulator.fetch_file = async (url, path) => {
        if(simulator.micropython) {
            await simulator.micropython.postMessage({file: {url: url, name: path}})
        }
    }
    /*
        Create a file with contents "code" into the simulator's filesystem at "path"
    */
    simulator.create_file = async (code, path) => {
        if(simulator.micropython) {
            await simulator.micropython.postMessage({file: {code: code, name: path}})
        }
    }

    /*
        Spawn the web worker (once) and wire up its message handling. The worker
        is kept alive across runs so we can restart a script in place rather than
        rebooting the whole MicroPython instance every time.
    */
    const createWorker = () => {
        // Create an observer for pausing/resuming our simulators as they are
        // scrolled out of and into view.
        simulator.observer = new IntersectionObserver(async (entries) => {
            if(entries[0].isIntersecting === true) {
                await simulator.resume()
            } else {
                await simulator.pause()
            }
        }, { threshold: [0] })

        const worker = new Worker(_simulatorBase + 'micropython.worker.js?v=2', { type: "module" })
        simulator.micropython = worker

        worker.onmessage = async ({ data: { stdout, ready, running, caselights, frame, stuck } }) => {

            if (frame !== undefined) {
                // A fresh framebuffer for the 3D screen texture. Keep this fast —
                // it fires on every flip. Default handler is a no-op.
                simulator.onframe(frame)
                return
            }

            if (stuck) {
                // The worker couldn't interrupt the running program (a stuck
                // native call). Fall back to a hard reset: terminate and respawn,
                // then re-run whatever program was last requested.
                debug_log("HOST: Worker stuck; terminating and respawning.")
                worker.terminate()
                if (simulator.micropython === worker) simulator.micropython = null
                if (simulator.program !== null) {
                    await simulator.run(simulator.program, simulator.files)
                }
                return
            }

            if (ready){
                // Worker is ready — hand it the program to run (if any).
                if (simulator.program !== null) {
                    await worker.postMessage({program: simulator.program, debug: simulator.debug, files: simulator.files})
                }
                return
            }

            if (running) {
                // Run when the worker is running our code. Without a target
                // element there's nothing to observe (the main app has no
                // scroll-to-pause behaviour).
                if (simulator.target) simulator.observer.observe(simulator.target)

                return
            }

            if (stdout) {
                // Run when the worker sends us some stdout text
                // eg: print() called in MicroPython
                debug_log("HOST: stdout.")
                debug_log(stdout)
                await simulator.stdout(stdout)
                return
            }

            if (caselights !== undefined) {
                await simulator.caselights(caselights)
                return
            }

            debug_log("HOST: Unhandled message.")
        }
    }

    /*
        Ask the running program to stop, in place, leaving the worker alive and
        idle (interrupt + soft reset). Use simulator.terminate() for a full
        teardown. If the worker can't stop the program it self-reports {stuck}
        and we hard-reset it.
    */
    simulator.stop = async () => {
        simulator.program = null
        if(simulator.micropython !== null) {
            debug_log("HOST: Stopping running program (in place)...")
            await simulator.micropython.postMessage({stop: true})
        }
        await simulator.caselights([0, 0, 0, 0])
    }

    /*
        Tear the worker down completely (new instance next run). Most stops keep
        the worker alive; this is for a guaranteed clean slate.
    */
    simulator.terminate = async () => {
        simulator.program = null
        if(simulator.micropython !== null) {
            simulator.micropython.terminate()
            simulator.micropython = null
        }
        if(simulator.observer) {
            simulator.observer.disconnect()
            simulator.observer = null
        }
        await simulator.caselights([0, 0, 0, 0])
    }

    /*
        Ask the simulator to run some code. Reuses the live worker when one
        exists (it interrupts the current program, soft-resets and runs the new
        one in place); otherwise spawns one.

        No 2D canvas: the badge screen is rendered by the 3D view (badge3d.js)
        from frame buffers the worker pushes via send_frame(), and keyboard input
        is handled on the 3D canvas. Nothing to create or transfer here.
    */
    simulator.run = async (code, userFiles = []) => {
        simulator.program = code
        simulator.files = userFiles

        if (simulator.micropython === null) {
            debug_log("HOST: Spawning worker and running code from editor...")
            createWorker()   // posts {ready}; onmessage then sends the program
        } else {
            debug_log("HOST: Restarting code in the live worker...")
            await simulator.micropython.postMessage({program: code, debug: simulator.debug, files: userFiles})
        }
    }

    simulator.fetch_and_run = async (url) => {
        await fetch(url)
        .then(async (response) => {
            if(response.ok) {
                let result = await response.text()
                simulator.run(result)
            }
        })
        .catch((err) => { console.log(err) });
    }

    simulator.stdout = async (text) => {
        if(simulator.dom_stdout) {
            simulator.dom_stdout.value += `${text}\n`
            simulator.dom_stdout.scrollTop = simulator.dom_stdout.scrollHeight
        }
    }

    // Called with an array of 4 floats [0.0–1.0] when badge.caselights() is called.
    // Override this in the host to drive a physical LED representation.
    simulator.caselights = async (_values) => {}

    // Called with { buffer, width, height } on every screen flip. Override in the
    // host (badge3d.js) to upload the framebuffer; default is a no-op.
    simulator.onframe = (_frame) => {}

    return simulator
}

/* ── Embedded simulators (scroll-into-view canvas demos) ───────────────────────
   Render the badge framebuffer straight into a plain 2D <canvas> — no 3D view —
   and run each embed's code only while it's scrolled into view. This lets a demo
   or docs page show many examples at once, all backed by the same badgeware.js +
   wasm build: at most the on-screen few are actually executing at any moment.

   Markup (no CSS classes needed — we target the `code` attribute):
     <figure code="examples/mandelbrot.py" stdout="true" debug="true"></figure> */

// Paint one worker frame into a canvas. The canvas's internal resolution tracks
// the frame size (160x120 LORES or 320x240 HIRES); the page's CSS scales the
// element up, so set `image-rendering: pixelated` there for crisp pixels.
function badgewareCanvasPainter(canvas) {
    const ctx = canvas.getContext("2d")
    return ({ buffer, width, height }) => {
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width
            canvas.height = height
        }
        ctx.putImageData(new ImageData(new Uint8ClampedArray(buffer), width, height), 0, 0)
    }
}

// Route keyboard input from a focused element to a simulator as badge button
// presses: arrows = D-pad, space = select, escape = home. The element is made
// focusable; give it a visible :focus outline in CSS so users know to click it
// before typing. (badge3d.js wires the 3D canvas the same way for the main app.)
function attachBadgeKeys(simulator, element) {
    const keyMap = {
        ArrowUp:    simulator.BUTTON_UP,
        ArrowDown:  simulator.BUTTON_DOWN,
        ArrowLeft:  simulator.BUTTON_LEFT,
        ArrowRight: simulator.BUTTON_RIGHT,
        " ":        simulator.BUTTON_SELECT,
        Escape:     simulator.BUTTON_HOME,
    }
    element.tabIndex = 0
    const send = (key, down) => {
        const btn = keyMap[key]
        if (!btn || !simulator.micropython) return false
        if (down) simulator.buttons |= btn
        else      simulator.buttons &= ~btn
        simulator.micropython.postMessage({ buttons: simulator.buttons })
        return true
    }
    element.addEventListener("keydown", (ev) => { if (send(ev.key, true))  ev.preventDefault() })
    element.addEventListener("keyup",   (ev) => { if (send(ev.key, false)) ev.preventDefault() })
}

// Wire a single <figure code="…"> embed: build its canvas (+ optional stdout
// log), fetch its code, and lazily run it the first time it scrolls into view.
// After that first run, the per-worker IntersectionObserver inside
// BadgewareSimulator takes over pause/resume as the figure leaves and re-enters
// the viewport, so off-screen embeds stop consuming CPU.
const initBadgewareEmbed = async (figure) => {
    const codeURL = figure.getAttribute("code")
    if (!codeURL) return null

    const canvas = document.createElement("canvas")
    canvas.width = 320
    canvas.height = 240
    figure.prepend(canvas)

    const simulator = await BadgewareSimulator(figure)
    simulator.onframe = badgewareCanvasPainter(canvas)
    attachBadgeKeys(simulator, canvas)   // click the canvas to focus, then arrows/space/escape

    // stdout="true" → append a read-only log that the default stdout writer feeds.
    if ((figure.getAttribute("stdout") || "").toLowerCase() === "true") {
        const log = document.createElement("textarea")
        log.readOnly = true
        figure.appendChild(log)
        simulator.dom_stdout = log
    }

    let code
    try {
        const response = await fetch(codeURL)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        code = await response.text()
    } catch (err) {
        console.error(`badgeware embed: could not load ${codeURL}:`, err)
        return simulator
    }

    // Run on first reveal; BadgewareSimulator's own observer handles later scrolls.
    let started = false
    const reveal = new IntersectionObserver((entries) => {
        if (!started && entries.some((e) => e.isIntersecting)) {
            started = true
            reveal.disconnect()
            simulator.run(code)
        }
    }, { threshold: [0] })
    reveal.observe(figure)

    return simulator
}

// Scan a root (default: the whole document) for <figure code="…"> embeds and wire
// each one. Returns a promise resolving to the array of created simulators.
const initBadgewareEmbeds = (root = document) =>
    Promise.all([...root.querySelectorAll("figure[code]")].map(initBadgewareEmbed))