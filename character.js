import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const BASIS_PATH = '/basis/';
const AVATAR_SCALE = 0.75;
const EXPRESSION_SCALE = 0.6;
// Brow centrelines in head mesh rest coordinates: [x, z, radius], outer tail to inner end.
const FACE_CENTRE_X = 5618;
const BROW = [[2505, 7088, 95], [3522, 6715, 200], [4232, 6757, 250], [5018, 7003, 235]];
// The head mesh rests slightly rolled, so the right brow is lifted to look level on screen.
const RIGHT_BROW_LIFT = [209, 152, 95, 57];
const BROWS = [BROW, BROW.map(([x, z, r], i) => [2 * FACE_CENTRE_X - x, z - RIGHT_BROW_LIFT[i], r])];
// The brows painted into the skin texture, erased so they do not show around the new ones.
const OLD_BROWS = [
  [[2867, 6943], [3442, 6712], [4104, 6755], [4898, 6967]],
  [[8437, 6990], [7634, 6717], [6875, 6760], [6326, 6966]],
];
const OLD_BROW_RADIUS = 190;
const OLD_BROW_FILL_REACH = 300;
const BROW_COLOR = 'vec3(0.075, 0.046, 0.028)';
const BROW_STRENGTH = 1.0;
const BROW_SUBDIVISIONS = 6;
const EYE_ROTATION_LIMIT = THREE.MathUtils.degToRad(28);
const EYE_REST_PITCH = THREE.MathUtils.degToRad(-7);
const SKIN_TINT = 0xf3c9b0;
const SKIN_GLOW = 0x2b140c;

const FAST_MORPHS = /^(jawOpen|mouthFunnel|mouthPucker|mouthStretch|mouthPress|mouthRollLower)/;
const VISEMES = [
  [/[a]/, { jawOpen: 0.18 }],
  [/[o]/, { jawOpen: 0.12, mouthFunnel: 0.4 }],
  [/[uw]/, { jawOpen: 0.08, mouthPucker: 0.5 }],
  [/[e]/, { jawOpen: 0.1, mouthStretch_L: 0.25, mouthStretch_R: 0.25 }],
  [/[iy]/, { jawOpen: 0.06, mouthStretch_L: 0.3, mouthStretch_R: 0.3 }],
  [/[mbp]/, { mouthPress_L: 0.45, mouthPress_R: 0.45 }],
  [/[fv]/, { jawOpen: 0.05, mouthRollLower: 0.4 }],
];
const VISEME_DEFAULT = { jawOpen: 0.06 };

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const rand = (a, b) => a + Math.random() * (b - a);

/**
 * Realistic 3D head driven by ARKit-style blend shapes.
 * States: loading | idle | listening | thinking | happy | error
 */
export class Character {
  constructor(canvas) {
    this.canvas = canvas;
    this.state = 'loading';
    this.speech = 0; // 0..1 smoothed speech probability from VAD
    this.morphMeshes = [];
    this.cur = {}; // current (smoothed) morph values
    this.pose = { pitch: 0, yaw: 0, roll: 0 };
    this.gaze = { x: 0, y: 0 };
    this.gazeTarget = { x: 0, y: 0 };
    this.nextGazeAt = 0;
    this.saccade = { x: 0, y: 0 };
    this.saccadeTarget = { x: 0, y: 0 };
    this.nextSaccadeAt = 0;
    this.blinkAt = 2;
    this.blinkT = -1;
    this.doubleBlink = false;
    this.nodT = -1;
    this.time = 0;
    this.baseYaw = 0;
    this.running = false;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.85;

    const key = new THREE.DirectionalLight(0xfff1e0, 1.4);
    key.position.set(-1.5, 1.6, 2.5);
    const fill = new THREE.DirectionalLight(0xffe4d2, 0.9);
    fill.position.set(2, 0.2, 2.5);
    const rim = new THREE.DirectionalLight(0x8fb4ff, 1.0);
    rim.position.set(2, 1, -2);
    this.scene.add(key, fill, rim);

    this.camera = new THREE.PerspectiveCamera(28, 1, 0.01, 100);
    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement || canvas);
    this.resize();
  }

  async load(url, onProgress) {
    const ktx2 = new KTX2Loader().setTranscoderPath(BASIS_PATH).detectSupport(this.renderer);
    const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(url, (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    });

    const model = gltf.scene;
    this.pivot.add(model);
    model.traverse((o) => {
      if (o.isMesh && o.morphTargetDictionary) this.morphMeshes.push(o);
    });
    if (!this.morphMeshes.length) throw new Error('Model has no blend shapes');

    // The bundled skin texture is neutral grey: warm tint, matte finish and a faint
    // warm glow that lifts the shadows like skin scattering light.
    const skin = this.morphMeshes.reduce((a, b) =>
      a.geometry.attributes.position.count >= b.geometry.attributes.position.count ? a : b);
    if (skin.material?.color) {
      skin.material = skin.material.clone();
      skin.material.color.set(SKIN_TINT);
      skin.material.roughness = Math.max(skin.material.roughness ?? 0.6, 0.7);
      skin.material.emissive?.set(SKIN_GLOW);
      this._paintBrows(skin);
    }

    this.eyes = ['eyeLeft', 'eyeRight'].map((n) => model.getObjectByName(n)).filter(Boolean);
    this._styleEyes(model);
    // The teeth mesh does not follow the jaw and shows as fangs in the mouth corners.
    for (const teeth of this._eyeMeshes(model, 'teeth')) teeth.visible = false;

    // Centre the model so head rotations pivot around the middle of the bust.
    const box = new THREE.Box3().setFromObject(model);
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    model.position.sub(centre);
    this.modelSize = size;
    this._frameCamera();
    ktx2.dispose();
  }

  // Texture coordinate change per head mesh unit of x and z, fitted over the brow area.
  _browUvGradient(mesh) {
    const { position, uv } = mesh.geometry.attributes;
    const { map } = mesh.material;
    map.updateMatrix();
    const pts = [];
    const v = new THREE.Vector2();
    for (let i = 0; i < position.count; i++) {
      const [x, y, z] = [position.getX(i), position.getY(i), position.getZ(i)];
      if (y < 9000 || z < 6000 || z > 7600 || x < 2200 || x > 9000) continue;
      v.fromBufferAttribute(uv, i).applyMatrix3(map.matrix);
      pts.push([x, z, v.x, v.y]);
    }
    const mean = [0, 1, 2, 3].map((c) => pts.reduce((a, p) => a + p[c], 0) / pts.length);
    let [xx, xz, zz, xu, zu, xv, zv] = [0, 0, 0, 0, 0, 0, 0];
    for (const p of pts) {
      const [x, z, a, b] = p.map((n, c) => n - mean[c]);
      xx += x * x; xz += x * z; zz += z * z;
      xu += x * a; zu += z * a; xv += x * b; zv += z * b;
    }
    const det = xx * zz - xz * xz;
    return {
      du: [(zz * xu - xz * zu) / det, (xx * zu - xz * xu) / det],
      dv: [(zz * xv - xz * zv) / det, (xx * zv - xz * xv) / det],
    };
  }

  _paintBrows(mesh) {
    const material = mesh.material;
    const f = (n) => n.toFixed(1);
    const { du, dv } = this._browUvGradient(mesh);
    const uvStep = `vec2(${(du[1] * OLD_BROW_FILL_REACH).toExponential(5)}, ${(dv[1] * OLD_BROW_FILL_REACH).toExponential(5)})`;
    const oldSegments = OLD_BROWS.flatMap((brow) => brow.slice(1).map((b, i) => {
      const a = brow[i];
      return `oldD = min(oldD, browSegment(vRest.xz, vec2(${f(a[0])}, ${f(a[1])}), vec2(${f(b[0])}, ${f(b[1])}), ${f(OLD_BROW_RADIUS)}, ${f(OLD_BROW_RADIUS)}));`;
    })).join('\n');
    const spline = (brow) => {
      const out = [];
      for (let i = 0; i < brow.length - 1; i++) {
        const [p0, p1, p2, p3] = [brow[Math.max(i - 1, 0)], brow[i], brow[i + 1], brow[Math.min(i + 2, brow.length - 1)]];
        for (let k = 0; k < BROW_SUBDIVISIONS; k++) {
          const u = k / BROW_SUBDIVISIONS;
          out.push(p1.map((_, c) => 0.5 * (2 * p1[c] + (p2[c] - p0[c]) * u
            + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * u * u
            + (3 * p1[c] - p0[c] - 3 * p2[c] + p3[c]) * u * u * u)));
        }
      }
      out.push(brow[brow.length - 1]);
      return out;
    };
    const segments = BROWS.map(spline).flatMap((brow) => brow.slice(1).map((b, i) => {
      const a = brow[i];
      return `d = min(d, browSegment(vRest.xz, vec2(${f(a[0])}, ${f(a[1])}), vec2(${f(b[0])}, ${f(b[1])}), ${f(a[2])}, ${f(b[2])}));`;
    })).join('\n');
    material.customProgramCacheKey = () => 'skin-brows';
    material.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vRest;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = position;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vRest;
          float browSegment(vec2 p, vec2 a, vec2 b, float ra, float rb) {
            vec2 pa = p - a;
            vec2 ba = b - a;
            float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
            return length(pa - ba * h) - mix(ra, rb, h);
          }`)
        .replace('#include <map_fragment>', `#include <map_fragment>
          float browMask = 0.0;
          if (vRest.y > 9000.0) {
            float oldD = 1e9;
            ${oldSegments}
            vec3 skinFill = diffuse * 0.5 * (texture2D(map, vMapUv - ${uvStep}).rgb + texture2D(map, vMapUv + ${uvStep}).rgb);
            diffuseColor.rgb = mix(skinFill, diffuseColor.rgb, smoothstep(-90.0, 30.0, oldD));
            float d = 1e9;
            ${segments}
            browMask = (1.0 - smoothstep(-70.0, 40.0, d)) * ${BROW_STRENGTH.toFixed(2)};
            diffuseColor.rgb = mix(diffuseColor.rgb, ${BROW_COLOR}, browMask);
          }
          // Inside of the mouth: back faces, and surfaces set deeper than the lips.
          float mouthX = vRest.x - ${FACE_CENTRE_X.toFixed(1)};
          float lipFront = 12674.0 - 4.74e-4 * mouthX * mouthX;
          float mouthInside = step(abs(mouthX), 1500.0) * step(11100.0, vRest.z) * step(vRest.z, 12000.0) * smoothstep(300.0, 450.0, lipFront - vRest.y);
          if (!gl_FrontFacing) mouthInside = 1.0;
          diffuseColor.rgb *= 1.0 - 0.92 * mouthInside;`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 1.0, max(browMask, mouthInside));`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance *= 1.0 - browMask;
          totalEmissiveRadiance *= 1.0 - mouthInside;`);
    };
  }

  _eyeMeshes(model, name) {
    const out = [];
    model.traverse((o) => {
      if (o.name === name) o.traverse((m) => m.isMesh && out.push(m));
    });
    return out;
  }

  _styleEyes(model) {
    for (const name of ['eyeLeft', 'eyeRight']) {
      for (const mesh of this._eyeMeshes(model, name)) {
        const old = mesh.material;
        const mat = new THREE.MeshPhysicalMaterial({
          map: old.map,
          roughness: 0.25,
          clearcoat: 0.6,
          clearcoatRoughness: 0.05,
        });
        mat.customProgramCacheKey = () => 'eye';
        mat.onBeforeCompile = (sh) => {
          sh.fragmentShader = sh.fragmentShader
            .replace('#include <map_fragment>', `#include <map_fragment>
              float lum = dot(diffuseColor.rgb, vec3(0.3333));
              float iris = 1.0 - smoothstep(0.3, 0.55, lum);
              float pupil = smoothstep(0.04, 0.16, lum);
              vec3 irisCol = vec3(0.2, 0.11, 0.045) * (0.45 + 1.3 * lum) * pupil;
              float rim = 1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition)));
              vec3 sclera = diffuseColor.rgb * mix(vec3(0.96, 0.93, 0.9), vec3(0.74, 0.6, 0.57), smoothstep(0.3, 0.95, rim));
              diffuseColor.rgb = mix(sclera, irisCol, iris);`)
            .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
              vec3 nv = normalize(vNormal);
              totalEmissiveRadiance += vec3(1.6 * smoothstep(0.992, 0.999, dot(nv, normalize(vec3(-0.2, 0.26, 1.0)))));
              totalEmissiveRadiance += vec3(0.35 * smoothstep(0.99, 0.998, dot(nv, normalize(vec3(0.22, -0.2, 1.0)))));`);
        };
        mesh.material = mat;
      }
    }
  }

  _frameCamera() {
    const { x: w, y: h } = this.modelSize;
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const tan = Math.tan(vfov / 2);
    const fitHeight = (h / 2 / tan) * 1.0;
    const fitWidth = (w / 2 / (tan * this.camera.aspect)) * 1.12;
    this.camera.position.set(0, h * 0.02, Math.max(fitHeight, fitWidth) / AVATAR_SCALE);
    this.camera.lookAt(0, 0, 0);
  }

  resize() {
    const p = this.canvas.parentElement || this.canvas;
    const w = Math.max(1, p.clientWidth);
    const h = Math.max(1, p.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.modelSize) {
      this._frameCamera();
      this.renderer.render(this.scene, this.camera); // setSize clears the canvas; redraw at once
    }
  }

  setState(state) {
    if (state === this.state) return;
    if (state === 'happy') this.nodT = 0;
    this.state = state;
    this.nextGazeAt = 0;
  }

  // Moves the lips through one word, letter by letter. Non-Latin text gets one open-close shape.
  sayWord(word, ms) {
    const letters = word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    this.talk = { letters: /^[a-z0-9]+$/.test(letters) ? letters : 'a', start: this.time, seconds: Math.min(ms, 170 + 35 * word.length) / 1000 };
  }

  setSpeech(p) {
    this.speech = p;
  }

  // ---- targets -----------------------------------------------------------

  _wander(rangeX, rangeY, holdMin, holdMax, cameraChance) {
    if (this.time < this.nextGazeAt) return;
    const atCamera = Math.random() < cameraChance;
    this.gazeTarget = atCamera ? { x: 0, y: 0 } : { x: rand(-rangeX, rangeX), y: rand(-rangeY, rangeY) };
    this.nextGazeAt = this.time + rand(holdMin, holdMax);
  }

  _targets() {
    const t = {};
    const both = (name, v) => {
      t[`${name}_L`] = v;
      t[`${name}_R`] = v;
    };
    const pose = { pitch: 0, yaw: 0, roll: 0 };
    const s = this.speech;
    const time = this.time;

    if (this.state === 'sleep') {
      // Eyelids closed, face relaxed, head drooped. Nothing drifts.
      this.eyeAim = { x: 0, y: 0 };
      this.talk = null;
      both('eyeBlink', 1);
      t.jawOpen = 0.05;
      pose.pitch = 0.1;
      return { morphs: t, pose };
    }

    switch (this.state) {
      case 'loading':
        both('browDown', 0.08);
        pose.pitch = 0.05;
        this._wander(0.3, 0.2, 0.8, 2, 0.3);
        break;

      case 'listening':
        // Attentive: soft brows, gentle smile, slight head tilt, nods and small gaze drift.
        t.browInnerUp = 0.1 + 0.18 * s;
        both('browOuterUp', 0.06 + 0.1 * s);
        both('eyeWide', 0.03 + 0.06 * s);
        both('mouthSmile', 0.14);
        both('cheekSquint', 0.05);
        pose.roll = 0.06;
        pose.pitch = 0.025 + 0.03 * Math.max(0, Math.sin(time * 2.1)) * s;
        pose.yaw = 0.025 * Math.sin(time * 0.9);
        this._wander(0.12, 0.08, 1.5, 3.5, 0.6);
        break;

      case 'thinking':
        // Looks up and to the side, lips pressed, head tilted the other way.
        t.browInnerUp = 0.3;
        both('browOuterUp', 0.08);
        both('mouthPress', 0.3);
        t.mouthRight = 0.12;
        pose.roll = -0.06;
        pose.yaw = -0.04;
        pose.pitch = -0.02;
        this.gazeTarget = { x: -0.3, y: 0.2 };
        break;

      case 'speaking':
        both('mouthSmile', 0.1);
        t.browInnerUp = 0.06;
        pose.pitch = 0.012 * Math.sin(time * 1.9);
        pose.yaw = 0.03 * Math.sin(time * 0.7);
        pose.roll = 0.015 * Math.sin(time * 0.5);
        this._wander(0.14, 0.08, 1.2, 3, 0.7);
        break;

      case 'happy':
        both('mouthSmile', 0.75);
        both('cheekSquint', 0.4);
        both('browOuterUp', 0.15);
        t.browInnerUp = 0.08;
        this._wander(0.08, 0.05, 1.5, 3, 0.7);
        break;

      case 'error':
        both('mouthFrown', 0.5);
        t.browInnerUp = 0.5;
        both('browDown', 0.08);
        pose.pitch = 0.05;
        this.gazeTarget = { x: 0, y: -0.2 };
        break;

      default: // idle
        both('mouthSmile', 0.2);
        both('cheekSquint', 0.06);
        pose.yaw = 0.04 * Math.sin(time * 0.35);
        pose.pitch = 0.012 * Math.sin(time * 0.5);
        pose.roll = 0.018 * Math.sin(time * 0.27);
        this._wander(0.25, 0.15, 1.2, 3.2, 0.5);
    }

    // One-off nod when a transcription lands.
    if (this.nodT >= 0) {
      this.nodT += this._dt;
      const k = this.nodT / 0.7;
      if (k >= 1) this.nodT = -1;
      else pose.pitch += 0.1 * Math.sin(k * Math.PI);
    }

    for (const n in t) t[n] *= EXPRESSION_SCALE;

    // Lips: breathing, small drifts and a soft press-release while the user speaks.
    const breath = 0.5 + 0.5 * Math.sin(time * 1.5);
    const drift = Math.max(0, Math.sin(time * 0.8 + 1));
    const hum = 0.5 + 0.5 * Math.sin(time * 3.2);
    const lips = { jawOpen: 0.03 + 0.025 * breath, mouthPucker: 0.05 * drift, mouthRollLower: 0.06 * (1 - breath), mouthShrugUpper: 0.04 * drift };
    if (this.state === 'listening') {
      lips.mouthPress_L = lips.mouthPress_R = 0.18 * s * hum;
      lips.jawOpen += 0.02 + 0.03 * s * (1 - hum);
      lips.mouthStretch_L = lips.mouthStretch_R = 0.05 * s;
    } else if (this.state === 'thinking') {
      lips.mouthPucker = 0.25 + 0.1 * Math.sin(time * 1.1);
      lips.mouthLeft = 0.15 * Math.sin(time * 0.6);
    } else if (this.state === 'happy') {
      lips.jawOpen += 0.06;
    }
    for (const n in lips) t[n] = (t[n] ?? 0) + lips[n];

    if (this.talk) {
      const k = (time - this.talk.start) / this.talk.seconds;
      if (k >= 1) {
        this.talk = null;
      } else {
        const { letters } = this.talk;
        const letter = letters[Math.floor(k * letters.length)];
        const shape = VISEMES.find(([re]) => re.test(letter))?.[1] ?? VISEME_DEFAULT;
        for (const n in shape) t[n] = (t[n] ?? 0) + shape[n];
      }
    }

    // Eye gaze -> blend shapes, with a tiny constant drift so the eyes never freeze.
    const x = this.gaze.x + this.saccade.x + 0.025 * Math.sin(time * 1.7) + 0.015 * Math.sin(time * 4.3);
    const y = this.gaze.y + this.saccade.y + 0.02 * Math.sin(time * 1.3 + 1) + 0.012 * Math.sin(time * 3.7);
    this.eyeAim = { x, y };
    t.eyeLookOut_L = Math.max(x, 0);
    t.eyeLookIn_R = Math.max(x, 0);
    t.eyeLookIn_L = Math.max(-x, 0);
    t.eyeLookOut_R = Math.max(-x, 0);
    both('eyeLookUp', Math.max(y, 0));
    both('eyeLookDown', Math.max(-y, 0));

    // Brows and nose react to gaze. Morph names ending in _L sit on the viewer's right.
    const add = (name, v) => (t[name] = (t[name] ?? 0) + v);
    const up = Math.max(y, 0);
    const toL = Math.max(x, 0);
    const toR = Math.max(-x, 0);
    add('browInnerUp', 0.6 * up);
    add('browOuterUp_L', 0.5 * up + 0.4 * toL);
    add('browOuterUp_R', 0.5 * up + 0.4 * toR);
    add('browDown_L', 0.5 * Math.max(-y, 0));
    add('browDown_R', 0.5 * Math.max(-y, 0));
    add('noseSneer_L', 0.03 + 0.05 * breath + 0.5 * toL);
    add('noseSneer_R', 0.03 + 0.05 * breath + 0.5 * toR);

    return { morphs: t, pose };
  }

  // ---- frame loop --------------------------------------------------------

  _blink() {
    if (this.blinkT < 0) {
      if (this.time >= this.blinkAt) this.blinkT = 0;
      return 0;
    }
    this.blinkT += this._dt;
    const k = this.blinkT / 0.2;
    if (k >= 1) {
      this.blinkT = -1;
      this.doubleBlink = !this.doubleBlink && Math.random() < 0.2;
      this.blinkAt = this.time + (this.doubleBlink ? 0.12 : rand(2.5, 6));
      return 0;
    }
    return Math.sin(k * Math.PI);
  }

  update(dt) {
    this._dt = dt;
    this.time += dt;
    const ease = (rate) => 1 - Math.exp(-rate * dt);

    // Gaze eases gently instead of snapping.
    this.gaze.x += (this.gazeTarget.x - this.gaze.x) * ease(9);
    this.gaze.y += (this.gazeTarget.y - this.gaze.y) * ease(9);

    const asleep = this.state === 'sleep';
    if (!asleep && this.time >= this.nextSaccadeAt) {
      this.saccadeTarget = { x: rand(-0.09, 0.09), y: rand(-0.06, 0.06) };
      this.nextSaccadeAt = this.time + rand(0.25, 1.1);
    }
    this.saccade.x += (this.saccadeTarget.x - this.saccade.x) * ease(30);
    this.saccade.y += (this.saccadeTarget.y - this.saccade.y) * ease(30);

    const { morphs, pose } = this._targets();
    const blink = asleep ? 0 : this._blink();

    // Expressions: smooth towards targets (names missing from targets decay to 0).
    const names = new Set([...Object.keys(this.cur), ...Object.keys(morphs)]);
    for (const n of names) {
      const target = morphs[n] ?? 0;
      const c = this.cur[n] ?? 0;
      this.cur[n] = c + (target - c) * ease(n.startsWith('eyeLook') ? 12 : FAST_MORPHS.test(n) ? 24 : 5);
    }

    for (const mesh of this.morphMeshes) {
      const dict = mesh.morphTargetDictionary;
      const inf = mesh.morphTargetInfluences;
      for (const n in this.cur) {
        const i = dict[n];
        if (i === undefined) continue;
        let v = this.cur[n];
        if (n === 'eyeBlink_L' || n === 'eyeBlink_R') v = Math.max(v, blink);
        inf[i] = clamp01(v);
      }
      for (const n of ['eyeBlink_L', 'eyeBlink_R']) {
        if (this.cur[n] === undefined && dict[n] !== undefined) inf[dict[n]] = blink;
      }
    }

    // The eyeball meshes carry no blend shapes: rotate them (local x = pitch, local z = yaw).
    if (this.eyes && this.eyeAim) {
      for (const eye of this.eyes) {
        eye.rotation.x = EYE_REST_PITCH - this.eyeAim.y * EYE_ROTATION_LIMIT;
        eye.rotation.z = -this.eyeAim.x * EYE_ROTATION_LIMIT;
      }
    }

    // Head pose + subtle breathing.
    for (const k of ['pitch', 'yaw', 'roll']) {
      this.pose[k] += (pose[k] - this.pose[k]) * ease(4);
    }
    this.pivot.rotation.set(this.pose.pitch, this.baseYaw + this.pose.yaw, this.pose.roll);
    if (this.modelSize) this.pivot.position.y = asleep ? 0 : Math.sin(this.time * 1.5) * this.modelSize.y * 0.0025;
  }

  start() {
    if (this.running) return;
    this.running = true;
    let last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.update(dt);
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
  }
}
