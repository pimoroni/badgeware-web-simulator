/* ── 3D badge display ────────────────────────────────────────────────────── */
function initBadge3D(simulator, appendOut) {
  let three = null, screenMesh = null, screenTex = null;

  function applyCanvasToScreen() {
    if (!three || !screenMesh || !simulator.canvas) return;
    if (screenTex) screenTex.dispose();
    screenTex = new three.CanvasTexture(simulator.canvas);
    screenTex.magFilter  = three.NearestFilter;
    screenTex.minFilter  = three.NearestFilter;
    screenTex.flipY      = false;
    screenTex.colorSpace = three.SRGBColorSpace;
    // MeshBasicMaterial is unlit — scene lights can't lift the blacks.
    if (!(screenMesh.material instanceof three.MeshBasicMaterial)) {
      screenMesh.material = new three.MeshBasicMaterial();
    }
    screenMesh.material.map         = screenTex;
    screenMesh.material.needsUpdate = true;
  }

  (async () => {
    try {
      const THREE              = await import('three');
      const { GLTFLoader }     = await import('three/addons/loaders/GLTFLoader.js');
      const { OrbitControls }  = await import('three/addons/controls/OrbitControls.js');
      three = THREE;

      const wrap = document.getElementById('badge-3d-wrap');
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(wrap.clientWidth, wrap.clientHeight);
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      wrap.appendChild(renderer.domElement);

      const scene  = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(22, wrap.clientWidth / wrap.clientHeight, 0.001, 10);

      /* OrbitControls — drag to rotate, no pan/zoom extremes */
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping  = true;
      controls.dampingFactor  = 0.06;
      controls.enablePan      = false;
      controls.minDistance    = 0.05;
      controls.maxDistance    = 0.8;
      controls.rotateSpeed    = 0.6;

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

      /* Lighting */
      scene.add(new THREE.AmbientLight(0xffffff, 0.7));
      const keyLight = new THREE.DirectionalLight(0xffffff, 2.5);
      keyLight.position.set(0.4, 0.8, 1);
      scene.add(keyLight);
      const fillLight = new THREE.DirectionalLight(0x8090d0, 0.6);
      fillLight.position.set(-0.6, 0.2, 0.3);
      scene.add(fillLight);

      /* Button raycasting */
      const allHitMeshes = [];
      const raycaster    = new THREE.Raycaster();
      let   heldMask     = 0;
      let   buttonAnimator  = null;
      let   ledState        = null;   // { lights: PointLight[4], coverMesh }
      let   _ledSimActive   = false;  // true once MicroPython has sent caselights data

      // Drive the 3D case LEDs when badge.caselights() is called from MicroPython
      simulator.caselights = (values) => {
        _ledSimActive = true;
        if (!ledState) return;
        const { lights, coverMesh } = ledState;
        lights.forEach((l, i) => { l.intensity = (values[i] || 0) * 2; });
        if (coverMesh) coverMesh.material.emissiveIntensity = Math.max(...values);
      };

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
        const lp = screenMesh.worldToLocal(hits[0].point.clone());
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

      // Capture-phase pointerdown so button hits block OrbitControls entirely
      renderer.domElement.addEventListener('pointerdown', ev => {
        const { mask, worldPt } = buttonMaskAt(ev);
        if (!mask) return;
        heldMask = mask;
        simulator.buttons |= mask;
        if (simulator.micropython) simulator.micropython.postMessage({ buttons: simulator.buttons });
        if (buttonAnimator) buttonAnimator.press(mask, worldPt);
        controls.enabled = false;
        ev.stopPropagation();
      }, true);

      renderer.domElement.addEventListener('pointerup', ev => {
        if (!heldMask) return;
        simulator.buttons &= ~heldMask;
        if (buttonAnimator) buttonAnimator.release(heldMask);
        heldMask = 0;
        if (simulator.micropython) simulator.micropython.postMessage({ buttons: simulator.buttons });
        controls.enabled = true;
        ev.stopPropagation();
      }, true);

      renderer.domElement.addEventListener('pointercancel', () => {
        if (!heldMask) return;
        simulator.buttons &= ~heldMask;
        if (buttonAnimator) buttonAnimator.release(heldMask);
        heldMask = 0;
        if (simulator.micropython) simulator.micropython.postMessage({ buttons: simulator.buttons });
        controls.enabled = true;
      });

      /* ── Button press animation (siloed — swap out when geometry improves) ──
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
          const worldPt = screenMesh.localToWorld(b.slc.clone());
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

        // ── Ripple pool (visual "dash of 3") ─────────────────────────────
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

        // ── Public API ────────────────────────────────────────────────────
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
            for (let i = 0; i < 5; i++) {
              const spd = targets[i] > pressVals[i] ? PRESS_SPD : RELEASE_SPD;
              pressVals[i] += (targets[i] - pressVals[i]) * Math.min(1, spd * dt);
            }

            ripplePool.forEach(r => {
              if (r.t < 0) return;
              r.t += dt / RIPPLE_DUR;
              if (r.t >= 1) { r.t = -1; r.mesh.visible = false; return; }
              const ease = 1 - Math.pow(1 - r.t, 2);
              r.mesh.scale.setScalar(0.15 + ease * 1.85);
              r.mesh.material.opacity = 0.55 * (1 - r.t);
            });
          },
        };
      }

      /* ── Case LEDs (4× PointLights behind badge + emissive cover) ── */
      function createLedLights(root) {
        root.updateWorldMatrix(true, true);
        const faceOut = new THREE.Vector3(0, 1, 0)
          .transformDirection(screenMesh.matrixWorld).normalize();

        const rm4 = root.getObjectByName('RM051_4');
        if (!rm4 || !rm4.isMesh) return { lights: [], coverMesh: null };

        rm4.material = rm4.material.clone();
        rm4.material.emissive.set(1, 0.94, 0.88);
        rm4.material.emissiveIntensity = 0;

        // Centroids of the 4 LED clusters in RM051_4's own mesh space
        // (RM051 and tufty_packages both carry non-trivial matrices, so we
        //  must use rm4.localToWorld() rather than tuftyNode.localToWorld())
        const LED_MESH_LOCAL = [
          new THREE.Vector3(-0.02700, 0, -0.04855), // CL0: left-top
          new THREE.Vector3(-0.02700, 0, -0.00855), // CL1: left-bottom
          new THREE.Vector3(+0.02700, 0, -0.04855), // CL2: right-top
          new THREE.Vector3(+0.02683, 0, -0.00855), // CL3: right-bottom
        ];
        const lights = LED_MESH_LOCAL.map(lp => {
          const wp = rm4.localToWorld(lp.clone());
          wp.addScaledVector(faceOut, -0.002); // 2mm inside back face
          const light = new THREE.PointLight(0xfff0e0, 0, 0.04, 2);
          light.position.copy(wp);
          scene.add(light);
          return light;
        });

        return { lights, coverMesh: rm4 };
      }

      /* Load the Tufty badge model */
      new GLTFLoader().load('/static/models/badgeware.glb', (gltf) => {
        const root      = gltf.scene;
        const tuftyNode = root.getObjectByName('tufty');
        const caseBack  = root.getObjectByName('badger_case_back');
        const caseFront = root.getObjectByName('badger_case_front');

        /* Clone orange case for Tufty before hiding Badger */
        if (caseBack && tuftyNode) {
          const cb = caseBack.clone(true);
          cb.traverse(child => {
            if (child.isMesh) {
              child.material = child.material.clone();
              child.material.color.setRGB(1, 0.42, 0);
            }
          });
          tuftyNode.add(cb);
        }
        if (caseFront && tuftyNode) {
          tuftyNode.add(caseFront.clone(true));
        }

        /* Hide the other two badges */
        ['badger', 'blinky'].forEach(name => {
          const n = root.getObjectByName(name);
          if (n) n.visible = false;
        });

        scene.add(root);
        root.updateWorldMatrix(true, true);

        /* Grab the active screen mesh and clone its material */
        screenMesh = root.getObjectByName('tufty_screen_active');
        if (screenMesh) {
          screenMesh.material = screenMesh.material.clone();
          if (simulator.canvas) applyCanvasToScreen();
        }

        /* Slight default Y tilt for visual style */
        if (tuftyNode) tuftyNode.rotation.y = -0.2;

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
          controls.target.copy(center);
          controls.update();
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
          ledState = createLedLights(root);
        }
      });

      /* Keep renderer sized to container */
      new ResizeObserver(() => {
        const w = wrap.clientWidth, h = wrap.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.render(scene, camera);
      }).observe(wrap);

      /* Render loop */
      let _loopLastT = 0;
      ;(function loop(t = 0) {
        requestAnimationFrame(loop);
        const dt = Math.min((t - _loopLastT) / 1000, 0.1);
        _loopLastT = t;
        controls.update();
        if (screenTex) screenTex.needsUpdate = true;
        if (buttonAnimator) buttonAnimator.update(dt);
        if (ledState && !_ledSimActive) {
          const { lights, coverMesh } = ledState;
          lights.forEach((l, i) => {
            l.intensity = Math.max(0, Math.cos(t * 0.0025 + i * Math.PI * 0.5)) ** 2 * 2;
          });
          if (coverMesh) coverMesh.material.emissiveIntensity = Math.max(...lights.map(l => l.intensity)) / 2;
        }
        renderer.render(scene, camera);
      })();

    } catch (e) {
      console.warn('3D badge setup failed:', e);
    }
  })();

  return { applyCanvasToScreen };
}
