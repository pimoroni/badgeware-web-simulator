/* -- 3D badge display ------------------------------------------------------ */
const _badge3dBase = new URL('.', import.meta.url).href;

export function initBadge3D(simulator, appendOut) {
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

      const wrap = document.getElementById('badge-3d-wrap');
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

      /* Forward badge key events from the 3D canvas */
      const keyMap = { 38: 2, 40: 1, 37: 16, 39: 4, 32: 8, 27: 32 };
      renderer.domElement.tabIndex = 0;
      renderer.domElement.addEventListener('keydown', ev => {
        const btn = keyMap[ev.keyCode] ?? 0;
        if (!btn || !simulator.micropython) return;
        simulator.buttons |= btn;
        simulator.micropython.postMessage({ buttons: simulator.buttons });
        ev.preventDefault();
      });
      renderer.domElement.addEventListener('keyup', ev => {
        const btn = keyMap[ev.keyCode] ?? 0;
        if (!btn || !simulator.micropython) return;
        simulator.buttons &= ~btn;
        simulator.micropython.postMessage({ buttons: simulator.buttons });
        ev.preventDefault();
      });

      /* Lighting. Brightness comes mostly from ambient + fill: the screen's diffuse
         is black (its picture is emissive), so neither can glare it — only the case
         and components brighten. The strong directional key is left as-is; bumping it
         would put a specular hotspot on the screen. */
      scene.add(new THREE.AmbientLight(0xffffff, 1.05));
      const keyLight = new THREE.DirectionalLight(0xffffff, 2.5);
      keyLight.position.set(0.4, 0.8, 1);
      scene.add(keyLight);
      const fillLight = new THREE.DirectionalLight(0x8090d0, 0.85);
      fillLight.position.set(-0.6, 0.2, 0.3);
      scene.add(fillLight);

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
          return { mask: lp.z < 0.005 ? 2 : 1, worldPt };                     // UP / DOWN
        }
        // Bottom button strip — constrain to centred region just below screen
        if (lp.z > 0.018 && lp.z < 0.035 && Math.abs(lp.x) < 0.028) {
          const mask = lp.x < -0.008 ? 16 : lp.x < +0.008 ? 8 : 4;
          return { mask, worldPt };                                             // A / B / C
        }
        return { mask: 0, worldPt: null };
      }

      // Capture-phase pointerdown so button hits are handled before anything else
      renderer.domElement.addEventListener('pointerdown', ev => {
        const { mask, worldPt } = buttonMaskAt(ev);
        if (!mask) return;
        heldMask = mask;
        simulator.buttons |= mask;
        if (simulator.micropython) simulator.micropython.postMessage({ buttons: simulator.buttons });
        if (buttonAnimator) buttonAnimator.press(mask, worldPt);
        ev.stopPropagation();
      }, true);

      renderer.domElement.addEventListener('pointerup', ev => {
        if (!heldMask) return;
        simulator.buttons &= ~heldMask;
        if (buttonAnimator) buttonAnimator.release(heldMask);
        heldMask = 0;
        if (simulator.micropython) simulator.micropython.postMessage({ buttons: simulator.buttons });
        ev.stopPropagation();
      }, true);

      renderer.domElement.addEventListener('pointercancel', () => {
        if (!heldMask) return;
        simulator.buttons &= ~heldMask;
        if (buttonAnimator) buttonAnimator.release(heldMask);
        heldMask = 0;
        if (simulator.micropython) simulator.micropython.postMessage({ buttons: simulator.buttons });
      });

      // Double-click the screen to frame it; double-click again to zoom back out.
      renderer.domElement.addEventListener('dblclick', ev => {
        if (!screenFocusReady) return;
        if (zoomed) { focusScreen(false); return; }
        const rect  = renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(
          ((ev.clientX - rect.left) / rect.width)  *  2 - 1,
          ((ev.clientY - rect.top)  / rect.height) * -2 + 1,
        );
        raycaster.setFromCamera(mouse, camera);
        // Only zoom in when the double-click actually lands on the (front-facing)
        // screen mesh — back-face culling means this misses when spun to the rear.
        if (raycaster.intersectObject(screenMesh, false).length) focusScreen(true);
      });

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
          { mask: 16, slc: new THREE.Vector3(-0.018,  0,  0.023) }, // A
          { mask:  8, slc: new THREE.Vector3(  0.00,  0,  0.023) }, // B
          { mask:  4, slc: new THREE.Vector3(+0.018,  0,  0.023) }, // C
          { mask:  2, slc: new THREE.Vector3(+0.035,  0, -0.002) }, // UP
          { mask:  1, slc: new THREE.Vector3(+0.035,  0, +0.010) }, // DOWN
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
          o.material.roughness = 0.2;      // frostiness
          o.material.thickness = 0.0015;   // 1.5 mm volume
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
              child.material.color.setRGB(1, 0.42, 0);
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
          ['sim_btn_a', 16], ['sim_btn_b', 8], ['sim_btn_c', 4],
          ['sim_btn_up', 2], ['sim_btn_down', 1],
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
