
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

    const sendInput = async (buttons) => {
        if(simulator.micropython) {
            debug_log(`HOST: Sending input to worker. ${buttons}`)
            await simulator.micropython.postMessage({buttons: buttons})
        }
    }

    const getButton = (keycode) => {{
        switch(keycode) {
            case 38: return simulator.BUTTON_UP     // Arrow keys up
            case 40: return simulator.BUTTON_DOWN   // Arrow keys down
            case 37: return simulator.BUTTON_LEFT   // Arrow keys left
            case 39: return simulator.BUTTON_RIGHT  // Arrow keys right
            case 32: return simulator.BUTTON_SELECT // Spacebar
            case 27: return simulator.BUTTON_HOME   // Escape
            default: return 0
        }
    }}

    const onkeydown = async (ev) => {
        let button = getButton(ev.keyCode)
        if (button == 0) return
        simulator.buttons |= button
        await sendInput(simulator.buttons)
        ev.preventDefault()
    }

    const onkeyup = async (ev) => {
        let button = getButton(ev.keyCode)
        if (button == 0) return
        simulator.buttons &= ~button
        await sendInput(simulator.buttons)
        ev.preventDefault()
    }

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
        // Remove the canvas element. We need a new one for each Worker.
        [...target.querySelectorAll("canvas")].forEach((node) => {
            target.removeChild(node)
        })
        simulator.canvas = null
        await simulator.caselights([0, 0, 0, 0])
    }

    /*
        Ask the simulator to run some code.
    */
    simulator.run = async (code, userFiles = []) => {
        // Stop any old workers
        await simulator.stop()

        // Create a new canvas element
        // We can only "transferControlToOffscreen" a canvas once.
        const canvas = document.createElement("canvas")
        canvas.width = 320
        canvas.height = 240
        canvas.tabIndex = 1
        target.appendChild(canvas)
        simulator.canvas = canvas

        // Set up keyboard input
        canvas.addEventListener("keydown", onkeydown, true)
        canvas.addEventListener("keyup", onkeyup, true)

        // Optional, pause/resume on blur/focus
        // canvas.addEventListener("focus", async (ev) => {await simulator.resume()}, true)
        // canvas.addEventListener("blur", async (ev) => {await simulator.pause()}, true)

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
        simulator.micropython.onmessage = async ({ data: { stdout, ready, running, caselights } }) => {

            if (ready){
                // Run when the worker is ready to accept a canvas/code
                const offscreen_canvas = canvas.transferControlToOffscreen()
                await simulator.micropython.postMessage({canvas: offscreen_canvas, program: code, debug: simulator.debug, files: userFiles}, [offscreen_canvas])
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

    return simulator
}