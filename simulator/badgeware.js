
const _simulatorBase = new URL('.', document.currentScript.src).href;

const BadgewareSimulator = async (target) => {
    let simulator = {
        target:        target,
        micropython:   null,
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
        Ask the simulator to stop and terminate the web worker running it.
        This way we get a fully clean slate, and/or can interrupt a stuck process.
    */
    simulator.stop = async () => {
        if(simulator.micropython !== null) {
            // Ask MicroPython to stop
            debug_log("HOST: Stopping existing process...")
            await simulator.micropython.postMessage({stop: true})

            // Terminate the web worker
            // TODO: give it time to shut down cleanly?
            simulator.micropython.terminate()
            simulator.micropython = null
        }
        await simulator.caselights([0, 0, 0, 0])
    }

    /*
        Ask the simulator to run some code.
    */
    simulator.run = async (code, userFiles = []) => {
        // Stop any old workers
        await simulator.stop()

        // No 2D canvas: the badge screen is rendered by the 3D view (badge3d.js)
        // from frame buffers the worker pushes via send_frame(), and keyboard
        // input is handled on the 3D canvas. Nothing to create or transfer here.

        // Create an observer for pausing/resuming our simulators as they are
        // scrolled out of and into view.
        simulator.observer = new IntersectionObserver(async (entries) => {
            if(entries[0].isIntersecting === true) {
                await simulator.resume()
            } else {
                await simulator.pause()
            }
        }, { threshold: [0] })

        simulator.micropython = new Worker(_simulatorBase + 'micropython.worker.js?v=2', { type: "module" })

        debug_log("HOST: Running MicroPython code from editor...")
        simulator.micropython.onmessage = async ({ data: { stdout, ready, running, caselights, frame } }) => {

            if (frame !== undefined) {
                // A fresh framebuffer for the 3D screen texture. Keep this fast —
                // it fires on every flip. Default handler is a no-op.
                simulator.onframe(frame)
                return
            }

            if (ready){
                // Worker is ready — hand it the program to run.
                await simulator.micropython.postMessage({program: code, debug: simulator.debug, files: userFiles})
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