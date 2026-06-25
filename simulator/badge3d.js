/* -- 3D badge display ------------------------------------------------------ */
const _badge3dBase = new URL('.', import.meta.url).href;

// wrap is the container element the renderer mounts into (boot.js injects it).
export function initBadge3D(simulator, appendOut, wrap) {
  let three = null, screenMesh = null, screenTex = null;
  let screenLive = false;   // true while the live simulator is driving the screen
  let rotateView = () => {};  // assigned once the scene is ready (spin in 180° steps)

  // Newest framebuffer pushed from the worker, and whether it still needs an
  // upload. The worker sends raw RGBA bytes per flip (see micropython.worker.js);
  // we feed them to a DataTexture rather than re-reading a 2D canvas every frame
  // — Safari's CanvasTexture upload path cost ~16ms/frame and capped the view to
  // ~10fps. DataTexture's gl.texImage2D(ArrayBufferView) is a direct upload, and
  // we only touch the GPU when a fresh frame has actually arrived.
  let latestFrame = null;   // { buffer: ArrayBuffer, width, height }
  let frameDirty  = false;  // a frame is waiting to be uploaded
  let texW = 0, texH = 0;   // current DataTexture dimensions
  let renderDirty = true;   // render-on-demand: one-shot "something changed, redraw"

  // A 1×1 near-black texture used as the screen's emissive map when there's no
  // live frame — so a not-yet-started or stopped panel reads as a powered-down
  // LCD instead of flashing solid white (emissive with no map = uniform white).
  let offTex = null;
  function offTexture() {
    if (!offTex && three) {
      offTex = new three.DataTexture(new Uint8Array([6, 6, 9, 255]), 1, 1, three.RGBAFormat, three.UnsignedByteType);
      offTex.colorSpace = three.SRGBColorSpace;
      offTex.needsUpdate = true;
    }
    return offTex;
  }

  // Configure the screen mesh material; the picture is filled in by uploadFrame().
  function applyCanvasToScreen() {
    if (!three || !screenMesh) return;
    // Standard material driven by the emissive channel: the diffuse is black so
    // scene lights can't lift the blacks, and the picture comes from the
    // emissive map — slightly over 1.0 so the panel reads as gently self-lit.
    if (!(screenMesh.material instanceof three.MeshStandardMaterial)) {
      screenMesh.material = new three.MeshStandardMaterial();
    }
    const m = screenMesh.material;
    m.color.setRGB(0, 0, 0);
    m.metalness         = 0;
    m.roughness         = 1;
    m.map               = null;
    m.emissive.setRGB(1, 1, 1);
    m.emissiveIntensity = 1.5;   // slight glow on top of the displayed image
    m.toneMapped        = false; // the screen is the literal framebuffer - don't tone-map the app's pixels
    // Near-black until the first frame lands, so the panel never flashes white.
    m.emissiveMap       = screenTex || offTexture();
    m.needsUpdate       = true;
    screenLive  = true;
    frameDirty  = latestFrame !== null;  // upload whatever we already have
    renderDirty = true;                  // material changed — redraw
  }

  // Upload the newest worker frame into the screen's DataTexture (cheap, direct).
  // Called from the render loop; returns true if a new frame was uploaded.
  function uploadFrame() {
    if (!screenLive || !frameDirty || !latestFrame) return false;
    frameDirty = false;
    const { buffer, width, height } = latestFrame;
    const data = new Uint8Array(buffer);
    if (!screenTex || texW !== width || texH !== height) {
      if (screenTex) screenTex.dispose();
      screenTex = new three.DataTexture(data, width, height, three.RGBAFormat, three.UnsignedByteType);
      screenTex.magFilter  = three.NearestFilter;
      screenTex.minFilter  = three.NearestFilter;
      screenTex.colorSpace = three.SRGBColorSpace;
      texW = width; texH = height;
      // Swap the emissive map to the new texture. Don't set material.needsUpdate
      // — emissiveMap is already non-null (the off-texture from applyCanvasToScreen),
      // so this is a texture→texture swap with no shader-define change. Setting
      // needsUpdate here would force a program *recompile* on the first frame,
      // undoing compileAsync's precompile (~95ms getProgramParameter in the loop).
      if (screenMesh && screenMesh.material) {
        screenMesh.material.emissiveMap = screenTex;
      }
    } else {
      screenTex.image.data = data;
    }
    screenTex.needsUpdate = true;
    return true;
  }

  // Stop driving the screen. Safe to call before the worker is torn down — the
  // DataTexture owns its own buffer, so there's no destroyed-canvas to upload.
  function pauseScreen() {
    screenLive  = false;
    frameDirty  = false;
    latestFrame = null;
    if (screenTex) { screenTex.dispose(); screenTex = null; }
    texW = texH = 0;
    if (screenMesh && screenMesh.material) {
      // Show the near-black "off" panel rather than a blank white screen.
      const m = screenMesh.material;
      m.map = null;
      m.color.setRGB(0, 0, 0);
      m.emissive.setRGB(1, 1, 1);
      m.emissiveIntensity = 1.5;
      m.emissiveMap = offTexture();
      m.toneMapped = false;
      m.needsUpdate = true;
    }
    renderDirty = true;   // panel went to "off" — redraw once
  }

  // The worker pushes a fresh framebuffer on every flip; just stash it.
  simulator.onframe = (frame) => {
    latestFrame = frame;
    frameDirty  = true;
  };

  (async () => {
    try {
      const THREE              = await import('three');
      const { GLTFLoader }     = await import('three/addons/loaders/GLTFLoader.js');
      // The badge model is meshopt-compressed (EXT_meshopt_compression) — the
      // decoder is a small (~30KB) module from the same three addons CDN.
      const { MeshoptDecoder }  = await import('three/addons/libs/meshopt_decoder.module.js');
      const { HorizontalBlurShader } = await import('three/addons/shaders/HorizontalBlurShader.js');
      const { VerticalBlurShader }   = await import('three/addons/shaders/VerticalBlurShader.js');
      three = THREE;

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      // Skip three.js's per-program getProgramInfoLog() check — it forces a
      // synchronous GPU sync as each material first compiles (~110ms at startup
      // in the capture). These are stock three.js/standard-material shaders, so
      // they won't fail; we only lose dev-time shader error logging.
      renderer.debug.checkShaderErrors = false;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(wrap.clientWidth, wrap.clientHeight);
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      // Tone mapping: without it the case clips/overexposes (lighting tweaks then do
      // nothing and the surface washes out, hiding the normal-map detail). Neutral
      // (Khronos PBR Neutral) tames the highlights while keeping the orange's hue and
      // saturation - better for an authentic product look than ACES (which desats).
      // Exposure is the master brightness knob; the screen opts out (toneMapped=false
      // in applyCanvasToScreen) so the displayed pixels stay colour-accurate.
      renderer.toneMapping = THREE.NeutralToneMapping;
      renderer.toneMappingExposure = 1.0;
      wrap.appendChild(renderer.domElement);

      const scene  = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(22, wrap.clientWidth / wrap.clientHeight, 0.001, 10);

      /* View — the model spins around its Y axis in 180° steps. No free orbit;
         rotateView(±1) nudges the target angle and the render loop eases to it. */
      const FRONT_Y = -0.2;            // slight tilt that reads as "front"
      let viewNode    = null;          // the tufty node we rotate
      let viewTargetY = FRONT_Y;       // angle we're easing toward
      let contactShadow = null;        // soft contact-shadow system (built on load)
      let shadowDirty   = false;       // re-render the shadow next frame (badge silhouette changed)

      // Exposed so the host can wire up the spin buttons (dir: -1 or +1).
      rotateView = (dir) => {
        if (zoomed) focusScreen(false);   // spinning drops back to the default view
        viewTargetY += Math.sign(dir || 1) * Math.PI;
        shadowDirty = true;               // silhouette will change as it spins
      };

      /* -- Double-click the screen to zoom in / out --------------------------
         A "home" pose is captured at load; the render loop eases the camera
         between home and a face-on framing of the screen. */
      let   screenFocusReady = false;
      let   zoomed           = false;
      let   camEasing        = false;
      let   gestureTapTimer  = null;   // pending touch tap→B pulse (gesture D-pad, below)
      const homePos     = new THREE.Vector3();
      const homeLook    = new THREE.Vector3();
      const camPosGoal  = new THREE.Vector3();
      const camLookGoal = new THREE.Vector3();
      const camLookNow  = new THREE.Vector3();

      // Camera pose that frames just the screen, dead-on along its normal.
      function framedScreenPose() {
        const center = new THREE.Box3().setFromObject(screenMesh).getCenter(new THREE.Vector3());
        const normal = new THREE.Vector3(0, 1, 0).transformDirection(screenMesh.matrixWorld).normalize();
        screenMesh.geometry.computeBoundingBox();
        const size = screenMesh.geometry.boundingBox.getSize(new THREE.Vector3());
        const ws   = screenMesh.getWorldScale(new THREE.Vector3());
        // Screen lies in its local XZ plane: X = width, Z = height, Y = normal.
        const halfTan = Math.tan((camera.fov * Math.PI / 180) / 2);
        const distH = (size.z * ws.z / 2) / halfTan;                   // fit height
        const distW = (size.x * ws.x / 2) / (halfTan * camera.aspect); // fit width
        const dist  = Math.max(distH, distW) * 1;                   // > 1 gives a small margin
        return { pos: center.clone().addScaledVector(normal, dist), look: center };
      }

      function focusScreen(on) {
        if (!screenFocusReady) return;
        // Any zoom toggle cancels a pending tap→B, so a double-tap that zooms out
        // never leaves a stray B in flight (see the touch gesture handlers below).
        if (gestureTapTimer) { clearTimeout(gestureTapTimer); gestureTapTimer = null; }
        if (on) {
          const { pos, look } = framedScreenPose();
          camPosGoal.copy(pos);
          camLookGoal.copy(look);
        } else {
          camPosGoal.copy(homePos);
          camLookGoal.copy(homeLook);
        }
        zoomed    = on;
        camEasing = true;
        // Reel the badge back inside its container (CSS transitions the margins)
        // so the framed screen doesn't spill over the toolbar / OUTPUT box.
        wrap.parentElement.classList.toggle('screen-zoomed', on);
      }

      /* -- Badge buttons: one source of truth -------------------------------
         BTN names each button's bitmask, taken from the simulator (which owns the
         wire protocol the worker reads via simulator.buttons) so there's a single
         canonical table - reused by the key map, the button raycast, the touch
         D-pad, the press markers and the press animation. A = left face button,
         B = select, C = right face button, plus the Up/Down edge and Home.
         setButtons() is the ONE place that mutates the mask and notifies the
         worker; every input path goes through it. */
      const BTN = {
        a:  simulator.BUTTON_LEFT,  b:    simulator.BUTTON_SELECT, c:    simulator.BUTTON_RIGHT,
        up: simulator.BUTTON_UP,    down: simulator.BUTTON_DOWN,   home: simulator.BUTTON_HOME,
      };
      function setButtons(mask, down) {
        if (!simulator.micropython) return;
        if (down) simulator.buttons |= mask;
        else      simulator.buttons &= ~mask;
        simulator.micropython.postMessage({ buttons: simulator.buttons });
      }

      /* Forward badge key presses from the focused 3D canvas: arrows = D-pad / A /
         C, space = B, escape = Home. */
      const keyMap = {
        ArrowUp: BTN.up, ArrowDown: BTN.down, ArrowLeft: BTN.a, ArrowRight: BTN.c,
        ' ': BTN.b, Escape: BTN.home,
      };
      renderer.domElement.tabIndex = 0;
      const onKey = (down) => (ev) => {
        const mask = keyMap[ev.key];
        if (!mask) return;
        setButtons(mask, down);
        ev.preventDefault();
      };
      renderer.domElement.addEventListener('keydown', onKey(true));
      renderer.domElement.addEventListener('keyup',   onKey(false));

      /* Lighting. Brightness comes mostly from ambient + fill: the screen's diffuse
         is black (its picture is emissive), so neither can glare it — only the case
         and components brighten. The strong directional key is left as-is; bumping it
         would put a specular hotspot on the screen. */
      // Ambient kept fairly low so shadows/blacks stay deep and the case colour
      // reads saturated; the key light does the lifting. (Higher ambient washes the
      // badge out and desaturates the orange - tweak these two to taste.)
      scene.add(new THREE.AmbientLight(0xffffff, 0.7));
      // Key + fill live in a rig that orbits the badge as it flips. The moulded-case
      // detail reads best with the light swung round and raised when the back faces
      // us, so the render loop tweens the rig between these front/back endpoints
      // (azimuth + elevation, degrees) by how back-facing the badge currently is.
      const LIGHT_ORBIT = [275, 325];   // front, back azimuth
      const LIGHT_ELEV  = [20, 70];     // front, back elevation
      const lightRig = new THREE.Group();
      scene.add(lightRig);
      const keyLight = new THREE.DirectionalLight(0xffffff, 2.5);
      keyLight.position.set(0.4, 0.8, 1);
      const fillLight = new THREE.DirectionalLight(0x8090d0, 0.6);
      fillLight.position.set(-0.6, 0.2, 0.3);
      lightRig.add(keyLight, fillLight);

      /* -- Case look tunables --------------------------------------------------
         CASE_COLOR: the orange tint (multiplies the GLB albedo). Drop the green
           channel toward red for a deeper look, raise toward ~0.42 for factory orange.
         CASE_FROST: roughness of the translucent back shell. It's a transmission
           material, so this is the frosted-glass blur - the GLB ships it near-clear
           (0.2 = glossy); raise toward ~0.6 for more frost. The normal map still adds
           the fine surface texture on top.
         CASE_SPECULAR: strength of the surface specular highlight (0..1), decoupled
           from CASE_FROST. roughness drives BOTH the frost blur and the gloss, so a
           low CASE_FROST leaves a sharp glossy highlight; dial this down for a matte,
           non-shiny plastic surface without losing the frost.
         CASE_NORMAL: strength of the shell's own GLB normal map (the moulded-plastic
           surface texture/definition). Note it's low-res, so cranking it hard starts
           to read as blocky/faceted. (Tune with exposure.) */
      const CASE_COLOR    = [1.0, 0.42, 0.0];
      const CASE_FROST    = 0.25;
      const CASE_SPECULAR = 0.3;
      const CASE_NORMAL   = 1.0;

      /* Button raycasting */
      const allHitMeshes = [];
      const raycaster    = new THREE.Raycaster();
      let   heldMask     = 0;
      // Button anchor markers baked into the GLB ({ mask, node }). A pointer hit is
      // assigned to the nearest marker within BUTTON_RADIUS — robust to geometry
      // changes / quantization, unlike the old hardcoded screen-local zones (kept
      // below as a fallback for GLBs without markers).
      let   buttonMarkers   = [];
      const BUTTON_RADIUS   = 0.010;  // 10 mm — buttons are ≥12 mm apart
      let   buttonAnimator  = null;
      let   ledState        = null;   // { refresh(), setLevels(values) } — case-back glow
      let   _ledSimActive   = false;  // true once MicroPython has sent caselights data
      let   sceneReady      = true;   // gate: false while the model's shaders compile

      // Drive the 3D case LEDs when badge.caselights() is called from MicroPython
      simulator.caselights = (values) => {
        _ledSimActive = true;
        renderDirty = true;   // LED levels changed — render this frame
        if (ledState) ledState.setLevels(values);
      };

      /* Real-world-metre frame from a node's WORLD axes (unit vectors, so the
         node's own scale is ignored). Button zones and LED centroids below are
         tuned in metres relative to a mesh's local origin; reading/writing them via
         the mesh's local space (worldToLocal / localToWorld) breaks the moment the
         geometry is quantized — meshopt / KHR_mesh_quantization rescales each mesh's
         local space to normalized int16 and bakes a compensating uniform scale onto
         the node. Projecting through these helpers stays correct either way. */
      const _nO = new THREE.Vector3();
      const _nX = new THREE.Vector3(), _nY = new THREE.Vector3(), _nZ = new THREE.Vector3();
      function _nodeFrame(node) {
        node.updateWorldMatrix(true, false);
        _nO.setFromMatrixPosition(node.matrixWorld);
        _nX.set(1, 0, 0).transformDirection(node.matrixWorld).normalize();
        _nY.set(0, 1, 0).transformDirection(node.matrixWorld).normalize();
        _nZ.set(0, 0, 1).transformDirection(node.matrixWorld).normalize();
      }
      // World point → node-local metres { x, y, z } along the node's own axes.
      function worldToNodeMetres(node, worldPt) {
        _nodeFrame(node);
        const d = worldPt.clone().sub(_nO);
        return { x: d.dot(_nX), y: d.dot(_nY), z: d.dot(_nZ) };
      }
      // Node-local metres → world point (replaces scale-dependent localToWorld).
      function nodeMetresToWorld(node, lp, out = new THREE.Vector3()) {
        _nodeFrame(node);
        return out.copy(_nO)
          .addScaledVector(_nX, lp.x)
          .addScaledVector(_nY, lp.y)
          .addScaledVector(_nZ, lp.z);
      }
      // As above but anchored at the mesh's WORLD bounding-box centre instead of its
      // local origin. Quantization re-centres a mesh's local origin onto its bbox
      // centre, so offsets relative to the *original* origin drift (the LED cluster
      // landed ~28 mm off). The bbox centre is geometry-derived → identical before
      // and after quantization, so offsets measured from it stay put either way.
      const _bbox = new THREE.Box3(), _bc = new THREE.Vector3();
      function meshCentreMetresToWorld(mesh, lp, out = new THREE.Vector3()) {
        _nodeFrame(mesh);
        _bbox.setFromObject(mesh).getCenter(_bc);
        return out.copy(_bc)
          .addScaledVector(_nX, lp.x)
          .addScaledVector(_nY, lp.y)
          .addScaledVector(_nZ, lp.z);
      }

      function buttonMaskAt(ev) {
        if (!screenMesh) return { mask: 0, worldPt: null };
        const rect  = renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(
          ((ev.clientX - rect.left) / rect.width)  *  2 - 1,
          ((ev.clientY - rect.top)  / rect.height) * -2 + 1,
        );
        raycaster.setFromCamera(mouse, camera);
        const hits = raycaster.intersectObjects(allHitMeshes, true);
        if (!hits.length) return { mask: 0, worldPt: null };
        const worldPt = hits[0].point.clone();

        // Preferred path: nearest baked button marker to the hit point.
        if (buttonMarkers.length) {
          let best = null, bestD = BUTTON_RADIUS;
          const wp = new THREE.Vector3();
          for (const b of buttonMarkers) {
            const d = b.node.getWorldPosition(wp).distanceTo(worldPt);
            if (d < bestD) { bestD = d; best = b; }
          }
          return best ? { mask: best.mask, worldPt } : { mask: 0, worldPt: null };
        }

        // Fallback (marker-less GLB): hardcoded screen-local zones.
        const lp = worldToNodeMetres(screenMesh, hits[0].point);
        // lp.x = left(-)/right(+), lp.z = up(-)/down(+) in screen-local space
        // Screen area x∈[-0.029,+0.029], z∈[-0.022,+0.022]
        // Ignore screen area
        if (Math.abs(lp.x) < 0.029 && lp.z < 0.022 && lp.z > -0.022) return { mask: 0, worldPt: null };
        // Right-edge panel only — constrain Z so far corners don't fire
        if (lp.x > 0.028 && lp.x < 0.045 && lp.z > -0.016 && lp.z < 0.020) {
          return { mask: lp.z < 0.005 ? BTN.up : BTN.down, worldPt };          // UP / DOWN
        }
        // Bottom button strip — constrain to centred region just below screen
        if (lp.z > 0.018 && lp.z < 0.035 && Math.abs(lp.x) < 0.028) {
          const mask = lp.x < -0.008 ? BTN.a : lp.x < +0.008 ? BTN.b : BTN.c;
          return { mask, worldPt };                                             // A / B / C
        }
        return { mask: 0, worldPt: null };
      }

      /* -- Zoomed-in touch D-pad ---------------------------------------------
         When the screen is framed there's no room to aim at the physical buttons,
         so the framed screen becomes a gamepad: swipe left/right/up/down = A/C/Up/
         Down, a single tap = B, a double-tap zooms back out. This rides on the SAME
         pointer events as the button raycast and the dblclick zoom - the input path
         that actually works on iOS - rather than a separate touch-event stream that
         fights it. A touchmove handler below default-prevents page scroll while
         zoomed so iOS can't steal a swipe (pointercancel) mid-gesture. */
      const SWIPE_MIN_PX  = 28;    // a drag shorter than this counts as a tap
      const DOUBLE_TAP_MS = 320, DOUBLE_TAP_PX = 44;
      const TAP_B_DELAY   = 250;   // ms to wait out a possible zoom-out double-tap before B
      const GESTURE_PULSE = 120;   // ms each gesture holds its button down
      let gActive = false, gStartX = 0, gStartY = 0, gLastX = 0, gLastY = 0;
      let lastTapT = 0, lastTapX = 0, lastTapY = 0, lastGestureT = 0;

      // Fire a button as a brief press→release pulse (long enough for the running
      // program to poll it), the way a discrete swipe/tap should read.
      function pulseButton(mask) {
        setButtons(mask, true);
        setTimeout(() => setButtons(mask, false), GESTURE_PULSE);
      }
      // Swipe direction → D-pad button. Left/right are the A/C face buttons.
      const swipeMask = (dx, dy) => Math.abs(dx) > Math.abs(dy)
        ? (dx < 0 ? BTN.a  : BTN.c)
        : (dy < 0 ? BTN.up : BTN.down);

      // Resolve a finished zoomed-in gesture (from pointerup). A drag = a D-pad
      // direction; a tap = B, unless it's the second of a quick double-tap, which
      // zooms back out. The tap→B is deferred so that double-tap can cancel it.
      function endGesture(x, y) {
        gActive = false;
        lastGestureT = performance.now();   // lets the dblclick handler ignore the synthetic one
        const dx = x - gStartX, dy = y - gStartY;
        if (Math.hypot(dx, dy) >= SWIPE_MIN_PX) { pulseButton(swipeMask(dx, dy)); return; }
        const t = performance.now();
        if (t - lastTapT < DOUBLE_TAP_MS &&
            Math.hypot(x - lastTapX, y - lastTapY) < DOUBLE_TAP_PX) {
          lastTapT = 0;
          if (gestureTapTimer) { clearTimeout(gestureTapTimer); gestureTapTimer = null; }
          focusScreen(false);
          return;
        }
        lastTapT = t; lastTapX = x; lastTapY = y;
        gestureTapTimer = setTimeout(() => { gestureTapTimer = null; pulseButton(BTN.b); }, TAP_B_DELAY);
      }

      // Capture-phase pointerdown so button hits are handled before anything else.
      renderer.domElement.addEventListener('pointerdown', ev => {
        if (ev.pointerType !== 'mouse' && zoomed) {
          // Zoomed-in: the framed screen is the D-pad; start tracking a swipe/tap
          // instead of a raycast button press underneath it.
          if (gestureTapTimer) { clearTimeout(gestureTapTimer); gestureTapTimer = null; }
          gActive = true;
          gStartX = gLastX = ev.clientX; gStartY = gLastY = ev.clientY;
          return;
        }
        const { mask, worldPt } = buttonMaskAt(ev);
        if (!mask) return;
        heldMask = mask;
        setButtons(mask, true);
        if (buttonAnimator) buttonAnimator.press(mask, worldPt);
        ev.stopPropagation();
      }, true);

      renderer.domElement.addEventListener('pointermove', ev => {
        if (gActive) { gLastX = ev.clientX; gLastY = ev.clientY; }
      });

      renderer.domElement.addEventListener('pointerup', ev => {
        if (gActive) { endGesture(ev.clientX, ev.clientY); return; }
        if (!heldMask) return;
        setButtons(heldMask, false);
        if (buttonAnimator) buttonAnimator.release(heldMask);
        heldMask = 0;
        ev.stopPropagation();
      }, true);

      renderer.domElement.addEventListener('pointercancel', () => {
        // iOS may cancel a pointer if it decides the drag was a page scroll; if it
        // was actually a swipe, still fire it from the last tracked position.
        if (gActive) {
          gActive = false;
          const dx = gLastX - gStartX, dy = gLastY - gStartY;
          if (Math.hypot(dx, dy) >= SWIPE_MIN_PX) { lastGestureT = performance.now(); pulseButton(swipeMask(dx, dy)); }
          return;
        }
        if (!heldMask) return;
        setButtons(heldMask, false);
        if (buttonAnimator) buttonAnimator.release(heldMask);
        heldMask = 0;
      });

      // Toggle the screen zoom from a pointer position: out when zoomed, in only
      // when the point lands on the (front-facing) screen mesh — back-face culling
      // means a hit misses when spun to the rear. Shared by the mouse double-click
      // and the touch double-tap below.
      function toggleZoomAt(ev) {
        if (!screenFocusReady) return;
        if (zoomed) { focusScreen(false); return; }
        const rect  = renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(
          ((ev.clientX - rect.left) / rect.width)  *  2 - 1,
          ((ev.clientY - rect.top)  / rect.height) * -2 + 1,
        );
        raycaster.setFromCamera(mouse, camera);
        if (raycaster.intersectObject(screenMesh, false).length) focusScreen(true);
      }

      // Double-click / double-tap toggles the zoom. The canvas keeps the default
      // touch-action so iOS still synthesises this dblclick from a double-tap (any
      // touch-action override makes Safari swallow it). Ignore the synthetic dblclick
      // that trails a zoomed-in touch gesture - the pointer handlers above already
      // dealt with that double-tap (zoom out), so this must not re-toggle.
      renderer.domElement.addEventListener('dblclick', ev => {
        if (performance.now() - lastGestureT < 700) return;
        toggleZoomAt(ev);
      });

      // The ONLY touch-event listener: while zoomed, stop a swipe from panning or
      // zooming the page so iOS doesn't cancel the pointer mid-gesture. All gesture
      // LOGIC lives in the pointer handlers above; this just locks scrolling.
      renderer.domElement.addEventListener('touchmove', (ev) => {
        if (zoomed) ev.preventDefault();
      }, { passive: false });

      /* -- Button press animation (siloed — swap out when geometry improves) --
         Approach: onBeforeCompile vertex displacement on the cap mesh(es)
         found by raycasting at each button zone, plus a screen-space ripple. */
      function initButtonAnimator(root, tuftyNode) {
        root.updateWorldMatrix(true, true);

        // Badge face outward normal in world space (= screen local +Y → world)
        const faceOut = new THREE.Vector3(0, 1, 0)
          .transformDirection(screenMesh.matrixWorld).normalize();
        const faceIn  = faceOut.clone().negate();

        // Button zone centres in screen-local space (Y=0 = on screen plane)
        const BTN_DEFS = [
          { mask: BTN.a,    slc: new THREE.Vector3(-0.018,  0,  0.023) }, // A
          { mask: BTN.b,    slc: new THREE.Vector3(  0.00,  0,  0.023) }, // B
          { mask: BTN.c,    slc: new THREE.Vector3(+0.018,  0,  0.023) }, // C
          { mask: BTN.up,   slc: new THREE.Vector3(+0.035,  0, -0.002) }, // UP
          { mask: BTN.down, slc: new THREE.Vector3(+0.035,  0, +0.010) }, // DOWN
        ];

        // Raycast from in front of each zone inward to find actual hit mesh + world point
        const btnRay = new THREE.Raycaster();
        const hitData = BTN_DEFS.map((b, idx) => {
          const worldPt = nodeMetresToWorld(screenMesh, b.slc);
          const origin  = worldPt.clone().addScaledVector(faceOut, 0.04);
          btnRay.set(origin, faceIn);
          const hits = btnRay.intersectObjects(allHitMeshes, false)
                             .filter(h => h.object !== screenMesh);
          return {
            mask:    b.mask,
            idx,
            worldPt: hits.length ? hits[0].point.clone() : worldPt.clone(),
            mesh:    hits.length ? hits[0].object : null,
          };
        });

        // Shared animation state — one slot per BTN_DEFS entry
        const pressVals = [0, 0, 0, 0, 0];
        const targets   = [0, 0, 0, 0, 0];

        // -- Ripple pool (visual "dash of 3") -----------------------------
        const RIPPLE_DUR  = 0.42;
        const ripplePool  = Array.from({ length: 4 }, () => {
          const mat  = new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0,
            side: THREE.DoubleSide, depthWrite: false,
          });
          const mesh = new THREE.Mesh(new THREE.RingGeometry(0.003, 0.007, 32), mat);
          mesh.visible = false;
          scene.add(mesh);
          return { mesh, t: -1 };
        });

        const _ringNormal = new THREE.Vector3(0, 0, 1);
        function spawnRipple(worldPt) {
          const r = ripplePool.find(r => r.t < 0)
                 || ripplePool.reduce((a, b) => a.t > b.t ? a : b);
          r.mesh.position.copy(worldPt).addScaledVector(faceOut, 0.0003);
          r.mesh.quaternion.setFromUnitVectors(_ringNormal, faceOut);
          r.mesh.scale.setScalar(0.15);
          r.mesh.material.opacity = 0.55;
          r.mesh.visible = true;
          r.t = 0;
        }

        // -- Public API ----------------------------------------------------
        const PRESS_SPD   = 22;
        const RELEASE_SPD = 9;

        return {
          press(mask, worldHitPt) {
            hitData.forEach(h => { if (mask & h.mask) targets[h.idx] = 1; });
            if (worldHitPt) spawnRipple(worldHitPt);
          },
          release(mask) {
            hitData.forEach(h => { if (mask & h.mask) targets[h.idx] = 0; });
          },
          update(dt) {
            let busy = false;
            for (let i = 0; i < 5; i++) {
              const spd = targets[i] > pressVals[i] ? PRESS_SPD : RELEASE_SPD;
              pressVals[i] += (targets[i] - pressVals[i]) * Math.min(1, spd * dt);
              if (Math.abs(targets[i] - pressVals[i]) > 1e-3) busy = true;
              else pressVals[i] = targets[i];
            }

            ripplePool.forEach(r => {
              if (r.t < 0) return;
              busy = true;
              r.t += dt / RIPPLE_DUR;
              if (r.t >= 1) { r.t = -1; r.mesh.visible = false; return; }
              const ease = 1 - Math.pow(1 - r.t, 2);
              r.mesh.scale.setScalar(0.15 + ease * 1.85);
              r.mesh.material.opacity = 0.55 * (1 - r.t);
            });
            return busy;   // render-on-demand: keep rendering while animating
          },
        };
      }

      /* -- Case LEDs ---------------------------------------------------------
         The back-case MATERIAL emits a soft, case-tinted halo plus a tight
         white-hot core around each LED's world position. Nothing to occlude (the
         glow is on the outer surface) and only the back mesh emits, so it can't
         bleed to the front. No lights, no postprocessing — just emissive uniforms,
         so it stays render-on-demand. `uInt` is driven by caselights(); `uLed`
         tracks the markers as the badge spins (refresh() before each render).
         Values tuned in led-shader.html. Applied to the recolored case-back clone
         (`caseRoot`), not the hidden original. */
      function createCaseLeds(caseRoot, root, excludeFromLamp) {
        if (!caseRoot) return null;
        root.updateWorldMatrix(true, true);

        // LED world positions: baked sim_led_* markers, else RM051_4 bbox-relative.
        const markers = ['sim_led_0', 'sim_led_1', 'sim_led_2', 'sim_led_3'].map(n => root.getObjectByName(n));
        const haveMarkers = markers.every(Boolean);
        const rm4 = root.getObjectByName('RM051_4');
        const FALLBACK = [
          new THREE.Vector3(-0.02700, 0, -0.02000), new THREE.Vector3(-0.02700, 0, +0.02000),
          new THREE.Vector3(+0.02700, 0, -0.02000), new THREE.Vector3(+0.02683, 0, +0.02000),
        ];
        const uLed = { value: [0, 1, 2, 3].map(() => new THREE.Vector3()) };
        const uInt = { value: [0, 0, 0, 0] };
        const refresh = () => {
          if (haveMarkers) markers.forEach((m, i) => m.getWorldPosition(uLed.value[i]));
          else if (rm4) FALLBACK.forEach((lp, i) => meshCentreMetresToWorld(rm4, lp, uLed.value[i]));
        };
        refresh();

        // Small omni light at each LED, parented to its marker (spins with the badge),
        // to cast real light on nearby PCB parts — the emissive case is self-lit and
        // illuminates nothing. On a dedicated layer so it skips the front case, else
        // back-LED light bleeds around to the front buttons. Tuned in led-shader.html.
        const LAMP_MAX = 0.064, LAMP_LAYER = 1;   // 80% × 0.08 page scale
        const backOut = new THREE.Vector3(0, 1, 0).transformDirection(screenMesh.matrixWorld).normalize().negate();
        const lamps = haveMarkers ? markers.map((m, i) => {
          const l = new THREE.PointLight(0xfff0e0, 0, 0.05, 2);   // 50 mm range
          l.position.copy(m.worldToLocal(uLed.value[i].clone().addScaledVector(backOut, 0.003)));
          l.layers.set(LAMP_LAYER);
          m.add(l);
          return l;
        }) : [];
        if (lamps.length) {
          // The camera must share the lamp layer or the renderer culls the
          // (layer-1-only) lamps; meshes keep layer 0 so rendering is unchanged.
          camera.layers.enable(LAMP_LAYER);
          root.traverse(o => { if (o.isMesh) o.layers.enable(LAMP_LAYER); });
          if (excludeFromLamp) excludeFromLamp.traverse(o => { if (o.isMesh) o.layers.disable(LAMP_LAYER); });
        }

        caseRoot.traverse((o) => {
          if (!o.isMesh) return;
          // Frost the translucent shell. It's a transmission material, so roughness
          // is the frosted-glass blur (the GLB ships it near-clear at 0.2). See CASE_FROST.
          o.material.roughness = CASE_FROST;
          // Dim the surface specular independently of roughness so a low frost value
          // doesn't read as glossy wet plastic (no env map, so this highlight is just
          // the key light reflecting off the shell). See CASE_SPECULAR.
          o.material.specularIntensity = CASE_SPECULAR;
          // GLB normal map carries the moulded surface texture/definition. See CASE_NORMAL.
          if (o.material.normalMap) o.material.normalScale.set(CASE_NORMAL, CASE_NORMAL);
          o.material.onBeforeCompile = (shader) => {
            shader.uniforms.uLed = uLed;
            shader.uniforms.uInt = uInt;
            shader.vertexShader = shader.vertexShader
              .replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
              .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = (modelMatrix * vec4(transformed,1.0)).xyz;');
            shader.fragmentShader = shader.fragmentShader
              .replace('#include <common>',
                '#include <common>\nvarying vec3 vWP;\nuniform vec3 uLed[4];\nuniform float uInt[4];')
              .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
                const vec3  LED_COL = vec3(1.0, 0.941, 0.878);
                const float LED_R = 0.012, LED_HR = 0.0024;   // halo 12mm, core 2.4mm
                float _g = 0.0, _h = 0.0;
                for (int i = 0; i < 4; i++) {
                  float d = distance(vWP, uLed[i]);
                  _g += uInt[i] * exp(-(d*d)/(2.0*LED_R*LED_R));
                  _h += uInt[i] * exp(-(d*d)/(2.0*LED_HR*LED_HR));
                }
                vec3 _vd = normalize(vViewPosition);
                float _f = pow(1.0 - clamp(dot(normalize(vNormal), _vd), 0.0, 1.0), 2.5);
                _g *= 0.6 * mix(1.0, _f, 0.7);                 // intensity 60%, edge bias 70%
                vec3 _emit = LED_COL * diffuseColor.rgb * 2.5; // tint by case colour (100%)
                totalEmissiveRadiance += _emit * _g + LED_COL * (_h * 1.5); // + hot core 150%
              `);
          };
          o.material.needsUpdate = true;
        });

        return {
          refresh,
          setLevels: (vals) => {
            for (let i = 0; i < 4; i++) uInt.value[i] = vals[i] || 0;
            for (let i = 0; i < lamps.length; i++) lamps[i].intensity = (vals[i] || 0) * LAMP_MAX;
          },
        };
      }

      /* Soft contact shadow: render the badge's silhouette depth from a camera
         under it, Gaussian-blur it, and lay it on a transparent ground plane.
         Grounds the badge without an opaque floor and without a shadow map, so
         the transparent canvas is preserved. Blur 6.0 / opacity 0.8 / falloff 1.0. */
      function buildContactShadow(center, size, groundY) {
        const W = Math.max(size.x, size.z) * 2.6;   // ground footprint + blur margin
        const CAM_H = size.y * 1.05;                // how far up the silhouette is sampled
        const RT = 512, BLUR = 6.0, OPACITY = 0.8, DARKNESS = 1.0;

        const group = new THREE.Group();
        group.position.set(center.x, groundY, center.z);

        const rt     = new THREE.WebGLRenderTarget(RT, RT); rt.texture.generateMipmaps = false;
        const rtBlur = new THREE.WebGLRenderTarget(RT, RT); rtBlur.texture.generateMipmaps = false;

        const geo = new THREE.PlaneGeometry(W, W).rotateX(Math.PI / 2);
        const plane = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
          map: rt.texture, transparent: true, opacity: OPACITY, depthWrite: false,
        }));
        plane.renderOrder = 1;
        plane.scale.y = -1;            // flip the sampled depth texture
        group.add(plane);

        const blurPlane = new THREE.Mesh(geo);
        blurPlane.visible = false;
        group.add(blurPlane);

        const cam = new THREE.OrthographicCamera(-W / 2, W / 2, W / 2, -W / 2, 0, CAM_H);
        cam.rotation.x = Math.PI / 2;  // look up from the ground at the badge
        group.add(cam);

        const depthMat = new THREE.MeshDepthMaterial();
        depthMat.userData.darkness = { value: DARKNESS };
        depthMat.onBeforeCompile = (shader) => {
          shader.uniforms.darkness = depthMat.userData.darkness;
          shader.fragmentShader = `uniform float darkness;\n${shader.fragmentShader.replace(
            'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
            'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );'
          )}`;
        };
        depthMat.depthTest = depthMat.depthWrite = false;

        const hBlur = new THREE.ShaderMaterial(HorizontalBlurShader); hBlur.depthTest = false;
        const vBlur = new THREE.ShaderMaterial(VerticalBlurShader);   vBlur.depthTest = false;

        function blur(amount) {
          blurPlane.visible = true;
          blurPlane.material = hBlur;
          hBlur.uniforms.tDiffuse.value = rt.texture;
          hBlur.uniforms.h.value = amount / RT;
          renderer.setRenderTarget(rtBlur);
          renderer.render(blurPlane, cam);

          blurPlane.material = vBlur;
          vBlur.uniforms.tDiffuse.value = rtBlur.texture;
          vBlur.uniforms.v.value = amount / RT;
          renderer.setRenderTarget(rt);
          renderer.render(blurPlane, cam);

          blurPlane.visible = false;
        }

        // Re-render the shadow texture. Restores all renderer/scene state it touches.
        function render() {
          const bg = scene.background, a = renderer.getClearAlpha();
          scene.background = null;
          scene.overrideMaterial = depthMat;
          renderer.setClearAlpha(0);
          renderer.setRenderTarget(rt);
          renderer.clear();
          renderer.render(scene, cam);
          scene.overrideMaterial = null;
          blur(BLUR);          // wide soft blur
          blur(BLUR * 0.4);    // second pass irons out banding
          renderer.setRenderTarget(null);
          renderer.setClearAlpha(a);
          scene.background = bg;
        }

        return { group, render };
      }

      /* Load the Tufty badge model */
      const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
      gltfLoader.load(new URL('../static/models/badgeware.glb', _badge3dBase).href, (gltf) => {
        const root      = gltf.scene;
        const tuftyNode = root.getObjectByName('tufty');
        const caseBack  = root.getObjectByName('badger_case_back');
        const caseFront = root.getObjectByName('badger_case_front');

        /* Clone orange case for Tufty before hiding Badger. Kept so the case-LED
           glow shader can be applied to the visible clone (not the hidden original). */
        let caseBackClone = null;
        if (caseBack && tuftyNode) {
          caseBackClone = caseBack.clone(true);
          caseBackClone.traverse(child => {
            if (child.isMesh) {
              child.material = child.material.clone();
              child.material.color.setRGB(...CASE_COLOR);
            }
          });
          tuftyNode.add(caseBackClone);
        }
        let caseFrontClone = null;
        if (caseFront && tuftyNode) {
          caseFrontClone = caseFront.clone(true);
          tuftyNode.add(caseFrontClone);
        }

        /* Hide the other two badges */
        ['badger', 'blinky'].forEach(name => {
          const n = root.getObjectByName(name);
          if (n) n.visible = false;
        });

        scene.add(root);
        root.updateWorldMatrix(true, true);

        /* Button anchor markers baked into the GLB (see claude/tools/isolate_badge.py).
           Parented under `tufty`, so they spin with the badge. */
        buttonMarkers = [
          ['sim_btn_a', BTN.a], ['sim_btn_b', BTN.b], ['sim_btn_c', BTN.c],
          ['sim_btn_up', BTN.up], ['sim_btn_down', BTN.down],
        ].map(([name, mask]) => ({ mask, node: root.getObjectByName(name) }))
         .filter(b => b.node);

        /* Grab the active screen mesh and clone its material */
        screenMesh = root.getObjectByName('tufty_screen_active');
        if (screenMesh) {
          screenMesh.material = screenMesh.material.clone();
          // If the model finishes loading mid-run, wire the screen up now.
          if (simulator.micropython) applyCanvasToScreen();
        }

        /* Register the node we spin between Front/Back, starting on the front. */
        if (tuftyNode) {
          viewNode = tuftyNode;
          tuftyNode.rotation.y = FRONT_Y;
        }

        /* Position camera along screen's outward normal for a face-on view.
           The screen mesh lies in the local XZ plane, so local +Y is the face normal. */
        if (screenMesh && tuftyNode) {
          const screenNormal = new THREE.Vector3(0, 1, 0)
            .transformDirection(screenMesh.matrixWorld);

          const tuftyBox = new THREE.Box3().setFromObject(tuftyNode);
          const center   = tuftyBox.getCenter(new THREE.Vector3());
          const size     = tuftyBox.getSize(new THREE.Vector3());
          const maxDim   = Math.max(size.x, size.y, size.z);
          const fovRad   = camera.fov * (Math.PI / 180);
          const dist     = (maxDim / 2) / Math.tan(fovRad / 2) * 1.0;

          /* Place camera along screen normal, slight X offset for 3/4 angle */
          camera.position.copy(center)
            .addScaledVector(screenNormal, dist)
            .addScaledVector(new THREE.Vector3(1, 0, 0), maxDim * 0.12);
          camera.lookAt(center);

          // Remember this as the "home" pose for the double-click zoom toggle.
          homePos.copy(camera.position);
          homeLook.copy(center);
          camPosGoal.copy(camera.position);
          camLookGoal.copy(center);
          camLookNow.copy(center);
          screenFocusReady = true;

          // Ground the badge with a soft contact shadow at its lowest point.
          contactShadow = buildContactShadow(center, size, tuftyBox.min.y);
          scene.add(contactShadow.group);
          shadowDirty = true;
        }

        /* Collect all tufty meshes for raycasting — button detection uses hit position */
        if (tuftyNode) {
          tuftyNode.traverse(child => {
            if (child.isMesh) allHitMeshes.push(child);
          });
        }

        /* Init button animator after meshes are collected and matrices settled */
        if (screenMesh && tuftyNode) {
          buttonAnimator = initButtonAnimator(root, tuftyNode);
          ledState = createCaseLeds(caseBackClone, root, caseFrontClone);
        }

        /* Pre-compile the model's materials off the blocking path (uses
           KHR_parallel_shader_compile where available) and skip rendering until
           it's done — otherwise the first frame stalls ~75ms linking shaders.
           Materials are in their final state here, so no recompile follows. */
        sceneReady = false;
        renderer.compileAsync(scene, camera).then(
          () => { sceneReady = true; renderDirty = true; },
          () => { sceneReady = true; renderDirty = true; },   // unsupported/failed → render anyway
        );
      });

      /* Keep renderer sized to container */
      new ResizeObserver(() => {
        const w = wrap.clientWidth, h = wrap.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderDirty = true;   // size changed — needs a redraw
        if (sceneReady) renderer.render(scene, camera);
      }).observe(wrap);

      /* Render loop */
      let _loopLastT = 0;
      ;(function loop(t = 0) {
        requestAnimationFrame(loop);
        const dt = Math.min((t - _loopLastT) / 1000, 0.1);
        _loopLastT = t;
        // Ease the badge toward the selected Front/Back orientation.
        if (viewNode) {
          const k = Math.min(1, 10 * dt);
          viewNode.rotation.y += (viewTargetY - viewNode.rotation.y) * k;
          if (Math.abs(viewTargetY - viewNode.rotation.y) < 1e-4) viewNode.rotation.y = viewTargetY;
          // Orbit the light rig with the flip: 0 = front-facing, 1 = back-facing.
          const backness = (1 - Math.cos(viewNode.rotation.y - FRONT_Y)) / 2;
          lightRig.rotation.y = (LIGHT_ORBIT[0] + (LIGHT_ORBIT[1] - LIGHT_ORBIT[0]) * backness) * Math.PI / 180;
          lightRig.rotation.x = (LIGHT_ELEV[0]  + (LIGHT_ELEV[1]  - LIGHT_ELEV[0])  * backness) * Math.PI / 180;
        }
        // Ease the camera between the home and screen-framed poses.
        if (camEasing) {
          const k = Math.min(1, 8 * dt);
          camera.position.lerp(camPosGoal, k);
          camLookNow.lerp(camLookGoal, k);
          camera.lookAt(camLookNow);
          if (camera.position.distanceToSquared(camPosGoal) < 1e-8 &&
              camLookNow.distanceToSquared(camLookGoal) < 1e-8) {
            camera.position.copy(camPosGoal);
            camLookNow.copy(camLookGoal);
            camera.lookAt(camLookNow);
            camEasing = false;
          }
        }
        const newFrame    = uploadFrame();   // true only when the worker sent a new frame
        const buttonsBusy = buttonAnimator ? buttonAnimator.update(dt) : false;
        const ledIdle     = ledState && !_ledSimActive;
        if (ledIdle) {
          // Gentle breathing chase across the 4 LEDs until MicroPython drives them.
          ledState.setLevels([0, 1, 2, 3].map(
            i => Math.max(0, Math.cos(t * 0.0025 + i * Math.PI * 0.5)) ** 2));
        }
        const rotating  = viewNode && viewNode.rotation.y !== viewTargetY;
        const animating = camEasing || rotating || buttonsBusy || ledIdle;

        // Render-on-demand: only touch the GPU when something actually changed —
        // a new badge frame, an in-progress animation, or a one-shot dirty event.
        // A stopped/idle badge does no render work. (Held off entirely while the
        // model's shaders are still compiling in the background.)
        if (sceneReady && (renderDirty || newFrame || animating)) {
          // Refresh the contact shadow only when the badge's silhouette moves
          // (spin / button press), not on mere screen-content or LED updates.
          if (contactShadow && (shadowDirty || rotating || buttonsBusy)) {
            contactShadow.render();
            shadowDirty = false;
          }
          if (ledState) ledState.refresh();   // keep uLed on the markers as the badge spins
          renderer.render(scene, camera);
        }
        renderDirty = false;
      })();

    } catch (e) {
      console.warn('3D badge setup failed:', e);
    }
  })();

  return { applyCanvasToScreen, pauseScreen, rotateView: (dir) => rotateView(dir) };
}
