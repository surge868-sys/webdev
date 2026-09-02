/*
 * CLEARANCE 3D — self-contained game module.
 * startGame(root) builds renderer + HUD inside `root` and returns a cleanup function.
 * Everything is procedural geometry; no assets. See PLAN.md for the state shape,
 * world-scroll scheme and collision spans.
 */
import * as THREE from 'three';

// ───────────────────────────── constants ─────────────────────────────
const LANE_X = [-3.8, 0, 3.8];
const ROAD_HALF = 5.7;
const PIER_X = [-1.9, 1.9];
const PIER_HALF = 0.25;
const LOAD_HALF_W = 1.3;
const LOAD_Z0 = 1.7; // collision span start (metres ahead of truck origin)
const LOAD_Z1 = 10.3; // collision span end
const BED_H = 1.3; // trailer deck height
const LANE_LERP = 5;
const DUCK_MAX = 0.4;
const DUCK_SPEED = DUCK_MAX / 0.2;
const SPRING_K = 8;
const SPRING_C = 5;
const AIR_DRAIN = 1 / 4.2;
const AIR_REFILL = 1 / 5.0;
const AIR_RELOCK = 0.2;
const THROTTLE_SPEED = 1.35;
const THROTTLE_SCORE = 2;
const BASE_SPEED = 16;
const SPEED_PER_M = 0.012;
const SPEED_CAP = 36;
const FIRST_BRIDGE = 55;
const SHAVE_CM = 0.1;
const SHAVE_CHAIN = [3, 5, 7, 9, 10];
const SHAVE_LEN = 200;
const CAM_UP = 5.6;
const CAM_BACK = 12.6;
const LOOK_AHEAD = 230;

const BRIDGE_NAMES = [
  'RANGE ROAD 3054 OVERPASS',
  'TOWNSHIP ROAD 512 OVERPASS',
  'GRAIN LINE RY. BRIDGE',
  'PERIMETER HWY FLYOVER',
  'ELEVATOR ROAD OVERPASS',
  'CIRCLE DRIVE INTERCHANGE',
  'BRIDGEPORT CITY LIMITS OVERPASS',
  'RIVER VALLEY APPROACH',
  'COLLEGE DRIVE OVERPASS',
  'NORTH INDUSTRIAL FLYOVER',
  'OLD HIGHWAY 7 BRIDGE',
  'GRAIN TERMINAL SPUR BRIDGE',
];

// ───────────────────────────── utilities ─────────────────────────────
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const step05 = (v: number) => Math.round(v * 20) / 20;
const fmtM = (v: number) => v.toFixed(2) + ' m';

const FONT = "'Oswald', var(--font-hud), 'Arial Narrow', 'Roboto Condensed', Impact, sans-serif";

function canvasTex(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const c = cv.getContext('2d')!;
  draw(c);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function textTex(text: string, bg: string, fg: string, w = 256, h = 128, size = 88, border = '#111') {
  return canvasTex(w, h, (c) => {
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);
    c.lineWidth = 10;
    c.strokeStyle = border;
    c.strokeRect(5, 5, w - 10, h - 10);
    c.fillStyle = fg;
    c.font = `700 ${size}px ${FONT}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, w / 2, h / 2 + 4);
  });
}

function stripeTex() {
  return canvasTex(256, 32, (c) => {
    c.fillStyle = '#f2b32a';
    c.fillRect(0, 0, 256, 32);
    c.fillStyle = '#111';
    for (let x = -32; x < 256; x += 64) {
      c.beginPath();
      c.moveTo(x, 32);
      c.lineTo(x + 32, 0);
      c.lineTo(x + 64, 0);
      c.lineTo(x + 32, 32);
      c.fill();
    }
  });
}

function roadTex() {
  const t = canvasTex(256, 512, (c) => {
    c.fillStyle = '#4b4d52';
    c.fillRect(0, 0, 256, 512);
    // subtle grain
    for (let i = 0; i < 600; i++) {
      c.fillStyle = Math.random() < 0.5 ? '#45474c' : '#52545a';
      c.fillRect(Math.random() * 256, Math.random() * 512, 3, 3);
    }
    const px = (x: number) => ((x + ROAD_HALF) / (ROAD_HALF * 2)) * 256;
    c.fillStyle = '#e8e2c8';
    c.fillRect(px(-ROAD_HALF) + 2, 0, 5, 512);
    c.fillRect(px(ROAD_HALF) - 7, 0, 5, 512);
    c.fillStyle = '#f0e6a0';
    for (const x of PIER_X) for (let y = 0; y < 512; y += 128) c.fillRect(px(x) - 2, y, 4, 64);
  });
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

function skyTex(top: string, mid: string, hor: string) {
  const t = canvasTex(4, 256, (c) => {
    const g = c.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, top);
    g.addColorStop(0.55, mid);
    g.addColorStop(1, hor);
    c.fillStyle = g;
    c.fillRect(0, 0, 4, 256);
  });
  return t;
}

// ───────────────────────────── types ─────────────────────────────
type Verdict = 'fit' | 'duck' | 'no';
interface Lane {
  clear: number;
  deck: THREE.Mesh;
  plate: THREE.Mesh;
  lamp: THREE.Mesh;
  board: THREE.Mesh;
  verdict: Verdict;
}
interface Bridge {
  id: number;
  w: number; // world metre of near face
  depth: number;
  kind: 'girder' | 'steel' | 'rail';
  name: string;
  lanes: Lane[];
  group: THREE.Group;
  piers: THREE.Mesh[];
  cleared: boolean;
  minMargin: number;
  active: boolean;
  faceHidden: boolean;
}
interface Chunk {
  m: THREE.Mesh;
  v: THREE.Vector3;
  av: THREE.Vector3;
}
interface Scenery {
  m: THREE.Object3D;
  w: number;
  x: number;
  span: number;
}

type Phase = 'title' | 'run' | 'crash' | 'fail';

export interface GameSnapshot {
  phase: Phase;
  dist: number;
  speed: number;
  throttle: boolean;
  mult: number;
  score: number;
  lane: number;
  laneX: number;
  hold: boolean;
  lowered: number;
  air: number;
  airLocked: boolean;
  loadH: number;
  hEff: number;
  cleared: number;
  shaveChain: number;
  crashKind: string | null;
  bridges: { w: number; depth: number; kind: string; name: string; clears: number[]; verdicts: Verdict[] }[];
}

declare global {
  interface Window {
    __game?: () => GameSnapshot;
    __gameWarp?: (metres: number) => void;
    __gameInput?: (action: string) => void;
  }
}

// ───────────────────────────── HUD markup ─────────────────────────────
const CSS = `
.c3-root{position:relative;width:100%;height:100%;overflow:hidden;background:#6ea7dd;font-family:${FONT};color:#fff;user-select:none;-webkit-user-select:none;touch-action:none;-webkit-tap-highlight-color:transparent}
.c3-root canvas{display:block;width:100%;height:100%}
.c3-hud{position:absolute;inset:0;pointer-events:none}
.c3-hud *{box-sizing:border-box}
.c3-sign{position:absolute;padding:6px 12px;border-radius:6px;letter-spacing:.04em;text-transform:uppercase;line-height:1.05}
.c3-guide{top:max(10px,env(safe-area-inset-top));left:10px;background:#0b6b3a;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35);min-width:128px}
.c3-guide .l{font-size:11px;opacity:.85}
.c3-guide .v{font-size:30px;font-weight:700}
.c3-guide .m{font-size:13px;color:#ffd24a;font-weight:700;min-height:15px}
.c3-reg{top:max(10px,env(safe-area-inset-top));right:10px;background:#fff;color:#111;border:3px solid #111;text-align:center;min-width:96px}
.c3-reg .l{font-size:11px}
.c3-reg .v{font-size:26px;font-weight:700}
.c3-reg.red{background:#d33;color:#fff;border-color:#fff}
.c3-next{position:absolute;top:calc(max(10px,env(safe-area-inset-top)) + 84px);left:50%;transform:translateX(-50%);display:flex;gap:6px}
.c3-chip{width:64px;padding:4px 0;text-align:center;border-radius:4px;font-weight:700;font-size:16px;border:2px solid #111;background:#888;color:#111;transition:background .1s}
.c3-chip.fit{background:#2fd06a}.c3-chip.duck{background:#f2b32a}.c3-chip.no{background:#e2382f;color:#fff}
.c3-chip small{display:block;font-size:10px;font-weight:400;letter-spacing:.08em}
.c3-air{position:absolute;left:50%;bottom:calc(max(18px,env(safe-area-inset-bottom)) + 64px);transform:translateX(-50%);width:min(60vw,260px);height:16px;border:2px solid #fff;border-radius:8px;background:rgba(0,0,0,.45);overflow:hidden}
.c3-air i{display:block;height:100%;width:100%;background:#4fd2ff;transform-origin:left;transition:background .15s}
.c3-air.low i{background:#f2b32a}.c3-air.lock i{background:#e2382f}
.c3-airlbl{position:absolute;left:50%;bottom:calc(max(18px,env(safe-area-inset-bottom)) + 84px);transform:translateX(-50%);font-size:12px;letter-spacing:.14em;text-shadow:0 1px 2px #000}
.c3-btn{position:absolute;bottom:max(18px,env(safe-area-inset-bottom));width:64px;height:52px;border:2px solid #fff;border-radius:8px;background:rgba(0,0,0,.45);color:#fff;font:700 28px ${FONT};display:flex;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer}
.c3-btn:active{background:#fff;color:#111}
#c3-left{left:12px}#c3-right{right:12px}
.c3-hint{position:absolute;left:50%;bottom:max(24px,env(safe-area-inset-bottom));transform:translateX(-50%);font-size:14px;letter-spacing:.16em;text-shadow:0 1px 3px #000;white-space:nowrap}
.c3-banner{position:absolute;left:50%;top:38%;transform:translate(-50%,-50%) scale(.6);font-size:42px;font-weight:700;letter-spacing:.06em;text-shadow:0 3px 0 #000,0 0 18px rgba(0,0,0,.5);opacity:0;transition:opacity .15s,transform .15s;white-space:nowrap;text-align:center}
.c3-banner.show{opacity:1;transform:translate(-50%,-50%) scale(1)}
.c3-banner small{display:block;font-size:18px;letter-spacing:.2em;color:#ffd24a}
.c3-card{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(10,12,20,.55);pointer-events:auto}
.c3-card.show{display:flex}
.c3-panel{width:min(92vw,420px);background:#fff;color:#111;border:4px solid #111;border-radius:8px;padding:16px 18px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.5)}
.c3-panel h1{margin:0;font-size:40px;letter-spacing:.06em;line-height:1;color:#e2382f}
.c3-panel h2{margin:4px 0 12px;font-size:14px;letter-spacing:.18em;font-weight:400;color:#444}
.c3-panel .rows{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;text-align:left;font-size:15px;margin-bottom:14px}
.c3-panel .rows b{font-size:22px;display:block}
.c3-panel .go{display:inline-block;background:#0b6b3a;color:#fff;border:3px solid #111;border-radius:6px;padding:10px 26px;font:700 22px ${FONT};letter-spacing:.1em;cursor:pointer;pointer-events:auto}
.c3-panel .go:active{background:#094f2b}
.c3-title{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding-bottom:max(8vh,env(safe-area-inset-bottom));pointer-events:auto;cursor:pointer}
.c3-title .logo{background:#0b6b3a;border:4px solid #fff;border-radius:8px;padding:8px 20px 12px;text-align:center;box-shadow:0 6px 30px rgba(0,0,0,.35);margin-bottom:14px}
.c3-title .logo b{display:block;font-size:min(13vw,64px);line-height:1;letter-spacing:.04em}
.c3-title .logo i{display:block;font-style:normal;font-size:min(3.6vw,15px);letter-spacing:.24em;opacity:.9;margin-top:2px}
.c3-title .diamond{background:#f2b32a;color:#111;border:3px solid #111;padding:6px 14px;font-size:15px;letter-spacing:.1em;transform:rotate(-2deg);margin-bottom:22px;text-align:center;line-height:1.3}
.c3-title .tap{font-size:22px;letter-spacing:.3em;animation:c3pulse 1.2s infinite}
.c3-title .how{margin-top:10px;font-size:13px;letter-spacing:.12em;opacity:.9;text-align:center;line-height:1.6}
@keyframes c3pulse{0%,100%{opacity:1}50%{opacity:.35}}
.c3-flash{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none}
.c3-hud.hidden{display:none}
`;

const HUD_HTML = `
<div class="c3-hud" id="c3-hud">
  <div class="c3-sign c3-guide"><div class="l">Hauled</div><div class="v"><span id="c3-km">0.00</span> km</div><div class="m" id="c3-mult"></div></div>
  <div class="c3-sign c3-reg" id="c3-reg"><div class="l">Load</div><div class="v" id="c3-h">4.30</div></div>
  <div class="c3-next" id="c3-next"><div class="c3-chip" id="c3-chip0">–</div><div class="c3-chip" id="c3-chip1">–</div><div class="c3-chip" id="c3-chip2">–</div></div>
  <div class="c3-airlbl">AIR</div><div class="c3-air" id="c3-air"><i id="c3-airbar"></i></div>
  <div class="c3-btn" id="c3-left">◀</div><div class="c3-btn" id="c3-right">▶</div>
  <div class="c3-hint" id="c3-hint">HOLD TO DUCK · SWIPE TO CHANGE LANE</div>
  <div class="c3-banner" id="c3-banner"></div>
</div>
<div class="c3-flash" id="c3-flash"></div>
<div class="c3-title" id="c3-title">
  <div class="logo"><b>CLEARANCE</b><i>OVERSIZE LOAD · BRIDGEPORT APPROACH</i></div>
  <div class="diamond">LOW CLEARANCE AHEAD<br>READ THE PLATES. DUCK THE LOAD.</div>
  <div class="tap">TAP TO HAUL</div>
  <div class="how">SWIPE ◀ ▶ LANE · HOLD ANYWHERE TO DUCK<br>KEYS: ← → · SPACE</div>
</div>
<div class="c3-card" id="c3-card"><div class="c3-panel">
  <h1 id="c3-kind">BRIDGE STRIKE</h1><h2 id="c3-bname">—</h2>
  <div class="rows">
    <div>Hauled<b id="c3-fkm">0.00 km</b></div><div>Top multiplier<b id="c3-fmult">×1</b></div>
    <div>Bridges cleared<b id="c3-fcl">0</b></div><div>Best<b id="c3-fbest">0.00 km</b></div>
  </div>
  <div class="go" id="c3-restart">HAUL AGAIN</div>
</div></div>`;

// ───────────────────────────── the game ─────────────────────────────
export function startGame(root: HTMLElement, opts: { seed?: number } = {}): () => void {
  root.classList.add('c3-root');
  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);
  const wrap = document.createElement('div');
  wrap.innerHTML = HUD_HTML;
  const reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  root.appendChild(renderer.domElement);
  root.appendChild(wrap);
  const $ = (id: string) => wrap.querySelector<HTMLElement>('#' + id)!;
  const el = {
    hud: $('c3-hud'), km: $('c3-km'), mult: $('c3-mult'), reg: $('c3-reg'), h: $('c3-h'),
    chips: [$('c3-chip0'), $('c3-chip1'), $('c3-chip2')], air: $('c3-air'), airbar: $('c3-airbar'),
    left: $('c3-left'), right: $('c3-right'), hint: $('c3-hint'), banner: $('c3-banner'), flash: $('c3-flash'),
    title: $('c3-title'), card: $('c3-card'), kind: $('c3-kind'), bname: $('c3-bname'), fkm: $('c3-fkm'),
    fmult: $('c3-fmult'), fcl: $('c3-fcl'), fbest: $('c3-fbest'), restart: $('c3-restart'),
  };

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(52, 1, 0.3, 1400);
  scene.add(camera);

  // sky + fog (golden hour for M1; time-of-day drift lands in M3)
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1000, 24, 12),
    new THREE.MeshBasicMaterial({ map: skyTex('#6ea7dd', '#a9cae6', '#f6dfa6'), side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  sky.rotation.x = 0; // gradient is along V (pole to pole)
  scene.add(sky);
  scene.fog = new THREE.Fog('#e9dcb5', 140, 430);

  // lights: one shadow caster
  const hemi = new THREE.HemisphereLight('#bfd8ff', '#8a7a3a', 0.85);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#ffe2b0', 2.2);
  sun.position.set(-30, 40, -20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -40; sc.right = 40; sc.top = 40; sc.bottom = -40; sc.near = 1; sc.far = 160;
  sun.shadow.bias = -0.0015;
  scene.add(sun, sun.target);

  // ground + road
  const M = {
    lambert: (color: string, extra: Partial<THREE.MeshLambertMaterialParameters> = {}) =>
      new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra }),
    basic: (color: string, extra: Partial<THREE.MeshBasicMaterialParameters> = {}) =>
      new THREE.MeshBasicMaterial({ color, ...extra }),
  };
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), M.lambert('#c9a83c'));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.receiveShadow = true;
  scene.add(ground);
  // alternating crop bands (rough M1 fields; M3 does the real quarters)
  const fieldPool: Scenery[] = [];
  const fieldCols = ['#e9c62d', '#b8a34a', '#8f8a5c', '#7a6a3f'];
  for (let i = 0; i < 12; i++) {
    for (const side of [-1, 1]) {
      const g = new THREE.Mesh(new THREE.PlaneGeometry(320, 160), M.lambert(fieldCols[(i + (side > 0 ? 2 : 0)) % 4]));
      g.rotation.x = -Math.PI / 2;
      g.receiveShadow = true;
      scene.add(g);
      fieldPool.push({ m: g, w: i * 160, x: side * (160 + 8), span: 12 * 160 });
    }
  }
  const roadT = roadTex();
  roadT.repeat.set(1, 60);
  const road = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, 720), new THREE.MeshLambertMaterial({ map: roadT }));
  road.rotation.x = -Math.PI / 2;
  road.position.set(0, 0.01, -300);
  road.receiveShadow = true;
  scene.add(road);
  const shoulder = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2 + 3.2, 720), M.lambert('#9a8f74'));
  shoulder.rotation.x = -Math.PI / 2;
  shoulder.position.set(0, 0.005, -300);
  shoulder.receiveShadow = true;
  scene.add(shoulder);

  // recycled roadside scenery
  const scenery: Scenery[] = [];
  const poleGeo = new THREE.CylinderGeometry(0.12, 0.16, 9, 5);
  const armGeo = new THREE.BoxGeometry(2, 0.14, 0.14);
  const poleMat = M.lambert('#6b5030');
  for (let i = 0; i < 18; i++) {
    const g = new THREE.Group();
    const p = new THREE.Mesh(poleGeo, poleMat);
    p.position.y = 4.5;
    p.castShadow = true;
    const a = new THREE.Mesh(armGeo, poleMat);
    a.position.y = 8.4;
    g.add(p, a);
    scene.add(g);
    scenery.push({ m: g, w: i * 40, x: 9.5, span: 18 * 40 });
  }
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.25, 3, 5);
  const crownGeo = new THREE.IcosahedronGeometry(2.2, 0);
  const trunkMat = M.lambert('#d9d2b8');
  const crownMats = [M.lambert('#5f8f3a'), M.lambert('#7aa244'), M.lambert('#d8b23a')];
  const rngFx = mulberry32(0x5eed ^ 0x9e37);
  for (let i = 0; i < 40; i++) {
    const g = new THREE.Group();
    const t = new THREE.Mesh(trunkGeo, trunkMat);
    t.position.y = 1.5;
    const c = new THREE.Mesh(crownGeo, crownMats[Math.floor(rngFx() * 3)]);
    c.position.y = 3.6 + rngFx();
    c.castShadow = true;
    const s = 0.8 + rngFx() * 0.6;
    g.scale.setScalar(s);
    g.add(t, c);
    scene.add(g);
    const side = rngFx() < 0.5 ? -1 : 1;
    scenery.push({ m: g, w: rngFx() * 900, x: side * (14 + rngFx() * 60), span: 900 });
  }
  const baleGeo = new THREE.CylinderGeometry(0.8, 0.8, 1.3, 10);
  const baleMat = M.lambert('#d8b86a');
  for (let i = 0; i < 16; i++) {
    const b = new THREE.Mesh(baleGeo, baleMat);
    b.rotation.z = Math.PI / 2;
    b.position.y = 0.8;
    b.castShadow = true;
    scene.add(b);
    const side = rngFx() < 0.5 ? -1 : 1;
    scenery.push({ m: b, w: rngFx() * 700, x: side * (12 + rngFx() * 30), span: 700 });
  }
  // distant skyline placeholder (M3 grows it)
  const city = new THREE.Group();
  for (let i = 0; i < 14; i++) {
    const h = 20 + rngFx() * 70;
    const b = new THREE.Mesh(new THREE.BoxGeometry(10 + rngFx() * 14, h, 10 + rngFx() * 14), M.lambert('#8d97ad'));
    b.position.set((rngFx() - 0.5) * 220, h / 2, 0);
    city.add(b);
  }
  city.position.set(0, 0, -1150);
  scene.add(city);

  // ─── truck ───
  const truck = new THREE.Group();
  scene.add(truck);
  const wheelGeo = new THREE.CylinderGeometry(0.52, 0.52, 0.4, 10);
  const wheelMat = M.lambert('#1c1c1e');
  const addWheel = (x: number, z: number) => {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, 0.52, z);
    w.castShadow = true;
    truck.add(w);
    return w;
  };
  const wheels: THREE.Mesh[] = [];
  for (const z of [-1.2, -2.5, -13.0, -14.6]) for (const x of [-1.05, 1.05]) wheels.push(addWheel(x, z));
  // trailer: deck from z=0 (rear) to z=-12 (front), matches LOAD span [1.7,10.3]
  const bed = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.25, 12), M.lambert('#3a3f4a'));
  bed.position.set(0, BED_H - 0.125, -6);
  bed.castShadow = true;
  truck.add(bed);
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 12.4), M.lambert('#2a2d34'));
  chassis.position.set(0, 0.85, -6.1);
  truck.add(chassis);
  const bumper = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, 0.2), stripedMat());
  bumper.position.set(0, 0.8, 0.1);
  truck.add(bumper);
  // cab
  const cab = new THREE.Group();
  cab.position.z = -12.2;
  const cabBox = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.4, 2.2), M.lambert('#d8382b'));
  cabBox.position.set(0, 2.3, -1.4);
  cabBox.castShadow = true;
  const hood = new THREE.Mesh(new THREE.BoxGeometry(2.3, 1.3, 1.6), M.lambert('#d8382b'));
  hood.position.set(0, 1.55, -3.1);
  hood.castShadow = true;
  const win = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.9, 0.1), M.lambert('#6fb7e8'));
  win.position.set(0, 2.7, -2.55);
  const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.2, 6), M.lambert('#c9ccd1'));
  stack.position.set(1.15, 3.2, -0.6);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.5), new THREE.MeshBasicMaterial({ map: textTex('OVERSIZE LOAD', '#f2b32a', '#111', 512, 108, 72) }));
  sign.position.set(0, 3.75, -0.28);
  sign.rotation.y = Math.PI;
  cab.add(cabBox, hood, win, stack, sign);
  truck.add(cab);
  // load group (hydraulics move this)
  const loadG = new THREE.Group();
  truck.add(loadG);
  const loadMesh: THREE.Group = buildExcavatorLoad();
  loadG.add(loadMesh);

  function stripedMat() {
    const t = stripeTex();
    t.wrapS = THREE.RepeatWrapping;
    t.repeat.set(3, 1);
    return new THREE.MeshLambertMaterial({ map: t });
  }
  // M1 has one load: the excavator with its boom half-down (top at 4.30 m). Ten loads land in M4.
  function buildExcavatorLoad(): THREE.Group {
    const g = new THREE.Group();
    const y0 = BED_H;
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.3, 3.6), M.lambert('#e8a21a'));
    body.position.set(0, y0 + 1.15, -6);
    body.castShadow = true;
    const tracks = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, 4.2), M.lambert('#2c2c2c'));
    tracks.position.set(0, y0 + 0.25, -6);
    const house = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.1, 1.6), M.lambert('#e8a21a'));
    house.position.set(0.4, y0 + 2.3, -5.4);
    house.castShadow = true;
    const glass = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.7, 0.1), M.lambert('#9fd3ef'));
    glass.position.set(-0.4, y0 + 2.4, -4.55);
    // boom: rises from body toward the front and folds down; top of the boom = 4.30 m
    const boom = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 4.2), M.lambert('#e8a21a'));
    boom.position.set(-0.5, y0 + 2.45, -8.3);
    boom.rotation.x = -0.33;
    boom.castShadow = true;
    const stick = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 3.0), M.lambert('#d9941a'));
    stick.position.set(-0.5, y0 + 2.2, -1.9 - 0.4);
    stick.rotation.x = 0.55;
    const bucket = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.7, 0.8), M.lambert('#3b3b3b'));
    bucket.position.set(-0.5, y0 + 0.75, -1.9);
    g.add(body, tracks, house, glass, boom, stick, bucket);
    // the true top: a small cap marks 4.30 m at the boom's knuckle (collision uses loadH, not the mesh)
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.25, 0.7), M.lambert('#c8262d'));
    cap.position.set(-0.5, 4.3 - 0.125, -9.9);
    g.add(cap);
    // amber markers along the load's collision span so the span is legible from the chase cam
    const mk = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 0.12), M.basic('#ffb300'));
    mk.position.set(0, y0 + 0.06, -LOAD_Z0);
    const mk2 = mk.clone();
    mk2.position.z = -LOAD_Z1;
    g.add(mk, mk2);
    return g;
  }

  // marker bar at next bridge
  const marker = new THREE.Mesh(new THREE.BoxGeometry(LOAD_HALF_W * 2, 0.08, 0.3), M.basic('#2fd06a'));
  marker.visible = false;
  scene.add(marker);

  // ─── bridges ───
  const plateBG = '#f2c12e';
  const lampTex: Record<Verdict, THREE.Texture> = {
    fit: textTex('FITS', '#1f8f3f', '#fff', 256, 128, 80, '#0d4a20'),
    duck: textTex('DUCK ▼', '#f2b32a', '#111', 256, 128, 72, '#7a5a00'),
    no: textTex('✕', '#e2382f', '#fff', 256, 128, 96, '#6a1410'),
  };
  const lampMat: Record<Verdict, THREE.MeshBasicMaterial> = {
    fit: new THREE.MeshBasicMaterial({ map: lampTex.fit }),
    duck: new THREE.MeshBasicMaterial({ map: lampTex.duck }),
    no: new THREE.MeshBasicMaterial({ map: lampTex.no }),
  };
  const plateCache = new Map<string, THREE.MeshBasicMaterial>();
  const plateMatFor = (clear: number) => {
    const k = clear.toFixed(2);
    let m = plateCache.get(k);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ map: textTex(fmtM(clear), plateBG, '#111', 256, 128, 86) });
      plateCache.set(k, m);
    }
    return m;
  };
  const boardMat = new THREE.MeshBasicMaterial({ map: (() => { const t = stripeTex(); t.wrapS = THREE.RepeatWrapping; t.repeat.set(2, 1); return t; })() });
  const concrete = M.lambert('#b9b4a8');
  const concreteDark = M.lambert('#9c978c');
  const steelGreen = M.lambert('#2f6b4a');
  const railDark = M.lambert('#3b3a38');
  const ballast = M.lambert('#6d6a63');
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const bridges: Bridge[] = [];
  let bridgeSeq = 0;

  function makeBridge(): Bridge {
    const group = new THREE.Group();
    group.visible = false;
    scene.add(group);
    const lanes: Lane[] = [];
    for (let i = 0; i < 3; i++) {
      const deck = new THREE.Mesh(unitBox, concrete);
      deck.castShadow = true;
      deck.receiveShadow = true;
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.75), plateMatFor(4.3));
      const lamp = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.85), lampMat.fit);
      const board = new THREE.Mesh(unitBox, boardMat);
      group.add(deck, plate, lamp, board);
      lanes.push({ clear: 4.3, deck, plate, lamp, board, verdict: 'fit' });
    }
    const piers: THREE.Mesh[] = [];
    for (let i = 0; i < 4; i++) {
      const p = new THREE.Mesh(unitBox, concreteDark);
      p.castShadow = true;
      group.add(p);
      piers.push(p);
    }
    return { id: 0, w: 0, depth: 10, kind: 'girder', name: '', lanes, group, piers, cleared: false, minMargin: 9, active: false, faceHidden: false };
  }
  for (let i = 0; i < 8; i++) bridges.push(makeBridge());

  function layoutBridge(b: Bridge) {
    const d = b.depth;
    const isRail = b.kind === 'rail';
    const deckMat = b.kind === 'steel' ? steelGreen : isRail ? railDark : concrete;
    const thick = isRail ? 1.4 : 1.1;
    for (let i = 0; i < 3; i++) {
      const L = b.lanes[i];
      const x = LANE_X[i];
      const wdt = i === 1 ? 3.8 : 3.8 + 2.4; // outer spans reach past the shoulder
      const cx = i === 0 ? x - 1.2 : i === 2 ? x + 1.2 : x;
      L.deck.material = deckMat;
      L.deck.position.set(cx, L.clear + thick / 2, -d / 2);
      L.deck.scale.set(wdt, thick, d);
      L.plate.material = plateMatFor(L.clear);
      L.plate.position.set(x, L.clear + thick * 0.55, 0.02);
      L.lamp.position.set(x, L.clear + thick + 0.7, 0.02);
      L.board.position.set(cx, L.clear + 0.14, 0.03);
      L.board.scale.set(wdt, 0.28, 0.06);
      L.plate.visible = L.lamp.visible = L.board.visible = true;
    }
    // parapet along the top edge (near side) for the stepped kinds, ballast + rails for rail
    for (let i = 0; i < 4; i++) {
      const p = b.piers[i];
      if (i < 2) {
        // interior piers on span boundaries
        const px = PIER_X[i];
        const hL = Math.max(b.lanes[i].clear, b.lanes[i + 1].clear) + (isRail ? 0.3 : 0.6);
        p.visible = !isRail;
        p.material = b.kind === 'steel' ? concreteDark : concreteDark;
        p.position.set(px, hL / 2, -d / 2);
        p.scale.set(PIER_HALF * 2, hL, Math.max(2.2, d - 3));
      } else {
        // abutments beyond the road edge
        const side = i === 2 ? -1 : 1;
        const lane = b.lanes[i === 2 ? 0 : 2];
        const hA = lane.clear + 0.6;
        p.visible = true;
        p.material = concreteDark;
        p.position.set(side * (ROAD_HALF + 2.4), hA / 2, -d / 2);
        p.scale.set(2.4, hA, d);
      }
    }
    b.group.visible = true;
  }

  // ─── crash chunks ───
  const chunks: Chunk[] = [];
  const chunkMats = [M.lambert('#e8a21a'), M.lambert('#d9941a'), M.lambert('#b9b4a8'), M.lambert('#3b3b3b')];
  for (let i = 0; i < 22; i++) {
    const s = 0.35 + rngFx() * 0.7;
    const m = new THREE.Mesh(unitBox, chunkMats[i % 4]);
    m.scale.set(s, s * (0.6 + rngFx() * 0.8), s);
    m.visible = false;
    m.castShadow = true;
    scene.add(m);
    chunks.push({ m, v: new THREE.Vector3(), av: new THREE.Vector3() });
  }

  // ─── state ───
  const seed = opts.seed ?? ((Date.now() ^ (Math.random() * 1e9)) >>> 0);
  let rngWorld = mulberry32(seed);
  const G = {
    phase: 'title' as Phase,
    dist: 0, speed: BASE_SPEED, throttle: false, mult: 1, score: 0,
    lane: 1, laneX: 0, hold: false, lowered: 0, lowerVel: 0, air: 1, airLocked: false,
    loadH: 4.3, gustLift: 0, potholeBounce: 0,
    cleared: 0, shaveChain: 0, shaveUntil: -1, topMult: 1,
    bridgeCount: 0, nextW: FIRST_BRIDGE,
    crashKind: null as string | null, crashBridge: '', crashT: 0, crashPt: new THREE.Vector3(),
    shake: 0, time: 0, best: 0,
  };
  try { G.best = parseFloat(localStorage.getItem('clr3d.best') || '0') || 0; } catch { /* private mode */ }
  const hEff = () => G.loadH - G.lowered + G.gustLift + G.potholeBounce;
  const hMin = () => G.loadH - DUCK_MAX + G.gustLift + G.potholeBounce; // fully lowered

  // ─── clearance generation (relative to load height h, 0.05 m steps) ───
  function solutionClear(h: number): number {
    const r = rngWorld();
    if (r < 0.3) return step05(h + [0.03, 0.05, 0.08][Math.floor(rngWorld() * 3)] + 0.001); // graze
    if (r < 0.6) return step05(h + 0.15 + rngWorld() * 0.25); // easy
    if (r < 0.85) return step05(h - 0.25 + rngWorld() * 0.2); // tight
    return step05(h - 0.35 + rngWorld() * 0.1); // max
  }
  function decoyClear(h: number): number {
    return rngWorld() < 0.45 ? step05(h - 0.25 + rngWorld() * 0.2) : step05(h - 0.85 + rngWorld() * 0.3);
  }
  function spawnBridge(b: Bridge, w: number, idx: number) {
    b.id = ++bridgeSeq;
    b.w = w;
    b.depth = 9 + rngWorld() * 5;
    b.cleared = false;
    b.minMargin = 9;
    b.active = true;
    b.faceHidden = false;
    const isRail = idx % 3 === 2 && idx > 1;
    b.kind = isRail ? 'rail' : rngWorld() < 0.5 ? 'girder' : 'steel';
    b.name = isRail ? 'GRAIN LINE RY. BRIDGE' : BRIDGE_NAMES[Math.floor(rngWorld() * BRIDGE_NAMES.length)];
    const h = G.loadH;
    if (idx < 2) {
      const c = idx === 0 ? step05(h + 0.25) : step05(h + 0.2);
      for (const L of b.lanes) L.clear = c;
    } else if (isRail) {
      const c = solutionClear(h);
      for (const L of b.lanes) L.clear = c;
    } else {
      const sol = Math.floor(rngWorld() * 3);
      for (let i = 0; i < 3; i++) b.lanes[i].clear = i === sol ? solutionClear(h) : decoyClear(h);
    }
    // guarantee at least one survivable lane even after rounding
    if (!b.lanes.some((L) => L.clear >= hMin() + 0.02)) b.lanes[Math.floor(rngWorld() * 3)].clear = step05(h - 0.3);
    layoutBridge(b);
    updateVerdicts(b, G.loadH, G.loadH - DUCK_MAX);
  }
  function spacing(): number {
    return Math.max(78, 108 + rngWorld() * 55 - 0.015 * G.dist);
  }
  function fillBridges() {
    while (G.nextW < G.dist + 520) {
      const free = bridges.find((b) => !b.active);
      if (!free) break;
      spawnBridge(free, G.nextW, G.bridgeCount++);
      G.nextW += spacing();
    }
  }
  function resetBridges() {
    for (const b of bridges) { b.active = false; b.group.visible = false; }
    G.bridgeCount = 0;
    G.nextW = G.dist + FIRST_BRIDGE;
    fillBridges();
  }
  function updateVerdicts(b: Bridge, hNow: number, hLow: number) {
    for (const L of b.lanes) {
      const v: Verdict = L.clear >= hNow ? 'fit' : L.clear >= hLow ? 'duck' : 'no';
      if (v !== L.verdict) { L.verdict = v; L.lamp.material = lampMat[v]; }
    }
  }

  // ─── run control ───
  function resetRun() {
    G.dist = 0; G.speed = BASE_SPEED; G.throttle = false; G.mult = 1; G.score = 0;
    G.lane = 1; G.laneX = 0; G.hold = false; G.lowered = 0; G.lowerVel = 0; G.air = 1; G.airLocked = false;
    G.gustLift = 0; G.potholeBounce = 0; G.cleared = 0; G.shaveChain = 0; G.shaveUntil = -1; G.topMult = 1;
    G.crashKind = null; G.crashBridge = ''; G.crashT = 0; G.shake = 0;
    rngWorld = mulberry32(seed + 1);
    resetBridges();
    for (const c of chunks) c.m.visible = false;
    loadMesh.visible = true;
    truck.rotation.set(0, 0, 0);
    truck.position.set(0, 0, 0);
    el.card.classList.remove('show');
    el.banner.classList.remove('show');
  }
  function beginRun() {
    resetRun();
    G.phase = 'run';
    el.title.style.display = 'none';
    el.hud.classList.remove('hidden');
    el.hint.style.opacity = '1';
    setTimeout(() => (el.hint.style.opacity = '0'), 6000);
  }
  function crash(kind: 'BRIDGE STRIKE' | 'PIER STRIKE', b: Bridge, point: THREE.Vector3) {
    G.phase = 'crash';
    G.crashKind = kind;
    G.crashBridge = b.name;
    G.crashT = 0;
    G.crashPt.copy(point);
    G.hold = false;
    if (G.score > G.best) { G.best = G.score; try { localStorage.setItem('clr3d.best', String(G.best)); } catch { /* ignore */ } }
    if (reduceMotion) { showFail(); return; }
    loadMesh.visible = false;
    for (const c of chunks) {
      c.m.visible = true;
      c.m.position.set(point.x + (rngFx() - 0.5) * 2.4, point.y - rngFx() * 1.5, point.z + (rngFx() - 0.5) * 3);
      c.v.set((rngFx() - 0.5) * 9, 2 + rngFx() * 7, 4 + rngFx() * 10);
      c.av.set(rngFx() * 6, rngFx() * 6, rngFx() * 6);
    }
    G.shake = 1;
    el.flash.style.transition = 'none';
    el.flash.style.opacity = '0.8';
    requestAnimationFrame(() => { el.flash.style.transition = 'opacity .5s'; el.flash.style.opacity = '0'; });
  }
  function showFail() {
    G.phase = 'fail';
    el.kind.textContent = G.crashKind || 'BRIDGE STRIKE';
    el.bname.textContent = G.crashBridge;
    el.fkm.textContent = G.score.toFixed(2) + ' km';
    el.fmult.textContent = '×' + G.topMult;
    el.fcl.textContent = String(G.cleared);
    el.fbest.textContent = G.best.toFixed(2) + ' km';
    el.card.classList.add('show');
  }
  let bannerTimer = 0;
  function banner(html: string, ms = 1400) {
    el.banner.innerHTML = html;
    el.banner.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = window.setTimeout(() => el.banner.classList.remove('show'), ms);
  }

  // ─── simulation ───
  function simulate(dt: number) {
    // speed & distance
    const base = Math.min(SPEED_CAP, BASE_SPEED + SPEED_PER_M * G.dist);
    G.speed = base * (G.throttle ? THROTTLE_SPEED : 1);
    G.dist += G.speed * dt;
    // multiplier
    const chainMult = G.shaveChain > 0 && G.dist < G.shaveUntil ? SHAVE_CHAIN[Math.min(G.shaveChain, SHAVE_CHAIN.length) - 1] : 1;
    if (G.dist >= G.shaveUntil) G.shaveChain = 0;
    G.mult = chainMult * (G.throttle ? THROTTLE_SCORE : 1);
    G.topMult = Math.max(G.topMult, G.mult);
    G.score += (G.speed * dt / 1000) * G.mult;
    // lane
    const tx = LANE_X[G.lane];
    G.laneX += (tx - G.laneX) * Math.min(1, LANE_LERP * dt);
    if (Math.abs(tx - G.laneX) < 0.004) G.laneX = tx;
    // air + hydraulics
    if (G.hold && !G.airLocked) {
      G.air -= AIR_DRAIN * dt;
      if (G.air <= 0) { G.air = 0; G.airLocked = true; }
    } else {
      G.air = Math.min(1, G.air + AIR_REFILL * dt);
      if (G.airLocked && G.air >= AIR_RELOCK) G.airLocked = false;
    }
    const ducking = G.hold && !G.airLocked;
    if (ducking) {
      G.lowered = Math.min(DUCK_MAX, G.lowered + DUCK_SPEED * dt);
      G.lowerVel = 0;
    } else if (G.lowered !== 0 || G.lowerVel !== 0) {
      const acc = -SPRING_K * G.lowered - SPRING_C * G.lowerVel;
      G.lowerVel += acc * dt;
      G.lowered += G.lowerVel * dt;
      if (Math.abs(G.lowered) < 0.002 && Math.abs(G.lowerVel) < 0.01) { G.lowered = 0; G.lowerVel = 0; }
    }
    // bridges
    fillBridges();
    const top = hEff();
    const z0 = G.dist + LOAD_Z0, z1 = G.dist + LOAD_Z1;
    for (const b of bridges) {
      if (!b.active) continue;
      if (b.w + b.depth < G.dist - 60) { b.active = false; b.group.visible = false; continue; }
      const under = z1 > b.w && z0 < b.w + b.depth;
      if (under && !b.cleared) {
        const lane = b.lanes[G.lane];
        // pick the lane by where the load actually is (a mid-change load can be under a neighbour's deck)
        const li = Math.abs(G.laneX) < 1.9 ? 1 : G.laneX < 0 ? 0 : 2;
        const L = b.lanes[li] || lane;
        if (b.kind !== 'rail') {
          for (const px of PIER_X) {
            if (Math.abs(G.laneX - px) < LOAD_HALF_W + PIER_HALF) {
              crash('PIER STRIKE', b, new THREE.Vector3(px, Math.min(top, L.clear) - 0.6, G.dist - Math.max(b.w, z0) - 0.5 + 0.0));
              return;
            }
          }
        }
        if (top > L.clear) {
          crash('BRIDGE STRIKE', b, new THREE.Vector3(G.laneX, L.clear, G.dist - Math.max(b.w, z0)));
          return;
        }
        b.minMargin = Math.min(b.minMargin, L.clear - top);
      }
      if (!b.cleared && z0 > b.w + b.depth) {
        b.cleared = true;
        G.cleared++;
        if (b.minMargin < SHAVE_CM + 1e-6) {
          G.shaveChain = Math.min(G.shaveChain + 1, SHAVE_CHAIN.length);
          G.shaveUntil = G.dist + SHAVE_LEN;
          const m = SHAVE_CHAIN[G.shaveChain - 1];
          banner(`CLOSE SHAVE<small>${Math.max(0, Math.round(b.minMargin * 100))} cm · ×${m}</small>`);
          if (!reduceMotion) G.shake = Math.max(G.shake, 0.5);
        }
      }
    }
  }

  // ─── crash cinematic ───
  function simulateCrash(dtReal: number) {
    G.crashT += dtReal;
    const dt = dtReal * 0.15;
    for (const c of chunks) {
      c.v.y -= 9.8 * dt;
      c.m.position.addScaledVector(c.v, dt);
      if (c.m.position.y < c.m.scale.y / 2) { c.m.position.y = c.m.scale.y / 2; c.v.y *= -0.3; c.v.x *= 0.8; c.v.z *= 0.8; }
      c.m.rotation.x += c.av.x * dt;
      c.m.rotation.y += c.av.y * dt;
    }
    truck.rotation.x = Math.min(0.05, G.crashT * 0.15);
    if (G.crashT > 1.3) showFail();
  }

  // ─── camera ───
  let portrait = false;
  let camMode: 'chase' | 'dolly' = 'chase';
  const camTarget = new THREE.Vector3();
  const camPos = new THREE.Vector3(0, CAM_UP, CAM_BACK);
  function updateCamera(dt: number) {
    if (G.phase === 'title') {
      const a = G.time * 0.25;
      camPos.set(Math.sin(a) * 17, 5.5 + Math.sin(a * 0.7) * 1.2, -7 + Math.cos(a) * 17);
      camTarget.set(0, 2.4, -7);
    } else if (G.phase === 'crash' && !reduceMotion) {
      const p = G.crashPt;
      const k = Math.min(1, G.crashT / 1.1);
      camPos.lerp(new THREE.Vector3(p.x + 3.5, p.y + 1.2, p.z + 8), k * 0.06);
      camTarget.lerp(p, 0.15);
    } else if (camMode === 'dolly') {
      camPos.lerp(new THREE.Vector3(G.laneX - 7.5, 1.8, -3), Math.min(1, 4 * dt));
      camTarget.set(G.laneX + 6, 3.2, -12);
    } else {
      camPos.lerp(new THREE.Vector3(G.laneX * 0.55, CAM_UP, CAM_BACK), Math.min(1, 4 * dt));
      camTarget.set(G.laneX * 0.3, 2.3, -26);
    }
    camera.position.copy(camPos);
    if (G.shake > 0 && !reduceMotion) {
      const s = G.shake * 0.35;
      camera.position.x += (Math.random() - 0.5) * s;
      camera.position.y += (Math.random() - 0.5) * s;
      G.shake = Math.max(0, G.shake - dt * 2.2);
    }
    camera.lookAt(camTarget);
  }

  // ─── rendering / frame ───
  function placeWorld() {
    const d = G.dist;
    roadT.offset.y = (d / 12) % 1;
    for (const s of scenery) {
      while (s.w < d - 40) s.w += s.span;
      s.m.position.set(s.x, s.m.position.y, d - s.w);
    }
    for (const f of fieldPool) {
      while (f.w < d - 240) f.w += f.span;
      f.m.position.set(f.x, 0, d - f.w);
    }
    for (const b of bridges) {
      if (!b.active) continue;
      b.group.position.z = d - b.w;
      const passed = b.w < d - 1;
      if (passed !== b.faceHidden) {
        b.faceHidden = passed;
        for (const L of b.lanes) L.plate.visible = L.lamp.visible = L.board.visible = !passed;
      }
    }
    // truck pose
    const tx = LANE_X[G.lane];
    truck.position.x = G.laneX;
    if (G.phase !== 'crash') {
      truck.rotation.z = (tx - G.laneX) * 0.045;
      truck.rotation.y = (tx - G.laneX) * -0.05;
    }
    loadG.position.y = -G.lowered;
    for (const w of wheels) w.rotation.x -= G.speed * 0.016 * (G.phase === 'run' ? 1 : 0);
    // verdict lamps + marker on nearest uncleared bridge within LOOK_AHEAD
    let nb: Bridge | null = null;
    for (const b of bridges) if (b.active && !b.cleared && b.w + b.depth > d + LOAD_Z0 && (!nb || b.w < nb.w)) nb = b;
    if (nb && nb.w < d + LOOK_AHEAD) {
      updateVerdicts(nb, hEff(), hMin());
      marker.visible = G.phase === 'run';
      marker.position.set(G.laneX, hEff(), d - nb.w + 0.5);
      const fits = nb.lanes[G.lane].clear >= hEff();
      (marker.material as THREE.MeshBasicMaterial).color.set(fits ? '#2fd06a' : '#e2382f');
      for (let i = 0; i < 3; i++) {
        const L = nb.lanes[i];
        const c = el.chips[i];
        c.className = 'c3-chip ' + L.verdict;
        c.innerHTML = L.clear.toFixed(2) + '<small>' + (L.verdict === 'fit' ? 'FITS' : L.verdict === 'duck' ? 'DUCK ▼' : 'NO') + '</small>';
      }
      el.chips[G.lane].style.outline = '3px solid #fff';
      for (let i = 0; i < 3; i++) if (i !== G.lane) el.chips[i].style.outline = 'none';
    } else {
      marker.visible = false;
      for (const c of el.chips) { c.className = 'c3-chip'; c.textContent = '–'; c.style.outline = 'none'; }
    }
    sun.target.position.set(0, 0, -20);
    sun.position.set(-30, 40, -40);
  }
  function updateHud() {
    el.km.textContent = G.score.toFixed(2);
    el.mult.textContent = G.mult > 1 ? `×${G.mult}${G.throttle ? ' HAMMER DOWN' : ''}` : '';
    el.h.textContent = hEff().toFixed(2) + ' m';
    el.reg.classList.toggle('red', G.loadH > 4.15);
    el.airbar.style.transform = `scaleX(${G.air.toFixed(3)})`;
    el.air.className = 'c3-air' + (G.airLocked ? ' lock' : G.air < 0.3 ? ' low' : '');
  }

  let last = performance.now();
  let raf = 0;
  let alive = true;
  function frame(now: number) {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    const dtReal = Math.min(0.05, (now - last) / 1000);
    last = now;
    G.time += dtReal;
    if (G.phase === 'run') simulate(dtReal);
    else if (G.phase === 'crash') simulateCrash(dtReal);
    placeWorld();
    updateCamera(dtReal);
    if (G.phase !== 'title') updateHud();
    renderer.render(scene, camera);
  }

  function resize() {
    const w = root.clientWidth || innerWidth, h = root.clientHeight || innerHeight;
    portrait = h > w;
    camera.aspect = w / h;
    camera.fov = portrait ? 62 : 52;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(root);

  // ─── input ───
  function setLane(dir: -1 | 1) {
    if (G.phase !== 'run') return;
    G.lane = clamp(G.lane + dir, 0, 2);
  }
  function setHold(v: boolean) {
    if (G.phase !== 'run') { G.hold = false; return; }
    G.hold = v;
  }
  function action(a: string) {
    switch (a) {
      case 'left': setLane(-1); break;
      case 'right': setLane(1); break;
      case 'hold': setHold(true); break;
      case 'release': setHold(false); break;
      case 'throttle': if (G.phase === 'run') G.throttle = !G.throttle; break;
      case 'camera': camMode = camMode === 'chase' ? 'dolly' : 'chase'; break;
      case 'start': if (G.phase === 'title' || G.phase === 'fail') beginRun(); break;
      case 'restart': if (G.phase === 'fail' || G.phase === 'run') beginRun(); break;
    }
  }
  const keys = new Set<string>();
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    keys.add(e.code);
    switch (e.code) {
      case 'ArrowLeft': case 'KeyA': action('left'); e.preventDefault(); break;
      case 'ArrowRight': case 'KeyD': action('right'); e.preventDefault(); break;
      case 'Space': case 'ArrowDown': if (G.phase === 'run') action('hold'); else action('start'); e.preventDefault(); break;
      case 'KeyS': action('throttle'); break;
      case 'KeyC': action('camera'); break;
      case 'KeyR': action('restart'); break;
      case 'Enter': action('start'); break;
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    keys.delete(e.code);
    if (e.code === 'Space' || e.code === 'ArrowDown') action('release');
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // touch: hold anywhere = duck; swipe ◀ ▶ = lane; swipe ▼ = throttle
  let pid: number | null = null, px0 = 0, py0 = 0, swiped = false;
  const cv = renderer.domElement;
  const onDown = (e: PointerEvent) => {
    if (pid !== null) return;
    pid = e.pointerId; px0 = e.clientX; py0 = e.clientY; swiped = false;
    cv.setPointerCapture?.(e.pointerId);
    if (G.phase === 'run') action('hold');
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== pid || swiped) return;
    const dx = e.clientX - px0, dy = e.clientY - py0;
    const th = 28;
    if (Math.abs(dx) > th && Math.abs(dx) > Math.abs(dy)) { swiped = true; action('release'); action(dx < 0 ? 'left' : 'right'); }
    else if (dy > th * 1.6 && Math.abs(dy) > Math.abs(dx)) { swiped = true; action('release'); action('throttle'); }
  };
  const onUp = (e: PointerEvent) => {
    if (e.pointerId !== pid) return;
    pid = null;
    action('release');
  };
  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('pointercancel', onUp);
  const btn = (b: HTMLElement, a: string) => {
    b.addEventListener('pointerdown', (e) => { e.stopPropagation(); action(a); });
  };
  btn(el.left, 'left');
  btn(el.right, 'right');
  el.title.addEventListener('pointerup', () => action('start'));
  el.restart.addEventListener('pointerup', (e) => { e.stopPropagation(); action('restart'); });
  el.card.addEventListener('pointerdown', (e) => e.stopPropagation());

  // ─── debug / test hooks ───
  const snapshot = (): GameSnapshot => ({
    phase: G.phase, dist: G.dist, speed: G.speed, throttle: G.throttle, mult: G.mult, score: G.score,
    lane: G.lane, laneX: G.laneX, hold: G.hold, lowered: G.lowered, air: G.air, airLocked: G.airLocked,
    loadH: G.loadH, hEff: hEff(), cleared: G.cleared, shaveChain: G.shaveChain, crashKind: G.crashKind,
    bridges: bridges.filter((b) => b.active && !b.cleared).sort((a, b) => a.w - b.w)
      .map((b) => ({ w: b.w, depth: b.depth, kind: b.kind, name: b.name, clears: b.lanes.map((L) => L.clear), verdicts: b.lanes.map((L) => L.verdict) })),
  });
  window.__game = snapshot;
  window.__gameWarp = (m: number) => { G.dist += m; resetBridges(); };
  window.__gameInput = action;

  // ─── go ───
  el.hud.classList.add('hidden');
  resetRun();
  placeWorld();
  raf = requestAnimationFrame(frame);

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    ro.disconnect();
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    delete window.__game; delete window.__gameWarp; delete window.__gameInput;
    renderer.dispose();
    root.innerHTML = '';
    root.classList.remove('c3-root');
  };
}
