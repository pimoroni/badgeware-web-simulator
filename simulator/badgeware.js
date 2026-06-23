
const _simulatorBase = new URL('.', document.currentScript.src).href;

const BadgewareSimulator = async (target) => {
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
        debug:         target.getAttribute("debug") && target.getAttribute("debug").toLowerCase() == "true",
        dom_stdout:    null
    }

    const debug_log = (message) => {
        if(!simulator.debug) return
        console.log(`DEBUG: ${message}`)
    }

    // Append a stdout textarea (for debugging)
    if(target.classList.contains("stdout")) {
        simulator.dom_stdout = document.createElement("textarea")
        simulator.dom_stdout.readOnly = true
        target.appendChild(simulator.dom_stdout)
    }

    // Keyboard input is handled by the 3D badge canvas (badge3d.js), which posts
    // { buttons } to the worker directly — no key handling is needed here.

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
                // Run when the worker is running our code
                simulator.observer.observe(simulator.target)

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