/*
 * CLEARANCE 3D — self-contained game module (rebuild #2: high-fidelity pass).
 * startGame(root) builds renderer + HUD inside `root` and returns a cleanup function.
 * No model/texture assets: every material is canvas-generated, every mesh procedural.
 * See PLAN.md for state shape, world scroll and collision spans.
 */
import * as THREE from 'three';

// ───────────────────────────── tuning ─────────────────────────────
const LANE_X = [-3.8, 0, 3.8];
const ROAD_HALF = 5.7;
const PIER_X = [-1.9, 1.9];
const PIER_R = 0.36; // round pier radius (half-width 1.45 + 0.36 leaves 9 cm to the pier at lane centre)
const LOAD_HALF_W = 1.45; // truss half width
const LOAD_Z0 = 1.0; // collision span, metres ahead of the truck origin (trailer rear)
const LOAD_Z1 = 13.5;
const BED_H = 1.35;
const LANE_LERP = 5;
const BRAKE_FACTOR = 0.45;
const HAMMER_SPEED = 1.35;
const HAMMER_SCORE = 2;
const BASE_SPEED = 16;
const SPEED_PER_M = 0.012;
const SPEED_CAP = 36;
const FIRST_BRIDGE = 55;
const SHAVE_M = 0.1;
const SHAVE_CHAIN = [3, 5, 7, 9, 10];
const SHAVE_LEN = 200;
const CAM_UP = 6.4;
const CAM_BACK = 17.5;
const LOOK_AHEAD = 230;
const NIGHT_KM = 3.2;
// sway oscillator
const SWAY_K = 4;
const SWAY_C = 0.55;
const SWAY_C_BRAKE = 4.5;
const SWAY_A = 0.036;
const SWAY_HAMMER = 2.2;
const SWAY_ARM = 1.6;

const BRIDGE_NAMES = [
  'CIRCLE DRIVE OVERPASS', 'IDYLWYLD FREEWAY OVERPASS', 'COLLEGE DRIVE OVERPASS', 'ATTRIDGE DRIVE FLYOVER',
  'PRESTON AVENUE OVERPASS', 'CLARENCE AVENUE BRIDGE', '8TH STREET OVERPASS', '22ND STREET FLYOVER',
  'HIGHWAY 16 OVERPASS', 'MARQUIS DRIVE INTERCHANGE', 'AIRPORT DRIVE OVERPASS', 'TAYLOR STREET BRIDGE',
];
const RAIL_NAME = 'SUTHERLAND SUB RAIL BRIDGE';
const WAYPOINTS = [
  ['HWY 11 / HWY 16 JUNCTION', 700], ['CIRCLE DRIVE SOUTH', 1100], ['COLLEGE DRIVE', 1000],
  ['THE OVERPASS DISTRICT', 1200], ['IDYLWYLD FREEWAY', 1000], ['RIVER LANDING', 1300], ['AIRPORT DRIVE', 1100],
  ['MARQUIS INDUSTRIAL', 1200], ['THE GRAIN TERMINAL', 1400],
] as const;
const DISPATCH = [
  { id: 'nobrake', text: 'Clear 4 bridges without braking', goal: 4 },
  { id: 'shave3', text: '3 close shaves in a row', goal: 3 },
  { id: 'hammer2', text: 'Hammer down under 2 bridges', goal: 2 },
  { id: 'clear8', text: 'Clear 8 bridges', goal: 8 },
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
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);
const step05 = (v: number) => Math.round(v * 20) / 20;
const fmtM = (v: number) => v.toFixed(2) + ' m';
const fmtClock = (s: number) => {
  const neg = s < 0; s = Math.abs(s);
  return (neg ? '−' : '') + Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
};
const PLATE_FONT = "'Oswald', var(--font-plate), 'Arial Narrow', Impact, sans-serif";
const HUD_FONT = "'Cormorant Garamond', var(--font-hud), 'Times New Roman', serif";

// ───────────────────────────── canvas textures ─────────────────────────────
function cv2d(w: number, h: number) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  return [cv, cv.getContext('2d')!] as const;
}
function tex(cv: HTMLCanvasElement, srgb = true, repeat = false) {
  const t = new THREE.CanvasTexture(cv);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = 8;
  return t;
}
// value-noise helper on a canvas (cheap, deterministic)
function noiseFill(c: CanvasRenderingContext2D, w: number, h: number, rng: () => number, base: string, grains: [string, number][], count: number, size = 2) {
  c.fillStyle = base;
  c.fillRect(0, 0, w, h);
  for (const [col, alpha] of grains) {
    c.fillStyle = col;
    c.globalAlpha = alpha;
    for (let i = 0; i < count; i++) c.fillRect(rng() * w, rng() * h, size * (0.5 + rng()), size * (0.5 + rng()));
  }
  c.globalAlpha = 1;
}
function asphaltMaps(rng: () => number) {
  const W = 512, H = 1024;
  const [a, ac] = cv2d(W, H);
  noiseFill(ac, W, H, rng, '#3c3d41', [['#2e2f33', 0.5], ['#4a4b50', 0.45], ['#57585d', 0.2]], 9000, 3);
  // patches / tar lines
  ac.globalAlpha = 0.25; ac.strokeStyle = '#26272a'; ac.lineWidth = 3;
  for (let i = 0; i < 14; i++) { ac.beginPath(); ac.moveTo(rng() * W, rng() * H); ac.lineTo(rng() * W, rng() * H); ac.stroke(); }
  ac.globalAlpha = 1;
  const px = (x: number) => ((x + ROAD_HALF) / (ROAD_HALF * 2)) * W;
  // edge lines: white right, yellow left (divided highway), dashed white between lanes
  ac.fillStyle = '#e6e2d6'; ac.fillRect(px(ROAD_HALF - 0.35) - 5, 0, 10, H);
  ac.fillStyle = '#e2c045'; ac.fillRect(px(-ROAD_HALF + 0.35) - 5, 0, 10, H);
  ac.fillStyle = '#e6e2d6';
  for (const x of PIER_X) for (let y = 0; y < H; y += 256) ac.fillRect(px(x) - 4, y, 8, 100);
  // worn wheel tracks
  ac.globalAlpha = 0.18; ac.fillStyle = '#1f2023';
  for (const lx of LANE_X) for (const o of [-0.9, 0.9]) ac.fillRect(px(lx + o) - 12, 0, 24, H);
  ac.globalAlpha = 1;
  const [r, rc] = cv2d(W, H);
  noiseFill(rc, W, H, rng, '#8a8a8a', [['#6a6a6a', 0.5], ['#a6a6a6', 0.4]], 6000, 6);
  // puddles / wet sheen patches (low roughness)
  rc.globalAlpha = 0.9; rc.fillStyle = '#2a2a2a';
  for (let i = 0; i < 9; i++) { rc.beginPath(); rc.ellipse(rng() * W, rng() * H, 30 + rng() * 60, 12 + rng() * 30, 0, 0, Math.PI * 2); rc.fill(); }
  rc.globalAlpha = 1;
  return { map: tex(a, true, true), rough: tex(r, false, true) };
}
function concreteMaps(rng: () => number, stain = true) {
  const W = 512, H = 256;
  const [a, ac] = cv2d(W, H);
  noiseFill(ac, W, H, rng, '#a8a49b', [['#948f86', 0.5], ['#b9b5ab', 0.45], ['#7d7870', 0.2]], 5000, 3);
  if (stain) {
    ac.globalAlpha = 0.28; ac.fillStyle = '#5b574f';
    for (let i = 0; i < 18; i++) { const x = rng() * W; ac.fillRect(x, 0, 2 + rng() * 6, H * (0.3 + rng() * 0.7)); }
    ac.globalAlpha = 0.35; ac.fillStyle = '#6b665d'; ac.fillRect(0, H - 40, W, 40);
    ac.globalAlpha = 1;
  }
  const [r, rc] = cv2d(W, H);
  noiseFill(rc, W, H, rng, '#c8c8c8', [['#a8a8a8', 0.5], ['#e0e0e0', 0.4]], 4000, 4);
  return { map: tex(a, true, true), rough: tex(r, false, true) };
}
function grassMaps(rng: () => number) {
  const W = 512, H = 512;
  const [a, ac] = cv2d(W, H);
  noiseFill(ac, W, H, rng, '#6f7b3a', [['#5c6b2e', 0.6], ['#8a9440', 0.5], ['#a99f4e', 0.3], ['#4d5a27', 0.3]], 14000, 4);
  return { map: tex(a, true, true) };
}
function fieldMaps(rng: () => number, base: string, g1: string, g2: string) {
  const W = 256, H = 256;
  const [a, ac] = cv2d(W, H);
  noiseFill(ac, W, H, rng, base, [[g1, 0.5], [g2, 0.4]], 5000, 5);
  // seed rows
  ac.globalAlpha = 0.18; ac.fillStyle = '#000';
  for (let y = 0; y < H; y += 8) ac.fillRect(0, y, W, 1);
  ac.globalAlpha = 1;
  return tex(a, true, true);
}
function woodDeck(rng: () => number) {
  const [a, ac] = cv2d(256, 1024);
  noiseFill(ac, 256, 1024, rng, '#6b5233', [['#5a4429', 0.5], ['#7c6140', 0.5]], 3000, 3);
  ac.fillStyle = '#3d2d1b';
  for (let y = 0; y < 1024; y += 64) ac.fillRect(0, y, 256, 3);
  return tex(a, true, true);
}
function foliageCard(rng: () => number, cols: string[]) {
  const [a, ac] = cv2d(256, 256);
  ac.clearRect(0, 0, 256, 256);
  for (let i = 0; i < 160; i++) {
    const x = 128 + (rng() - 0.5) * 200, y = 118 + (rng() - 0.5) * 200;
    const d = Math.hypot(x - 128, y - 118);
    if (d > 118) continue;
    ac.fillStyle = cols[Math.floor(rng() * cols.length)];
    ac.globalAlpha = 0.85;
    ac.beginPath(); ac.ellipse(x, y, 10 + rng() * 14, 8 + rng() * 10, rng() * 3, 0, Math.PI * 2); ac.fill();
  }
  ac.globalAlpha = 1;
  const t = tex(a);
  return t;
}
function cloudSprite(rng: () => number) {
  const [a, ac] = cv2d(256, 128);
  ac.clearRect(0, 0, 256, 128);
  for (let i = 0; i < 26; i++) {
    const x = 40 + rng() * 176, y = 64 + (rng() - 0.4) * 40, r = 18 + rng() * 30;
    const g = ac.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ac.fillStyle = g;
    ac.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return tex(a);
}
function softDot() {
  const [a, ac] = cv2d(64, 64);
  const g = ac.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ac.fillStyle = g; ac.fillRect(0, 0, 64, 64);
  return tex(a);
}
function plateTex(text: string, bg: string, fg: string, w = 256, h = 128, size = 88, border = '#111', font = PLATE_FONT) {
  const [a, c] = cv2d(w, h);
  c.fillStyle = bg; c.fillRect(0, 0, w, h);
  c.lineWidth = 10; c.strokeStyle = border; c.strokeRect(5, 5, w - 10, h - 10);
  c.fillStyle = fg; c.font = `700 ${size}px ${font}`; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(text, w / 2, h / 2 + 4);
  return tex(a);
}
function stripeTex() {
  const [a, c] = cv2d(256, 32);
  c.fillStyle = '#f2b32a'; c.fillRect(0, 0, 256, 32);
  c.fillStyle = '#151515';
  for (let x = -32; x < 256; x += 64) { c.beginPath(); c.moveTo(x, 32); c.lineTo(x + 32, 0); c.lineTo(x + 64, 0); c.lineTo(x + 32, 32); c.fill(); }
  return tex(a, true, true);
}
function windowsTex(rng: () => number, cols: number, rows: number) {
  const [a, c] = cv2d(cols * 8, rows * 8);
  c.fillStyle = '#000'; c.fillRect(0, 0, a.width, a.height);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (rng() < 0.55) { c.fillStyle = rng() < 0.2 ? '#ffd58a' : '#ffe9bf'; c.fillRect(x * 8 + 2, y * 8 + 2, 4, 5); }
  }
  return tex(a, true, true);
}

// ───────────────────────────── sky shader ─────────────────────────────
const SKY_VERT = `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const SKY_FRAG = `
precision highp float;
varying vec3 vDir;
uniform vec3 uTop, uMid, uHor, uSunDir, uSunCol;
uniform float uNight, uSunGlow;
float hash(vec3 p){ p = fract(p*0.3183099+vec3(0.1,0.2,0.3)); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
void main(){
  float y = clamp(vDir.y, -0.05, 1.0);
  vec3 col = mix(uHor, uMid, smoothstep(0.0, 0.28, y));
  col = mix(col, uTop, smoothstep(0.25, 0.9, y));
  float sd = max(dot(normalize(vDir), uSunDir), 0.0);
  col += uSunCol * (pow(sd, 900.0) * 6.0 + pow(sd, 18.0) * 0.45 * uSunGlow + pow(sd, 3.0) * 0.12 * uSunGlow);
  // stars
  vec3 d = normalize(vDir) * 260.0;
  vec3 cell = floor(d);
  float h = hash(cell);
  float star = step(0.985, h) * smoothstep(0.75, 0.0, length(fract(d) - 0.5));
  float tw = 0.75 + 0.25 * sin(h * 90.0);
  col += vec3(0.9, 0.95, 1.0) * star * uNight * tw * smoothstep(0.02, 0.2, vDir.y);
  gl_FragColor = vec4(col, 1.0);
}`;

// ───────────────────────────── types ─────────────────────────────
type Verdict = 'fit' | 'steady' | 'no';
interface Lane { clear: number; deck: THREE.Group; plate: THREE.Mesh; lamp: THREE.Mesh; board: THREE.Mesh; verdict: Verdict }
interface Bridge {
  id: number; w: number; depth: number; kind: 'girder' | 'steel' | 'rail'; name: string; lanes: Lane[];
  group: THREE.Group; piers: THREE.Mesh[]; abut: THREE.Mesh[]; cleared: boolean; minMargin: number; active: boolean;
  faceHidden: boolean; brakedUnder: boolean; hammeredUnder: boolean;
}
interface Chunk { m: THREE.Mesh; v: THREE.Vector3; av: THREE.Vector3 }
interface Inst { w: number; x: number; s: number; rot: number; span: number }
type Phase = 'title' | 'run' | 'crash' | 'fail';

export interface GameSnapshot {
  phase: Phase; dist: number; speed: number; hammer: boolean; brake: boolean; mult: number; score: number;
  lane: number; laneX: number; loadH: number; sway: number; lift: number; hEff: number; cleared: number; shaveChain: number;
  crashKind: string | null; tod: number; waypoint: { name: string; remaining: number; clock: number } | null;
  dispatch: { text: string; progress: number; goal: number } | null;
  bridges: { w: number; depth: number; kind: string; name: string; clears: number[]; verdicts: Verdict[] }[];
}
declare global {
  interface Window { __game?: () => GameSnapshot; __gameWarp?: (metres: number) => void; __gameInput?: (action: string) => void; __gameStep?: (seconds: number) => void }
}

// ───────────────────────────── HUD ─────────────────────────────
const CSS = `
.c3-root{position:relative;width:100%;height:100%;overflow:hidden;background:#0b1020;font-family:${HUD_FONT};color:#efe6d3;user-select:none;-webkit-user-select:none;touch-action:none;-webkit-tap-highlight-color:transparent}
.c3-root canvas{display:block;width:100%;height:100%}
.c3-vig{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at 50% 55%,rgba(0,0,0,0) 55%,rgba(0,0,0,.42) 100%)}
.c3-hud{position:absolute;inset:0;pointer-events:none;text-shadow:0 1px 2px rgba(0,0,0,.7),0 0 12px rgba(0,0,0,.35)}
.c3-hud *{box-sizing:border-box}
.c3-hud.hidden,.c3-title.hidden{display:none}
.c3-lbl{font-size:11px;letter-spacing:.28em;text-transform:uppercase;opacity:.78;font-weight:600}
.c3-rule{height:1px;background:rgba(239,230,211,.45);margin:4px 0}
.c3-wp{position:absolute;top:max(14px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);text-align:center;white-space:nowrap;max-width:68vw;overflow:hidden;text-overflow:ellipsis}
.c3-wp .n{font-size:12px;letter-spacing:.2em;text-transform:uppercase;font-weight:600;overflow:hidden;text-overflow:ellipsis}
.c3-wp .t{font-size:30px;letter-spacing:.08em;line-height:1.05;font-variant-numeric:tabular-nums;margin-top:2px}
.c3-wp .t.late{color:#f0a05a}
.c3-view{position:absolute;top:max(14px,env(safe-area-inset-top));right:14px;font-size:11px;letter-spacing:.3em;text-transform:uppercase;opacity:.8;pointer-events:auto;cursor:pointer;padding:4px 0}
.c3-snd{position:absolute;top:max(14px,env(safe-area-inset-top));left:14px;font-size:11px;letter-spacing:.3em;text-transform:uppercase;opacity:.8;pointer-events:auto;cursor:pointer;padding:4px 0}
.c3-next{position:absolute;top:calc(max(14px,env(safe-area-inset-top)) + 78px);left:50%;transform:translateX(-50%);display:flex;gap:18px}
.c3-chip{width:64px;text-align:center;font-variant-numeric:tabular-nums}
.c3-chip .h{font-size:20px;letter-spacing:.04em;line-height:1.1}
.c3-chip .v{font-size:9px;letter-spacing:.24em;text-transform:uppercase;font-weight:600;margin-top:1px}
.c3-chip .bar{height:3px;margin-top:4px;background:rgba(239,230,211,.3);border-radius:2px}
.c3-chip.fit .bar{background:#5fd68a}.c3-chip.steady .bar{background:#f2b32a}.c3-chip.no .bar{background:#e0463a}
.c3-chip.fit .v{color:#8ff0b0}.c3-chip.steady .v{color:#ffd27a}.c3-chip.no .v{color:#ff8a80}
.c3-chip.cur .h{text-decoration:underline;text-underline-offset:4px;text-decoration-thickness:1px}
.c3-chip.off{opacity:.35}
.c3-bl{position:absolute;left:16px;bottom:max(18px,env(safe-area-inset-bottom));width:150px}
.c3-bl .sp{font-size:34px;line-height:1;font-variant-numeric:tabular-nums}
.c3-bl .sp small{font-size:13px;letter-spacing:.16em;text-transform:uppercase;margin-left:6px}
.c3-bl .mode{font-size:12px;letter-spacing:.26em;text-transform:uppercase;font-weight:600;margin-top:4px;min-height:14px}
.c3-bl .mode.hammer{color:#f0a05a}.c3-bl .mode.brake{color:#8fd0ff}
.c3-br{position:absolute;right:16px;bottom:max(18px,env(safe-area-inset-bottom));width:190px;text-align:right}
.c3-br .sc{font-size:34px;line-height:1;font-variant-numeric:tabular-nums}
.c3-br .sc small{font-size:13px;letter-spacing:.16em;text-transform:uppercase;margin-left:6px}
.c3-br .row{display:flex;justify-content:space-between;font-size:12px;letter-spacing:.14em;text-transform:uppercase;margin-top:3px;font-variant-numeric:tabular-nums}
.c3-br .mult{color:#ffd27a;font-weight:600}
.c3-disp{position:absolute;left:16px;bottom:calc(max(18px,env(safe-area-inset-bottom)) + 84px);width:min(44vw,200px)}
.c3-disp .d{font-size:13px;line-height:1.25;margin-top:2px}
.c3-disp .p{font-size:11px;letter-spacing:.2em;opacity:.75;margin-top:2px}
.c3-hint{position:absolute;left:50%;top:calc(max(14px,env(safe-area-inset-top)) + 138px);transform:translateX(-50%);font-size:11px;letter-spacing:.22em;text-transform:uppercase;white-space:nowrap;opacity:.85;transition:opacity 1s;max-width:94vw;overflow:hidden;text-overflow:ellipsis}
.c3-banner{position:absolute;left:50%;top:36%;transform:translate(-50%,-50%) scale(.9);text-align:center;opacity:0;transition:opacity .18s,transform .18s;white-space:nowrap}
.c3-banner.show{opacity:1;transform:translate(-50%,-50%) scale(1)}
.c3-banner .a{font-size:40px;letter-spacing:.2em;text-transform:uppercase;line-height:1}
.c3-banner .b{font-size:14px;letter-spacing:.3em;text-transform:uppercase;color:#ffd27a;margin-top:6px}
.c3-banner.warn .a{color:#f0a05a}
.c3-flash{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none}
.c3-btn{position:absolute;bottom:calc(max(18px,env(safe-area-inset-bottom)) + 150px);width:54px;height:54px;border:1px solid rgba(239,230,211,.55);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:22px;pointer-events:auto;cursor:pointer;background:rgba(6,10,20,.28);backdrop-filter:blur(3px)}
.c3-btn:active{background:rgba(239,230,211,.85);color:#111}
#c3-left{left:14px}#c3-right{right:14px}
.c3-title{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer;text-align:center;padding:0 20px;background:linear-gradient(rgba(4,8,18,.15),rgba(4,8,18,.55))}
.c3-title .eb{font-size:11px;letter-spacing:.42em;text-transform:uppercase;opacity:.8}
.c3-title .lg{font-size:min(12.5vw,84px);letter-spacing:.16em;text-transform:uppercase;line-height:1;margin:10px 0 6px;padding-left:.16em;font-weight:400;white-space:nowrap}
.c3-title .sub{font-size:13px;letter-spacing:.34em;text-transform:uppercase;opacity:.85}
.c3-title .cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:30px 0 26px;width:min(92vw,400px)}
.c3-title .card{border:1px solid rgba(239,230,211,.45);padding:12px 8px;text-align:center;background:rgba(4,8,18,.35)}
.c3-title .card b{display:block;font-size:12px;letter-spacing:.24em;text-transform:uppercase;font-weight:600}
.c3-title .card i{display:block;font-style:normal;font-size:11px;opacity:.75;margin-top:6px;line-height:1.35}
.c3-title .tap{font-size:15px;letter-spacing:.42em;text-transform:uppercase;animation:c3pulse 1.6s infinite}
.c3-title .keys{font-size:11px;letter-spacing:.24em;text-transform:uppercase;opacity:.7;margin-top:14px;line-height:1.7}
.c3-title .gc{position:absolute;bottom:max(14px,env(safe-area-inset-bottom));font-size:11px;letter-spacing:.26em;text-transform:uppercase;opacity:.7}
@keyframes c3pulse{0%,100%{opacity:1}50%{opacity:.3}}
.c3-card{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(4,8,18,.6);pointer-events:auto}
.c3-card.show{display:flex}
.c3-panel{width:min(90vw,420px);border:1px solid rgba(239,230,211,.5);background:rgba(8,12,24,.82);padding:22px 24px;text-align:center;backdrop-filter:blur(6px)}
.c3-panel h1{margin:0;font-size:38px;letter-spacing:.2em;text-transform:uppercase;font-weight:400;color:#ff8a80;line-height:1}
.c3-panel h2{margin:8px 0 16px;font-size:12px;letter-spacing:.3em;text-transform:uppercase;font-weight:600;opacity:.8}
.c3-panel .rows{display:grid;grid-template-columns:1fr 1fr;gap:10px 16px;text-align:left;margin:0 0 18px}
.c3-panel .rows span{display:block;font-size:10px;letter-spacing:.26em;text-transform:uppercase;opacity:.7}
.c3-panel .rows b{display:block;font-size:24px;font-weight:400;font-variant-numeric:tabular-nums}
.c3-panel .go{display:inline-block;border:1px solid rgba(239,230,211,.7);padding:10px 30px;font-size:14px;letter-spacing:.34em;text-transform:uppercase;cursor:pointer;pointer-events:auto}
.c3-panel .go:active{background:#efe6d3;color:#111}
`;
const HUD_HTML = `
<div class="c3-vig"></div>
<div class="c3-hud hidden" id="c3-hud">
  <div class="c3-wp"><div class="n" id="c3-wpn">—</div><div class="t" id="c3-wpt">—</div></div>
  <div class="c3-view" id="c3-view">Chase</div>
  <div class="c3-next" id="c3-next">
    <div class="c3-chip" id="c3-chip0"><div class="h">–</div><div class="v"></div><div class="bar"></div></div>
    <div class="c3-chip" id="c3-chip1"><div class="h">–</div><div class="v"></div><div class="bar"></div></div>
    <div class="c3-chip" id="c3-chip2"><div class="h">–</div><div class="v"></div><div class="bar"></div></div>
  </div>
  <div class="c3-disp"><div class="c3-lbl">Dispatch</div><div class="c3-rule"></div><div class="d" id="c3-dt">—</div><div class="p" id="c3-dp"></div></div>
  <div class="c3-bl"><div class="c3-lbl">Speed</div><div class="c3-rule"></div><div class="sp"><span id="c3-sp">0</span><small>km/h</small></div><div class="mode" id="c3-mode">Full ahead</div></div>
  <div class="c3-br"><div class="c3-lbl">Distance made good</div><div class="c3-rule"></div><div class="sc"><span id="c3-km">0.00</span><small>km</small></div>
    <div class="row"><span>Load</span><span id="c3-h">4.30 m</span></div><div class="row"><span>Cleared</span><span id="c3-cl">0</span></div><div class="row mult" id="c3-mult"></div></div>
  <div class="c3-btn" id="c3-left">◀</div><div class="c3-btn" id="c3-right">▶</div>
  <div class="c3-hint" id="c3-hint">Swipe to change lane · Hold to brake · Swipe down to hammer</div>
  <div class="c3-banner" id="c3-banner"><div class="a"></div><div class="b"></div></div>
</div>
<div class="c3-flash" id="c3-flash"></div>
<div class="c3-title" id="c3-title">
  <div class="eb">Saskatchewan Highways · Oversize permit not obtained</div>
  <div class="lg">Clearance</div>
  <div class="sub">Saskatoon · Circle Drive approach · 4.30 m of steel</div>
  <div class="cards">
    <div class="card"><b>The Haul</b><i>Endless run into the overpass district</i></div>
    <div class="card"><b>Read the plates</b><i>Yellow signs post each lane's clearance</i></div>
    <div class="card"><b>Brake to steady</b><i>A swaying load rides taller than it is</i></div>
  </div>
  <div class="tap">Tap to haul</div>
  <div class="keys">Swipe ◀ ▶ lane · hold to brake · swipe ▼ hammer down<br>Keys ← → · Space · S · C view</div>
  <div class="gc" id="c3-best"></div>
</div>
<div class="c3-card" id="c3-card"><div class="c3-panel">
  <h1 id="c3-kind">Bridge strike</h1><h2 id="c3-bname">—</h2>
  <div class="rows">
    <div><span>Hauled</span><b id="c3-fkm">0.00 km</b></div><div><span>Top multiplier</span><b id="c3-fmult">×1</b></div>
    <div><span>Bridges cleared</span><b id="c3-fcl">0</b></div><div><span>Best</span><b id="c3-fbest">0.00 km</b></div>
  </div>
  <div class="go" id="c3-restart">Haul again</div>
</div></div>`;

// ───────────────────────────── the game ─────────────────────────────
export function startGame(root: HTMLElement, opts: { seed?: number } = {}): () => void {
  root.classList.add('c3-root');
  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);
  const reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const seed = opts.seed ?? ((Date.now() ^ (Math.random() * 1e9)) >>> 0);
  const rngFx = mulberry32(0xc0ffee); // cosmetic stream (deterministic textures, scatter)
  let rngWorld = mulberry32(seed); // world stream (bridges, hazards)

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  root.appendChild(renderer.domElement);
  const wrap = document.createElement('div');
  wrap.innerHTML = HUD_HTML;
  root.appendChild(wrap);
  const $ = (id: string) => wrap.querySelector<HTMLElement>('#' + id)!;
  const el = {
    hud: $('c3-hud'), wpn: $('c3-wpn'), wpt: $('c3-wpt'), view: $('c3-view'), chips: [$('c3-chip0'), $('c3-chip1'), $('c3-chip2')],
    dt: $('c3-dt'), dp: $('c3-dp'), sp: $('c3-sp'), mode: $('c3-mode'), km: $('c3-km'), h: $('c3-h'), cl: $('c3-cl'), mult: $('c3-mult'),
    left: $('c3-left'), right: $('c3-right'), hint: $('c3-hint'), banner: $('c3-banner'), flash: $('c3-flash'),
    title: $('c3-title'), best: $('c3-best'), card: $('c3-card'), kind: $('c3-kind'), bname: $('c3-bname'), fkm: $('c3-fkm'),
    fmult: $('c3-fmult'), fcl: $('c3-fcl'), fbest: $('c3-fbest'), restart: $('c3-restart'),
  };

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(52, 1, 0.3, 1600);
  scene.add(camera);

  // ─── sky, sun, fog, environment ───
  const skyU = {
    uTop: { value: new THREE.Color('#4f86c4') }, uMid: { value: new THREE.Color('#9dc0e0') }, uHor: { value: new THREE.Color('#dbe4ea') },
    uSunDir: { value: new THREE.Vector3(0.3, 0.5, -0.8).normalize() }, uSunCol: { value: new THREE.Color('#fff2d0') },
    uNight: { value: 0 }, uSunGlow: { value: 1 },
  };
  const skyMat = new THREE.ShaderMaterial({ uniforms: skyU, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1200, 32, 16), skyMat);
  scene.add(sky);
  const fog = new THREE.Fog('#dbe4ea', 140, 430);
  scene.fog = fog;
  const hemi = new THREE.HemisphereLight('#cfe0f5', '#6d6a45', 0.7);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff0d2', 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1536, 1536);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -34; sc.right = 34; sc.top = 40; sc.bottom = -30; sc.near = 1; sc.far = 220;
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  // environment map from the sky itself (reflections on chrome, wet asphalt, glass)
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(new THREE.SphereGeometry(50, 24, 12), skyMat);
  const envGround = new THREE.Mesh(new THREE.CircleGeometry(60, 24), new THREE.MeshBasicMaterial({ color: '#5a5f3a' }));
  envGround.rotation.x = -Math.PI / 2; envGround.position.y = -0.5;
  envScene.add(envSky, envGround);
  let envTex: THREE.Texture | null = null;
  let envBucket = -1;
  function refreshEnv(bucket: number) {
    if (bucket === envBucket) return;
    envBucket = bucket;
    envTex?.dispose();
    envTex = pmrem.fromScene(envScene, 0.04).texture;
    scene.environment = envTex;
  }

  // ─── materials ───
  const asphalt = asphaltMaps(rngFx);
  const concrete = concreteMaps(rngFx);
  const concreteClean = concreteMaps(rngFx, false);
  const grass = grassMaps(rngFx);
  const wood = woodDeck(rngFx);
  const mat = {
    asphalt: new THREE.MeshStandardMaterial({ map: asphalt.map, roughnessMap: asphalt.rough, roughness: 1, metalness: 0.05, envMapIntensity: 0.8 }),
    gravel: new THREE.MeshStandardMaterial({ color: '#8d8672', roughness: 1 }),
    grass: new THREE.MeshStandardMaterial({ map: grass.map, roughness: 1 }),
    concrete: new THREE.MeshStandardMaterial({ map: concrete.map, roughnessMap: concrete.rough, roughness: 1 }),
    concreteClean: new THREE.MeshStandardMaterial({ map: concreteClean.map, roughness: 0.95 }),
    steelGreen: new THREE.MeshStandardMaterial({ color: '#2f6b4a', roughness: 0.6, metalness: 0.5 }),
    railDark: new THREE.MeshStandardMaterial({ color: '#3b3a38', roughness: 0.7, metalness: 0.5 }),
    galv: new THREE.MeshStandardMaterial({ color: '#b9bec2', roughness: 0.42, metalness: 0.85, envMapIntensity: 1.2 }),
    paint: new THREE.MeshPhysicalMaterial({ color: '#1e7ed6', roughness: 0.32, metalness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.15, envMapIntensity: 1.1 }),
    chrome: new THREE.MeshStandardMaterial({ color: '#e8eaee', roughness: 0.12, metalness: 1, envMapIntensity: 1.4 }),
    glass: new THREE.MeshPhysicalMaterial({ color: '#0e1a26', roughness: 0.08, metalness: 0.2, envMapIntensity: 1.6, clearcoat: 1 }),
    rubber: new THREE.MeshStandardMaterial({ color: '#17181a', roughness: 0.95 }),
    frame: new THREE.MeshStandardMaterial({ color: '#2b2622', roughness: 0.8, metalness: 0.3 }),
    trailer: new THREE.MeshStandardMaterial({ color: '#7a2a20', roughness: 0.6, metalness: 0.3 }),
    wood: new THREE.MeshStandardMaterial({ map: wood, roughness: 0.9 }),
    amber: new THREE.MeshStandardMaterial({ color: '#ffb000', emissive: '#ff9500', emissiveIntensity: 0.0, roughness: 0.4 }),
    red: new THREE.MeshStandardMaterial({ color: '#c8262d', emissive: '#ff1a1a', emissiveIntensity: 0.0, roughness: 0.4 }),
    lampFace: new THREE.MeshStandardMaterial({ color: '#f4f7ff', emissive: '#fff4d6', emissiveIntensity: 0.0, roughness: 0.2 }),
    bark: new THREE.MeshStandardMaterial({ color: '#cfc7b2', roughness: 0.95 }),
    pole: new THREE.MeshStandardMaterial({ color: '#5e4a33', roughness: 0.95 }),
    hazard: new THREE.MeshStandardMaterial({ map: (() => { const t = stripeTex(); t.repeat.set(3, 1); return t; })(), roughness: 0.7 }),
    flag: new THREE.MeshStandardMaterial({ color: '#e0262a', roughness: 0.9, side: THREE.DoubleSide }),
    beam: new THREE.MeshBasicMaterial({ color: '#cfe3ff', transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide }),
    city: new THREE.MeshStandardMaterial({ color: '#7d8797', roughness: 0.9 }),
    copper: new THREE.MeshStandardMaterial({ color: '#4f9a7a', roughness: 0.7 }),
  };
  const dbg = { flat: false };
  void dbg;

  // ─── ground, road, median ───
  grass.map.repeat.set(60, 60);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2600, 2600), mat.grass);
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.06; ground.receiveShadow = true;
  scene.add(ground);
  const fieldTex = [
    fieldMaps(rngFx, '#e3c22b', '#f0d24a', '#c9a81c'), // canola
    fieldMaps(rngFx, '#c9a95a', '#d9bb6c', '#a98c40'), // wheat
    fieldMaps(rngFx, '#a99a6a', '#bdae7c', '#8f8253'), // stubble
    fieldMaps(rngFx, '#6e5a3d', '#7d6947', '#5b4a31'), // summerfallow
  ];
  interface Field { m: THREE.Mesh; w: number; x: number; span: number }
  const fields: Field[] = [];
  for (let i = 0; i < 10; i++) for (const side of [-1, 1]) {
    const t = fieldTex[(i + (side > 0 ? 2 : 0)) % 4];
    t.repeat.set(24, 12);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(340, 200), new THREE.MeshStandardMaterial({ map: t, roughness: 1 }));
    m.rotation.x = -Math.PI / 2; m.position.y = -0.03; m.receiveShadow = true;
    scene.add(m);
    fields.push({ m, w: i * 200, x: side * (170 + 34), span: 10 * 200 });
  }
  asphalt.map.repeat.set(1, 30); asphalt.rough.repeat.set(1, 30);
  const ROAD_LEN = 760;
  const road = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, ROAD_LEN), mat.asphalt);
  road.rotation.x = -Math.PI / 2; road.position.set(0, 0.01, -ROAD_LEN / 2 + 60); road.receiveShadow = true;
  scene.add(road);
  const shoulder = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2 + 5, ROAD_LEN), mat.gravel);
  shoulder.rotation.x = -Math.PI / 2; shoulder.position.set(0, 0.0, -ROAD_LEN / 2 + 60); shoulder.receiveShadow = true;
  scene.add(shoulder);
  // oncoming carriageway across a grass median (divided highway like the photo)
  const road2 = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, ROAD_LEN), mat.asphalt);
  road2.rotation.x = -Math.PI / 2; road2.rotation.z = Math.PI; road2.position.set(-ROAD_HALF * 2 - 14, 0.01, -ROAD_LEN / 2 + 60); road2.receiveShadow = true;
  scene.add(road2);
  const shoulder2 = shoulder.clone(); shoulder2.position.x = road2.position.x; scene.add(shoulder2);

  // ─── instanced roadside scatter ───
  const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpP = new THREE.Vector3(), tmpS = new THREE.Vector3();
  function instanced(geo: THREE.BufferGeometry, material: THREE.Material, n: number, place: (i: number) => Inst, shadow = true) {
    const im = new THREE.InstancedMesh(geo, material, n);
    im.castShadow = shadow; im.receiveShadow = false;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const items: Inst[] = [];
    for (let i = 0; i < n; i++) items.push(place(i));
    scene.add(im);
    return { im, items };
  }
  const scatterGroups: { im: THREE.InstancedMesh; items: Inst[]; y: number }[] = [];
  // scrub bushes: crossed foliage cards
  const leafTex = foliageCard(rngFx, ['#4f6b2c', '#5f7d34', '#7a9440', '#3e5722']);
  const leafGold = foliageCard(rngFx, ['#c9a43a', '#d9b84a', '#a68a2c', '#7f8b34']);
  const cardGeo = (() => {
    const a = new THREE.PlaneGeometry(1, 1);
    const b = new THREE.PlaneGeometry(1, 1); b.rotateY(Math.PI / 2);
    const g = mergeGeos([a, b]);
    g.translate(0, 0.5, 0);
    return g;
  })();
  const leafMat = new THREE.MeshStandardMaterial({ map: leafTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1 });
  const leafGoldMat = new THREE.MeshStandardMaterial({ map: leafGold, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1 });
  scatterGroups.push({ ...instanced(cardGeo, leafMat, 260, () => ({ w: rngFx() * 1000, x: (rngFx() < 0.5 ? -1 : 1) * (9 + rngFx() * 50), s: 1.4 + rngFx() * 2.2, rot: rngFx() * 3, span: 1000 })), y: 0 });
  // poplars / aspen: trunk + tall cards
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.26, 5, 6); trunkGeo.translate(0, 2.5, 0);
  const crownGeo = (() => { const g = cardGeo.clone(); g.scale(4.2, 7, 4.2); g.translate(0, 3.6, 0); return g; })();
  const treeItems: Inst[] = [];
  for (let i = 0; i < 70; i++) {
    const side = rngFx() < 0.5 ? -1 : 1;
    treeItems.push({ w: rngFx() * 1400, x: side * (16 + rngFx() * 40) + (side > 0 ? 0 : -20), s: 0.8 + rngFx() * 0.7, rot: rngFx() * 3, span: 1400 });
  }
  scatterGroups.push({ ...instanced(trunkGeo, mat.bark, 70, (i) => treeItems[i]), y: 0 });
  scatterGroups.push({ ...instanced(crownGeo, leafMat, 70, (i) => treeItems[i]), y: 0 });
  // some gold aspen among them
  scatterGroups.push({ ...instanced(crownGeo, leafGoldMat, 18, () => { const side = rngFx() < 0.5 ? -1 : 1; return { w: rngFx() * 1400, x: side * (18 + rngFx() * 40) + (side > 0 ? 0 : -20), s: 0.8 + rngFx() * 0.6, rot: rngFx() * 3, span: 1400 }; }), y: 0 });
  scatterGroups.push({ ...instanced(trunkGeo, mat.bark, 18, (i) => scatterGroups[3].items[i]), y: 0 });
  // power poles (right side) and fence posts
  const poleGeo = mergeGeos([(() => { const g = new THREE.CylinderGeometry(0.12, 0.17, 9.5, 6); g.translate(0, 4.75, 0); return g; })(), (() => { const g = new THREE.BoxGeometry(2.2, 0.14, 0.14); g.translate(0, 8.9, 0); return g; })()]);
  scatterGroups.push({ ...instanced(poleGeo, mat.pole, 22, (i) => ({ w: i * 45, x: 10.5, s: 1, rot: 0, span: 22 * 45 })), y: 0 });
  const postGeo = new THREE.BoxGeometry(0.12, 1.3, 0.12); postGeo.translate(0, 0.65, 0);
  scatterGroups.push({ ...instanced(postGeo, mat.pole, 90, (i) => ({ w: i * 8, x: 13.5, s: 1, rot: 0, span: 90 * 8 })), y: 0 });
  // round bales
  const baleGeo = new THREE.CylinderGeometry(0.85, 0.85, 1.5, 14); baleGeo.rotateZ(Math.PI / 2); baleGeo.translate(0, 0.85, 0);
  scatterGroups.push({ ...instanced(baleGeo, new THREE.MeshStandardMaterial({ color: '#c9a95a', roughness: 1 }), 24, () => ({ w: rngFx() * 900, x: (rngFx() < 0.5 ? -1 : 1) * (18 + rngFx() * 40), s: 1, rot: rngFx() * 0.6, span: 900 })), y: 0 });
  // grain bins (corrugated steel, cone roof) in a yard
  const binGeo = mergeGeos([(() => { const g = new THREE.CylinderGeometry(3.2, 3.2, 6, 18); g.translate(0, 3, 0); return g; })(), (() => { const g = new THREE.ConeGeometry(3.4, 1.8, 18); g.translate(0, 6.9, 0); return g; })()]);
  scatterGroups.push({ ...instanced(binGeo, mat.galv, 8, (i) => ({ w: 600 + (i % 4) * 8 + Math.floor(i / 4) * 900, x: 48 + Math.floor(i / 4) * 12, s: 1, rot: 0, span: 1800 })), y: 0 });

  function mergeGeos(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
    // minimal merge for non-indexed position/normal/uv geometries
    const parts = gs.map((g) => g.index ? g.toNonIndexed() : g);
    const attrs = ['position', 'normal', 'uv'] as const;
    const out = new THREE.BufferGeometry();
    for (const a of attrs) {
      const arrs = parts.map((p) => p.getAttribute(a) as THREE.BufferAttribute);
      const size = arrs[0].itemSize;
      const total = arrs.reduce((n, x) => n + x.count, 0);
      const data = new Float32Array(total * size);
      let off = 0;
      for (const x of arrs) { data.set(x.array as Float32Array, off); off += x.count * size; }
      out.setAttribute(a, new THREE.BufferAttribute(data, size));
    }
    return out;
  }

  // ─── clouds, dust, beam, skyline ───
  const cloudTex = cloudSprite(rngFx);
  const clouds: { s: THREE.Sprite; x: number; y: number; z: number; sc: number }[] = [];
  const cloudMat = new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.9, depthWrite: false, fog: false });
  for (let i = 0; i < 22; i++) {
    const s = new THREE.Sprite(cloudMat);
    const sc = 140 + rngFx() * 220;
    s.scale.set(sc, sc * 0.5, 1);
    scene.add(s);
    clouds.push({ s, x: (rngFx() - 0.5) * 1800, y: 150 + rngFx() * 160, z: -300 - rngFx() * 700, sc });
  }
  const dotTex = softDot();
  const DUST_N = 80;
  const dustPos = new Float32Array(DUST_N * 3);
  const dustLife = new Float32Array(DUST_N);
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dustMat = new THREE.PointsMaterial({ map: dotTex, size: 1.6, transparent: true, opacity: 0.35, depthWrite: false, color: '#b9ab8a', sizeAttenuation: true });
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  scene.add(dust);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.6, 420, 12, 1, true), mat.beam);
  beam.position.y = 210;
  scene.add(beam);
  // skyline: modest towers plus a château-style railway hotel with a green copper roof
  const city = new THREE.Group();
  const winTex = windowsTex(rngFx, 12, 30);
  const cityMat = new THREE.MeshStandardMaterial({ color: '#8a93a3', roughness: 0.9, emissiveMap: winTex, emissive: '#ffd9a0', emissiveIntensity: 0, map: winTex });
  for (let i = 0; i < 16; i++) {
    const h = 24 + rngFx() * 70, wdt = 12 + rngFx() * 12;
    const b = new THREE.Mesh(new THREE.BoxGeometry(wdt, h, wdt), cityMat);
    b.position.set((rngFx() - 0.5) * 240 + 30, h / 2, (rngFx() - 0.5) * 80);
    city.add(b);
  }
  const hotel = new THREE.Group();
  const hb = new THREE.Mesh(new THREE.BoxGeometry(34, 30, 18), new THREE.MeshStandardMaterial({ color: '#b8a98c', roughness: 0.9, emissiveMap: winTex, emissive: '#ffd9a0', emissiveIntensity: 0, map: winTex }));
  hb.position.y = 15;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(12, 14, 4), mat.copper); roof.rotation.y = Math.PI / 4; roof.position.set(0, 37, 0);
  const tower = new THREE.Mesh(new THREE.BoxGeometry(10, 44, 10), hb.material); tower.position.set(-10, 22, 0);
  const tRoof = new THREE.Mesh(new THREE.ConeGeometry(7.5, 12, 4), mat.copper); tRoof.rotation.y = Math.PI / 4; tRoof.position.set(-10, 50, 0);
  hotel.add(hb, roof, tower, tRoof);
  hotel.position.set(-60, 0, 20);
  city.add(hotel);
  city.position.set(0, 0, -1000);
  scene.add(city);

  // ─── the rig: long-hood conventional tractor + step-deck trailer + steel truss ───
  const truck = new THREE.Group();
  scene.add(truck);
  const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = truck, shadow = true) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.position.set(x, y, z); b.castShadow = shadow; b.receiveShadow = shadow; parent.add(b); return b;
  };
  const cyl = (r: number, len: number, m: THREE.Material, x: number, y: number, z: number, axis: 'x' | 'y' | 'z', parent: THREE.Object3D = truck, seg = 16) => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), m);
    if (axis === 'x') c.rotation.z = Math.PI / 2; else if (axis === 'z') c.rotation.x = Math.PI / 2;
    c.position.set(x, y, z); c.castShadow = true; parent.add(c); return c;
  };
  const tireGeo = new THREE.CylinderGeometry(0.53, 0.53, 0.32, 20);
  const dualGeo = new THREE.CylinderGeometry(0.53, 0.53, 0.66, 20);
  const hubGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.05, 16);
  const wheels: THREE.Mesh[] = [];
  const addWheel = (x: number, z: number, dual: boolean, parent: THREE.Object3D) => {
    const w = new THREE.Mesh(dual ? dualGeo : tireGeo, mat.rubber);
    w.rotation.z = Math.PI / 2; w.position.set(x, 0.53, z); w.castShadow = true;
    const hub = new THREE.Mesh(hubGeo, mat.chrome);
    hub.position.y = (dual ? 0.34 : 0.17) * Math.sign(x);
    w.add(hub);
    parent.add(w); wheels.push(w);
  };
  // trailer (step deck): rear deck lower, front neck over the fifth wheel. Deck spans z 0..-12.5
  const trailer = new THREE.Group();
  truck.add(trailer);
  box(2.55, 0.16, 9.2, mat.trailer, 0, BED_H - 0.08, -4.6, trailer); // rear deck frame
  box(2.45, 0.05, 9.0, mat.wood, 0, BED_H + 0.02, -4.6, trailer, false);
  box(2.55, 0.16, 3.2, mat.trailer, 0, BED_H + 0.42, -10.9, trailer); // upper neck
  box(2.55, 0.5, 0.3, mat.trailer, 0, BED_H + 0.17, -9.3, trailer); // step
  box(1.0, 0.45, 12.4, mat.frame, 0, 0.95, -6.2, trailer); // rails
  box(0.15, 0.9, 0.15, mat.frame, -0.9, 0.5, -8.6, trailer); box(0.15, 0.9, 0.15, mat.frame, 0.9, 0.5, -8.6, trailer); // landing gear
  for (const z of [-1.3, -2.7]) for (const x of [-1.05, 1.05]) addWheel(x, z, true, trailer);
  box(2.4, 0.5, 0.05, mat.hazard, 0, 0.75, 0.05, trailer); // rear hazard board
  const rearSign = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 0.5), new THREE.MeshStandardMaterial({ map: plateTex('OVERSIZE LOAD', '#f2c12e', '#111', 512, 108, 72), roughness: 0.6 }));
  rearSign.position.set(0, BED_H + 0.32, 0.03); trailer.add(rearSign);
  for (const x of [-1.0, 1.0]) { box(0.35, 0.4, 0.03, mat.rubber, x, 0.45, 0.2, trailer, false); }
  const tail = [box(0.28, 0.12, 0.05, mat.red, -1.1, BED_H - 0.2, 0.02, trailer, false), box(0.28, 0.12, 0.05, mat.red, 1.1, BED_H - 0.2, 0.02, trailer, false)];
  const sideMarkers: THREE.Mesh[] = [];
  for (const z of [-2, -5, -8, -11]) for (const x of [-1.29, 1.29]) sideMarkers.push(box(0.03, 0.08, 0.16, mat.amber, x, BED_H - 0.05, z, trailer, false));
  // tractor: origin at fifth wheel z=-11.2 (under the neck)
  const cab = new THREE.Group();
  cab.position.z = -11.2;
  truck.add(cab);
  box(1.0, 0.4, 7.6, mat.frame, 0, 0.95, -2.6, cab); // frame rails
  for (const z of [0.0, 1.3]) for (const x of [-1.05, 1.05]) addWheel(x, z, true, cab); // tandem drive
  for (const x of [-1.05, 1.05]) addWheel(x, -5.2, false, cab); // steer axle
  // sleeper + cab
  const sleeper = box(2.5, 2.1, 2.0, mat.paint, 0, 2.2, -1.2, cab);
  const cabBox = box(2.45, 1.75, 1.7, mat.paint, 0, 2.15, -3.0, cab);
  box(2.4, 0.5, 2.2, mat.paint, 0, 3.5, -1.15, cab); // roof fairing base
  const fairing = box(2.3, 0.9, 1.6, mat.paint, 0, 3.75, -0.9, cab);
  fairing.rotation.x = 0.25;
  const wind = box(2.3, 0.8, 0.06, mat.glass, 0, 2.5, -3.88, cab, false);
  box(0.06, 0.6, 0.8, mat.glass, -1.24, 2.5, -3.1, cab, false); box(0.06, 0.6, 0.8, mat.glass, 1.24, 2.5, -3.1, cab, false); // door glass
  box(0.06, 0.5, 0.6, mat.glass, -1.26, 2.6, -1.3, cab, false); box(0.06, 0.5, 0.6, mat.glass, 1.26, 2.6, -1.3, cab, false); // sleeper windows
  void sleeper; void cabBox; void wind;
  // long hood
  const hood = box(2.1, 1.25, 2.7, mat.paint, 0, 1.85, -5.2, cab);
  void hood;
  box(2.15, 1.3, 0.12, mat.chrome, 0, 1.75, -6.55, cab); // grille surround
  box(1.6, 1.0, 0.02, new THREE.MeshStandardMaterial({ color: '#0d0f12', roughness: 0.4, metalness: 0.8 }), 0, 1.75, -6.62, cab, false);
  box(2.5, 0.35, 0.3, mat.chrome, 0, 0.95, -6.7, cab); // bumper
  const headL = cyl(0.17, 0.06, mat.lampFace, -0.85, 1.35, -6.6, 'z', cab, 12);
  const headR = cyl(0.17, 0.06, mat.lampFace, 0.85, 1.35, -6.6, 'z', cab, 12);
  // fenders over steer wheels: half cylinders
  for (const x of [-1.05, 1.05]) {
    const f = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.5, 14, 1, false, 0, Math.PI), mat.paint);
    f.rotation.z = Math.PI / 2; f.rotation.y = Math.PI / 2; f.position.set(x, 0.62, -5.2); f.castShadow = true; cab.add(f);
  }
  // stacks, tanks, mirrors, steps
  for (const x of [-1.35, 1.35]) {
    cyl(0.1, 3.4, mat.chrome, x, 2.6, -1.9, 'y', cab, 10);
    cyl(0.16, 0.9, mat.chrome, x, 1.3, -1.9, 'y', cab, 10);
    cyl(0.33, 1.5, mat.chrome, x * 0.95, 0.95, -3.3, 'z', cab, 14); // fuel tank
    box(0.6, 0.06, 0.6, mat.chrome, x, 0.55, -3.3, cab); // step
    box(0.05, 0.05, 1.0, mat.frame, x * 1.02, 2.9, -3.6, cab); // mirror arm
    box(0.04, 0.55, 0.22, mat.chrome, x * 1.1, 2.75, -4.1, cab);
  }
  // cab roof marker lights + bug deflector chrome
  const roofMarkers: THREE.Mesh[] = [];
  for (const x of [-0.8, -0.4, 0, 0.4, 0.8]) roofMarkers.push(box(0.1, 0.07, 0.07, mat.amber, x, 4.22, -1.1, cab, false));
  const hoodLamps = [box(0.1, 0.07, 0.07, mat.amber, -1.0, 2.5, -6.5, cab, false), box(0.1, 0.07, 0.07, mat.amber, 1.0, 2.5, -6.5, cab, false)];
  // headlight spots (night)
  const spots: THREE.SpotLight[] = [];
  for (const x of [-0.85, 0.85]) {
    const s = new THREE.SpotLight('#ffe9c4', 0, 90, 0.42, 0.55, 1.2);
    s.position.set(x, 1.35, -6.6);
    s.target.position.set(x * 2, 0.2, -60);
    cab.add(s, s.target);
    spots.push(s);
  }
  // ─── the load: galvanized steel truss (a bridge girder, of course) ───
  const loadG = new THREE.Group();
  truck.add(loadG);
  const TRUSS_L = LOAD_Z1 - LOAD_Z0, TRUSS_H = 4.3 - BED_H - 0.1, TRUSS_W = LOAD_HALF_W * 2 - 0.3;
  const trussGeo = new THREE.BoxGeometry(1, 1, 1);
  const trussMembers: THREE.Matrix4[] = [];
  const member = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, t = 0.16) => {
    const a = new THREE.Vector3(ax, ay, az), b = new THREE.Vector3(bx, by, bz);
    const len = a.distanceTo(b);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const dir = b.clone().sub(a).normalize();
    tmpQ.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    trussMembers.push(new THREE.Matrix4().compose(mid, tmpQ.clone(), new THREE.Vector3(t, len, t)));
  };
  {
    const y0 = BED_H + 0.12, y1 = y0 + TRUSS_H, zA = -LOAD_Z0, zB = -LOAD_Z1;
    const hw = TRUSS_W / 2;
    for (const x of [-hw, hw]) {
      member(x, y0, zA, x, y0, zB, 0.24); member(x, y1, zA, x, y1, zB, 0.24); // chords
      const n = 8;
      for (let i = 0; i <= n; i++) {
        const z = zA + (zB - zA) * (i / n);
        member(x, y0, z, x, y1, z, 0.14);
        if (i < n) { const z2 = zA + (zB - zA) * ((i + 1) / n); if (i % 2 === 0) member(x, y0, z, x, y1, z2, 0.12); else member(x, y1, z, x, y0, z2, 0.12); }
      }
    }
    // cross bracing top and bottom
    for (let i = 0; i <= 8; i++) { const z = zA + (zB - zA) * (i / 8); member(-hw, y1, z, hw, y1, z, 0.12); member(-hw, y0, z, hw, y0, z, 0.14); }
    for (let i = 0; i < 8; i++) { const z = zA + (zB - zA) * (i / 8), z2 = zA + (zB - zA) * ((i + 1) / 8); member(-hw, y1, z, hw, y1, z2, 0.09); }
  }
  const truss = new THREE.InstancedMesh(trussGeo, mat.galv, trussMembers.length);
  trussMembers.forEach((m, i) => truss.setMatrixAt(i, m));
  truss.castShadow = true; truss.receiveShadow = true;
  loadG.add(truss);
  // chains, red flags on corners, amber load markers
  for (const z of [-LOAD_Z0 - 1.2, -LOAD_Z1 + 1.2]) for (const x of [-LOAD_HALF_W + 0.1, LOAD_HALF_W - 0.1]) {
    const f = new THREE.Mesh(new THREE.PlaneGeometry(0.45, 0.35), mat.flag);
    f.position.set(x, 4.3 + 0.2, z); loadG.add(f);
    cyl(0.03, 0.9, mat.galv, x, 4.3 - 0.2, z, 'y', loadG, 6);
  }
  const loadMarkers: THREE.Mesh[] = [];
  for (const z of [-LOAD_Z0 - 0.3, -LOAD_Z1 + 0.3]) for (const x of [-LOAD_HALF_W, LOAD_HALF_W]) loadMarkers.push(box(0.1, 0.1, 0.1, mat.amber, x, BED_H + 0.2, z, loadG, false));
  // marker bar at next bridge
  const marker = new THREE.Mesh(new THREE.BoxGeometry(LOAD_HALF_W * 2, 0.06, 0.3), new THREE.MeshBasicMaterial({ color: '#5fd68a', fog: false }));
  marker.visible = false;
  scene.add(marker);

  // ─── bridges: concrete box girder on round piers · green plate girder · rail ballast deck ───
  const lampTex: Record<Verdict, THREE.Texture> = {
    fit: plateTex('FITS', '#1f8f3f', '#fff', 256, 128, 80, '#0d4a20'),
    steady: plateTex('STEADY', '#f2b32a', '#111', 256, 128, 64, '#7a5a00'),
    no: plateTex('✕', '#e2382f', '#fff', 256, 128, 96, '#6a1410'),
  };
  const lampMat: Record<Verdict, THREE.MeshBasicMaterial> = {
    fit: new THREE.MeshBasicMaterial({ map: lampTex.fit }), steady: new THREE.MeshBasicMaterial({ map: lampTex.steady }), no: new THREE.MeshBasicMaterial({ map: lampTex.no }),
  };
  const plateCache = new Map<string, THREE.MeshBasicMaterial>();
  const plateMatFor = (clear: number) => {
    const k = clear.toFixed(2);
    let m = plateCache.get(k);
    if (!m) { m = new THREE.MeshBasicMaterial({ map: plateTex(fmtM(clear), '#f2c12e', '#111', 256, 128, 86) }); plateCache.set(k, m); }
    return m;
  };
  const boardMat = new THREE.MeshBasicMaterial({ map: (() => { const t = stripeTex(); t.repeat.set(2, 1); return t; })() });
  const railTieGeo = new THREE.BoxGeometry(1, 1, 1);
  const bridges: Bridge[] = [];
  let bridgeSeq = 0;
  const railNameMat = new THREE.MeshStandardMaterial({ map: plateTex(RAIL_NAME, '#2a2926', '#d8cfb8', 1024, 128, 70, '#2a2926'), roughness: 0.8 });
  function makeBridge(): Bridge {
    const group = new THREE.Group();
    group.visible = false;
    scene.add(group);
    const lanes: Lane[] = [];
    for (let i = 0; i < 3; i++) {
      const deck = new THREE.Group();
      // box girder: main slab + narrower soffit box + parapet
      const slab = new THREE.Mesh(railTieGeo, mat.concrete); slab.name = 'slab';
      const soffit = new THREE.Mesh(railTieGeo, mat.concrete); soffit.name = 'soffit';
      const parapet = new THREE.Mesh(railTieGeo, mat.concreteClean); parapet.name = 'parapet';
      const rail = new THREE.Mesh(railTieGeo, mat.galv); rail.name = 'rail';
      for (const m of [slab, soffit, parapet, rail]) { m.castShadow = true; m.receiveShadow = true; deck.add(m); }
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.75), plateMatFor(4.3));
      const lamp = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.85), lampMat.fit);
      const board = new THREE.Mesh(railTieGeo, boardMat);
      group.add(deck, plate, lamp, board);
      lanes.push({ clear: 4.3, deck, plate, lamp, board, verdict: 'fit' });
    }
    const piers: THREE.Mesh[] = [];
    for (let i = 0; i < 2; i++) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(PIER_R, PIER_R * 1.15, 1, 18), mat.concrete);
      p.castShadow = true; p.receiveShadow = true; group.add(p); piers.push(p);
    }
    const abut: THREE.Mesh[] = [];
    for (let i = 0; i < 2; i++) {
      const a = new THREE.Mesh(railTieGeo, mat.concrete); a.castShadow = true; a.receiveShadow = true; group.add(a); abut.push(a);
      const berm = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 1, 1, 4, 1), mat.grass); berm.name = 'berm'; berm.receiveShadow = true; group.add(berm); abut.push(berm);
    }
    const nameSign = new THREE.Mesh(new THREE.PlaneGeometry(9, 1.1), railNameMat); nameSign.name = 'railname'; nameSign.visible = false; group.add(nameSign);
    return { id: 0, w: 0, depth: 10, kind: 'girder', name: '', lanes, group, piers, abut, cleared: false, minMargin: 9, active: false, faceHidden: false, brakedUnder: false, hammeredUnder: false };
  }
  for (let i = 0; i < 8; i++) bridges.push(makeBridge());
  function layoutBridge(b: Bridge) {
    const d = b.depth;
    const isRail = b.kind === 'rail', isSteel = b.kind === 'steel';
    const thick = isRail ? 1.5 : isSteel ? 1.3 : 1.2;
    for (let i = 0; i < 3; i++) {
      const L = b.lanes[i];
      const x = LANE_X[i];
      const wdt = i === 1 ? 3.8 : 3.8 + 2.6;
      const cx = i === 0 ? x - 1.3 : i === 2 ? x + 1.3 : x;
      const slab = L.deck.getObjectByName('slab') as THREE.Mesh, soffit = L.deck.getObjectByName('soffit') as THREE.Mesh;
      const parapet = L.deck.getObjectByName('parapet') as THREE.Mesh, rail = L.deck.getObjectByName('rail') as THREE.Mesh;
      slab.material = isSteel ? mat.concreteClean : isRail ? mat.railDark : mat.concrete;
      soffit.material = isSteel ? mat.steelGreen : isRail ? mat.railDark : mat.concrete;
      // slab (top) and soffit (bottom, narrower) — the soffit's underside is the posted clearance
      slab.position.set(cx, L.clear + thick * 0.75, -d / 2); slab.scale.set(wdt, thick * 0.5, d);
      soffit.position.set(cx, L.clear + thick * 0.25, -d / 2); soffit.scale.set(wdt - 0.8, thick * 0.5 + 0.02, isSteel ? d - 0.6 : d - 0.3);
      parapet.position.set(cx, L.clear + thick + 0.45, -d / 2); parapet.scale.set(wdt, 0.9, isRail ? 0.6 : 0.35); parapet.visible = !isRail;
      rail.position.set(cx, L.clear + thick + (isRail ? 0.25 : 1.0), -d / 2); rail.scale.set(wdt, isRail ? 0.18 : 0.08, isRail ? 2.6 : 0.08);
      rail.material = isRail ? mat.railDark : mat.galv;
      L.plate.material = plateMatFor(L.clear);
      L.plate.position.set(x, L.clear + thick * 0.62, 0.05);
      L.lamp.position.set(x, L.clear + thick + 0.55, 0.05);
      L.board.position.set(cx, L.clear + 0.14, 0.04); L.board.scale.set(wdt, 0.28, 0.06);
      L.plate.visible = L.lamp.visible = L.board.visible = true;
    }
    for (let i = 0; i < 2; i++) {
      const p = b.piers[i];
      const hL = Math.max(b.lanes[i].clear, b.lanes[i + 1].clear) + 0.3;
      p.visible = !isRail;
      p.position.set(PIER_X[i], hL / 2, -d / 2); p.scale.set(1, hL, 1);
    }
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const lane = b.lanes[i === 0 ? 0 : 2];
      const hA = lane.clear + 0.4;
      const wall = b.abut[i * 2], berm = b.abut[i * 2 + 1];
      wall.position.set(side * (ROAD_HALF + 2.9), hA / 2, -d / 2); wall.scale.set(1.2, hA, d + 0.4);
      berm.position.set(side * (ROAD_HALF + 12), hA / 2 + 0.6, -d / 2); berm.scale.set(18, hA + 1.2, d + 26); berm.rotation.y = Math.PI / 4;
    }
    const ns = b.group.getObjectByName('railname') as THREE.Mesh;
    ns.visible = isRail;
    ns.position.set(0, b.lanes[1].clear + thick + 0.9, 0.35);
    b.group.visible = true;
  }

  // ─── crash chunks ───
  const chunks: Chunk[] = [];
  const chunkGeo = new THREE.BoxGeometry(1, 1, 1);
  for (let i = 0; i < 22; i++) {
    const s = 0.3 + rngFx() * 0.5;
    const m = new THREE.Mesh(chunkGeo, i % 3 === 0 ? mat.concrete : mat.galv);
    m.scale.set(s * (i % 3 === 0 ? 1.4 : 0.5), s * (0.4 + rngFx() * 0.6), s * (i % 3 === 0 ? 1 : 3));
    m.visible = false; m.castShadow = true;
    scene.add(m);
    chunks.push({ m, v: new THREE.Vector3(), av: new THREE.Vector3() });
  }

  // ─── state ───
  const G = {
    phase: 'title' as Phase, dist: 0, speed: 0, brake: false, brakeF: 1, hammer: false, mult: 1, score: 0,
    lane: 1, laneX: 0, loadH: 4.3, sway: 0, swayV: 0, swayPh: 0, gustLift: 0, potholeBounce: 0,
    cleared: 0, shaveChain: 0, shaveUntil: -1, shaveRun: 0, topMult: 1, bridgeCount: 0, nextW: FIRST_BRIDGE,
    wpIdx: 0, wpW: 0, wpDeadline: 0, wpClock: 0, dispIdx: 0, dispProg: 0, bonusKm: 0,
    crashKind: null as string | null, crashBridge: '', crashT: 0, crashPt: new THREE.Vector3(), shake: 0, time: 0, best: 0, tod: 0,
  };
  try { G.best = parseFloat(localStorage.getItem('clr3d.best') || '0') || 0; } catch { /* private mode */ }
  const lift = () => SWAY_ARM * Math.abs(Math.sin(G.sway));
  const hEff = () => G.loadH + lift() + G.gustLift + G.potholeBounce;
  const hSteady = () => G.loadH + G.gustLift + G.potholeBounce;

  // ─── clearance generation (relative to the load's steady height h; posted in 0.05 m steps) ───
  // No hydraulics in this build: "graze" fits only with a steady load, "easy" always fits, decoys never.
  function solutionClear(h: number): number {
    const r = rngWorld();
    if (r < 0.45) return step05(h + 0.03 + rngWorld() * 0.05 + 0.001); // graze: brake to steady the load
    return step05(h + 0.15 + rngWorld() * 0.25); // easy
  }
  function decoyClear(h: number): number {
    return rngWorld() < 0.45 ? step05(h + 0.03 + 0.001) : step05(h - 0.85 + rngWorld() * 0.3); // a second graze lane, or hopeless
  }
  function spawnBridge(b: Bridge, w: number, idx: number) {
    b.id = ++bridgeSeq; b.w = w; b.depth = 9 + rngWorld() * 5; b.cleared = false; b.minMargin = 9; b.active = true; b.faceHidden = false;
    b.brakedUnder = false; b.hammeredUnder = false;
    const isRail = idx % 3 === 2 && idx > 1;
    b.kind = isRail ? 'rail' : rngWorld() < 0.55 ? 'girder' : 'steel';
    b.name = isRail ? RAIL_NAME : BRIDGE_NAMES[Math.floor(rngWorld() * BRIDGE_NAMES.length)];
    const h = G.loadH;
    if (idx < 2) { const c = idx === 0 ? step05(h + 0.25) : step05(h + 0.2); for (const L of b.lanes) L.clear = c; }
    else if (isRail) { const c = solutionClear(h); for (const L of b.lanes) L.clear = c; }
    else { const sol = Math.floor(rngWorld() * 3); for (let i = 0; i < 3; i++) b.lanes[i].clear = i === sol ? solutionClear(h) : decoyClear(h); }
    if (!b.lanes.some((L) => L.clear >= h + 0.02)) b.lanes[Math.floor(rngWorld() * 3)].clear = step05(h + 0.05);
    layoutBridge(b);
    updateVerdicts(b, hSteady(), hSteady());
  }
  const spacing = () => Math.max(78, 108 + rngWorld() * 55 - 0.015 * G.dist);
  function fillBridges() {
    while (G.nextW < G.dist + 560) {
      const free = bridges.find((b) => !b.active);
      if (!free) break;
      spawnBridge(free, G.nextW, G.bridgeCount++);
      G.nextW += spacing();
    }
  }
  function resetBridges() {
    for (const b of bridges) { b.active = false; b.group.visible = false; }
    G.bridgeCount = 0; G.nextW = G.dist + FIRST_BRIDGE;
    fillBridges();
  }
  function updateVerdicts(b: Bridge, hNow: number, hLow: number) {
    for (const L of b.lanes) {
      const v: Verdict = L.clear >= hNow ? 'fit' : L.clear >= hLow ? 'steady' : 'no';
      if (v !== L.verdict) { L.verdict = v; L.lamp.material = lampMat[v]; }
    }
  }
  // waypoints: deadline set so cruising arrives ~12% late
  function setWaypoint(i: number) {
    G.wpIdx = i;
    const [, len] = WAYPOINTS[i % WAYPOINTS.length];
    G.wpW = G.dist + len;
    const v0 = Math.min(SPEED_CAP, BASE_SPEED + SPEED_PER_M * G.dist), v1 = Math.min(SPEED_CAP, BASE_SPEED + SPEED_PER_M * (G.dist + len));
    G.wpDeadline = (len / ((v0 + v1) / 2)) / 1.12;
    G.wpClock = G.wpDeadline;
  }
  const wpName = () => WAYPOINTS[G.wpIdx % WAYPOINTS.length][0];

  // ─── run control ───
  function resetRun() {
    G.dist = 0; G.speed = BASE_SPEED; G.brake = false; G.brakeF = 1; G.hammer = false; G.mult = 1; G.score = 0;
    G.lane = 1; G.laneX = 0; G.sway = 0; G.swayV = 0; G.swayPh = rngFx() * 6; G.gustLift = 0; G.potholeBounce = 0;
    G.cleared = 0; G.shaveChain = 0; G.shaveUntil = -1; G.shaveRun = 0; G.topMult = 1; G.bonusKm = 0;
    G.crashKind = null; G.crashBridge = ''; G.crashT = 0; G.shake = 0; G.tod = 0; G.dispIdx = 0; G.dispProg = 0;
    rngWorld = mulberry32(seed + 1);
    resetBridges();
    setWaypoint(0);
    for (const c of chunks) c.m.visible = false;
    loadG.visible = true;
    truck.rotation.set(0, 0, 0); truck.position.set(0, 0, 0);
    el.card.classList.remove('show'); el.banner.classList.remove('show');
    applyTimeOfDay(0);
  }
  function beginRun() {
    resetRun();
    G.phase = 'run';
    el.title.classList.add('hidden');
    el.hud.classList.remove('hidden');
    el.hint.style.opacity = '1';
    setTimeout(() => (el.hint.style.opacity = '0'), 7000);
  }
  function crash(kind: 'BRIDGE STRIKE' | 'PIER STRIKE', b: Bridge, point: THREE.Vector3) {
    G.phase = 'crash'; G.crashKind = kind; G.crashBridge = b.name; G.crashT = 0; G.crashPt.copy(point); G.brake = false;
    if (G.score > G.best) { G.best = G.score; try { localStorage.setItem('clr3d.best', String(G.best)); } catch { /* ignore */ } }
    if (reduceMotion) { showFail(); return; }
    loadG.visible = false;
    for (const c of chunks) {
      c.m.visible = true;
      c.m.position.set(point.x + (rngFx() - 0.5) * 2.8, point.y - rngFx() * 2.2, point.z + (rngFx() - 0.5) * 6);
      c.v.set((rngFx() - 0.5) * 10, 2 + rngFx() * 8, 5 + rngFx() * 12);
      c.av.set(rngFx() * 6, rngFx() * 6, rngFx() * 6);
    }
    G.shake = 1;
    el.flash.style.transition = 'none'; el.flash.style.opacity = '0.7';
    requestAnimationFrame(() => { el.flash.style.transition = 'opacity .6s'; el.flash.style.opacity = '0'; });
  }
  function showFail() {
    G.phase = 'fail';
    el.kind.textContent = (G.crashKind || 'BRIDGE STRIKE').toLowerCase();
    el.bname.textContent = G.crashBridge;
    el.fkm.textContent = G.score.toFixed(2) + ' km'; el.fmult.textContent = '×' + G.topMult;
    el.fcl.textContent = String(G.cleared); el.fbest.textContent = G.best.toFixed(2) + ' km';
    el.card.classList.add('show');
  }
  let bannerTimer = 0;
  function banner(a: string, b = '', warn = false, ms = 1500) {
    (el.banner.children[0] as HTMLElement).textContent = a;
    (el.banner.children[1] as HTMLElement).textContent = b;
    el.banner.classList.toggle('warn', warn);
    el.banner.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = window.setTimeout(() => el.banner.classList.remove('show'), ms);
  }
  function dispatchTick(ev: 'clear' | 'shave' | 'noshave', b?: Bridge) {
    const d = DISPATCH[G.dispIdx % DISPATCH.length];
    if (d.id === 'nobrake' && ev === 'clear') G.dispProg = b && b.brakedUnder ? 0 : G.dispProg + 1;
    if (d.id === 'shave3') { if (ev === 'shave') G.dispProg++; else if (ev === 'noshave') G.dispProg = 0; }
    if (d.id === 'hammer2' && ev === 'clear' && b && b.hammeredUnder) G.dispProg++;
    if (d.id === 'clear8' && ev === 'clear') G.dispProg++;
    if (G.dispProg >= d.goal) {
      G.score += 0.25; G.bonusKm += 0.25;
      banner('Dispatch bonus', d.text + ' · +0.25 km');
      G.dispIdx++; G.dispProg = 0;
    }
  }

  // ─── simulation ───
  function simulate(dt: number) {
    const base = Math.min(SPEED_CAP, BASE_SPEED + SPEED_PER_M * G.dist);
    const targetF = G.brake ? BRAKE_FACTOR : 1;
    G.brakeF += (targetF - G.brakeF) * Math.min(1, (G.brake ? 2.2 : 1.1) * dt);
    G.speed = base * G.brakeF * (G.hammer ? HAMMER_SPEED : 1);
    G.dist += G.speed * dt;
    G.tod = clamp(G.dist / (NIGHT_KM * 1000), 0, 1);
    // multiplier / score
    const chainMult = G.shaveChain > 0 && G.dist < G.shaveUntil ? SHAVE_CHAIN[Math.min(G.shaveChain, SHAVE_CHAIN.length) - 1] : 1;
    if (G.dist >= G.shaveUntil) G.shaveChain = 0;
    G.mult = chainMult * (G.hammer ? HAMMER_SCORE : 1);
    G.topMult = Math.max(G.topMult, G.mult);
    G.score += (G.speed * dt / 1000) * G.mult;
    // lane
    const tx = LANE_X[G.lane];
    const dx = (tx - G.laneX) * Math.min(1, LANE_LERP * dt);
    G.laneX += dx;
    if (Math.abs(tx - G.laneX) < 0.004) G.laneX = tx;
    // sway: driven oscillator, excited by speed (and hammer), damped hard by braking
    const sf = (G.speed / BASE_SPEED) ** 2 * (G.hammer ? SWAY_HAMMER : 1);
    G.swayPh += dt;
    const ex = SWAY_A * sf * (Math.sin(2.1 * G.swayPh) + 0.6 * Math.sin(3.7 * G.swayPh + 1.3));
    const c = G.brake ? SWAY_C_BRAKE : SWAY_C;
    G.swayV += (-SWAY_K * G.sway - c * G.swayV + ex) * dt - dx * 0.03; // lane changes kick the load
    G.sway += G.swayV * dt;
    // waypoint clock
    G.wpClock -= dt;
    if (G.dist >= G.wpW) {
      if (G.wpClock >= 0) { G.score += 0.4; G.bonusKm += 0.4; banner(wpName(), 'On time · +0.40 km'); }
      else banner(wpName(), 'Late. Dispatch has noted it.', true, 2200);
      setWaypoint(G.wpIdx + 1);
    }
    // bridges
    fillBridges();
    const top = hEff();
    const z0 = G.dist + LOAD_Z0, z1 = G.dist + LOAD_Z1;
    for (const b of bridges) {
      if (!b.active) continue;
      if (b.w + b.depth < G.dist - 70) { b.active = false; b.group.visible = false; continue; }
      const under = z1 > b.w && z0 < b.w + b.depth;
      if (under && !b.cleared) {
        if (G.brake) b.brakedUnder = true;
        if (G.hammer) b.hammeredUnder = true;
        const li = Math.abs(G.laneX) < 1.9 ? 1 : G.laneX < 0 ? 0 : 2;
        const L = b.lanes[li];
        if (b.kind !== 'rail') {
          for (const px of PIER_X) {
            if (Math.abs(G.laneX - px) < LOAD_HALF_W + PIER_R) {
              crash('PIER STRIKE', b, new THREE.Vector3(px, Math.min(top, L.clear) - 0.8, G.dist - Math.max(b.w, z0) - 1));
              return;
            }
          }
        }
        if (top > L.clear) { crash('BRIDGE STRIKE', b, new THREE.Vector3(G.laneX, L.clear, G.dist - Math.max(b.w, z0) - 0.5)); return; }
        b.minMargin = Math.min(b.minMargin, L.clear - top);
      }
      if (!b.cleared && z0 > b.w + b.depth) {
        b.cleared = true; G.cleared++;
        if (b.minMargin < SHAVE_M) {
          G.shaveChain = Math.min(G.shaveChain + 1, SHAVE_CHAIN.length);
          G.shaveUntil = G.dist + SHAVE_LEN;
          const m = SHAVE_CHAIN[G.shaveChain - 1];
          banner('Close shave', `${Math.max(0, Math.round(b.minMargin * 100))} cm · ×${m}`);
          if (!reduceMotion) G.shake = Math.max(G.shake, 0.5);
          dispatchTick('shave');
        } else dispatchTick('noshave');
        dispatchTick('clear', b);
      }
    }
  }
  function simulateCrash(dtReal: number) {
    G.crashT += dtReal;
    const dt = dtReal * 0.15;
    for (const c of chunks) {
      c.v.y -= 9.8 * dt;
      c.m.position.addScaledVector(c.v, dt);
      if (c.m.position.y < c.m.scale.y / 2) { c.m.position.y = c.m.scale.y / 2; c.v.y *= -0.3; c.v.x *= 0.8; c.v.z *= 0.8; }
      c.m.rotation.x += c.av.x * dt; c.m.rotation.y += c.av.y * dt;
    }
    truck.rotation.x = Math.min(0.04, G.crashT * 0.12);
    if (G.crashT > 1.3) showFail();
  }

  // ─── time of day: golden hour → blue dusk → night ───
  const KEYS = {
    top: ['#4f86c4', '#2f3f77', '#060a18'], mid: ['#9dc0e0', '#8a6a8f', '#101a36'], hor: ['#dbe4ea', '#f2a35f', '#1c2a4a'],
    sunCol: ['#fff2d0', '#ffb070', '#b9c8ff'], sunI: [2.6, 1.4, 0.35], hemiI: [0.7, 0.35, 0.12], hemiSky: ['#cfe0f5', '#6a5f8f', '#1a2440'],
    fogN: [140, 90, 50], fogF: [430, 330, 250], exposure: [1.0, 0.95, 0.85],
  };
  const cA = new THREE.Color(), cB = new THREE.Color();
  const mix3 = (arr: string[], t: number, out: THREE.Color) => {
    const k = t < 0.5 ? 0 : 1, f = smooth(t < 0.5 ? t * 2 : (t - 0.5) * 2);
    return out.copy(cA.set(arr[k])).lerp(cB.set(arr[k + 1]), f);
  };
  const mixN = (arr: number[], t: number) => { const k = t < 0.5 ? 0 : 1, f = smooth(t < 0.5 ? t * 2 : (t - 0.5) * 2); return lerp(arr[k], arr[k + 1], f); };
  let lightsOn = 0;
  function applyTimeOfDay(t: number) {
    mix3(KEYS.top, t, skyU.uTop.value); mix3(KEYS.mid, t, skyU.uMid.value); mix3(KEYS.hor, t, skyU.uHor.value);
    mix3(KEYS.sunCol, t, skyU.uSunCol.value);
    const night = smooth(clamp((t - 0.45) / 0.5, 0, 1));
    skyU.uNight.value = night;
    skyU.uSunGlow.value = 1 - night;
    // sun sweeps from 35° elevation at the start to the horizon at dusk, then the moon takes over from the other side
    const el0 = lerp(0.6, 0.06, smooth(clamp(t / 0.55, 0, 1)));
    const moon = smooth(clamp((t - 0.55) / 0.45, 0, 1));
    const az = lerp(-0.55, -1.1, t);
    const sd = new THREE.Vector3(Math.sin(az) * Math.cos(el0), Math.sin(el0), -Math.cos(az) * Math.cos(el0));
    const md = new THREE.Vector3(0.6, 0.55, -0.4).normalize();
    sd.lerp(md, moon).normalize();
    skyU.uSunDir.value.copy(sd);
    sun.position.copy(sd).multiplyScalar(90).add(new THREE.Vector3(0, 0, -20));
    sun.color.copy(skyU.uSunCol.value);
    sun.intensity = mixN(KEYS.sunI, t);
    hemi.intensity = mixN(KEYS.hemiI, t);
    mix3(KEYS.hemiSky, t, hemi.color);
    fog.color.copy(skyU.uHor.value);
    fog.near = mixN(KEYS.fogN, t); fog.far = mixN(KEYS.fogF, t);
    renderer.toneMappingExposure = mixN(KEYS.exposure, t);
    cloudMat.color.copy(skyU.uHor.value).lerp(new THREE.Color('#ffffff'), 0.35 * (1 - night));
    cloudMat.opacity = 0.9 - 0.6 * night;
    lightsOn = smooth(clamp((t - 0.38) / 0.2, 0, 1));
    for (const s of spots) s.intensity = 260 * lightsOn;
    mat.lampFace.emissiveIntensity = 2.5 * lightsOn;
    mat.amber.emissiveIntensity = 2.0 * lightsOn;
    mat.red.emissiveIntensity = 1.6 * lightsOn;
    cityMat.emissiveIntensity = 1.2 * lightsOn; (hb.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.4 * lightsOn;
    mat.beam.opacity = 0.16 + 0.2 * night;
    refreshEnv(Math.floor(t * 8));
  }
  void headL; void headR; void tail; void sideMarkers; void roofMarkers; void hoodLamps; void loadMarkers;

  // ─── camera ───
  let portrait = false;
  let camMode: 'chase' | 'dolly' = 'chase';
  const camTarget = new THREE.Vector3(0, 2.5, -20);
  const camPos = new THREE.Vector3(0, CAM_UP, CAM_BACK);
  const tmpV = new THREE.Vector3();
  function updateCamera(dt: number) {
    if (G.phase === 'title') {
      const a = G.time * 0.18;
      camPos.set(Math.sin(a) * 24, 5 + Math.sin(a * 0.7) * 1.5, -8 + Math.cos(a) * 24);
      camTarget.set(0, 2.6, -8);
    } else if (G.phase === 'crash' && !reduceMotion) {
      const p = G.crashPt;
      camPos.lerp(tmpV.set(p.x + 4.5, p.y + 1.6, p.z + 10), Math.min(1, G.crashT / 1.1) * 0.06);
      camTarget.lerp(p, 0.15);
    } else if (camMode === 'dolly') {
      camPos.lerp(tmpV.set(G.laneX - 9, 1.6, -4), Math.min(1, 4 * dt));
      camTarget.set(G.laneX + 6, 3.4, -14);
    } else {
      camPos.lerp(tmpV.set(G.laneX * 0.5, CAM_UP, CAM_BACK), Math.min(1, 4 * dt));
      camTarget.set(G.laneX * 0.3, 2.6, -28);
    }
    camera.position.copy(camPos);
    if (G.shake > 0 && !reduceMotion) {
      const s = G.shake * 0.35;
      camera.position.x += (Math.random() - 0.5) * s; camera.position.y += (Math.random() - 0.5) * s;
      G.shake = Math.max(0, G.shake - dt * 2.2);
    }
    camera.lookAt(camTarget);
  }

  // ─── frame ───
  function placeWorld(dt: number) {
    const d = G.dist;
    asphalt.map.offset.y = (d / (ROAD_LEN / 30)) % 1; asphalt.rough.offset.y = asphalt.map.offset.y;
    grass.map.offset.y = (d / (2600 / 60)) % 1;
    for (const f of fields) { while (f.w < d - 260) f.w += f.span; f.m.position.set(f.x, f.m.position.y, d - f.w); }
    for (const g of scatterGroups) {
      const { im, items } = g;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        while (it.w < d - 60) it.w += it.span;
        tmpP.set(it.x, g.y, d - it.w); tmpQ.setFromAxisAngle(tmpV.set(0, 1, 0), it.rot); tmpS.setScalar(it.s);
        im.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      }
      im.instanceMatrix.needsUpdate = true;
    }
    for (const c of clouds) c.s.position.set(c.x - (d * 0.02) % 400, c.y, c.z);
    city.position.z = -1000 + 0; city.scale.setScalar(1 + Math.min(2.2, d / 2600));
    beam.position.set(0, 210, d - G.wpW);
    beam.visible = G.phase !== 'title';
    for (const b of bridges) {
      if (!b.active) continue;
      b.group.position.z = d - b.w;
      const passed = b.w < d - 1;
      if (passed !== b.faceHidden) { b.faceHidden = passed; for (const L of b.lanes) L.plate.visible = L.lamp.visible = L.board.visible = !passed; }
    }
    // truck pose
    const tx = LANE_X[G.lane];
    truck.position.x = G.laneX;
    if (G.phase !== 'crash') { truck.rotation.z = (tx - G.laneX) * 0.03; truck.rotation.y = (tx - G.laneX) * -0.05; }
    loadG.rotation.z = G.sway;
    loadG.position.y = -0.02 * Math.abs(Math.sin(G.time * 9)) * (G.speed / 30);
    const spin = G.speed * dt / 0.53;
    for (const w of wheels) w.rotation.x -= spin;
    // dust from the trailer tandems
    if (G.phase === 'run') {
      let spawned = 0;
      for (let i = 0; i < DUST_N; i++) {
        if (dustLife[i] > 0) { dustLife[i] -= dt * 1.6; dustPos[i * 3 + 2] += Math.min(G.speed * 0.3, 7) * dt; dustPos[i * 3 + 1] += dt * 0.6; dustPos[i * 3] += (Math.random() - 0.5) * dt; if (dustPos[i * 3 + 2] > 5) dustLife[i] = 0; }
        else if (G.speed > 8 && spawned < 2 && Math.random() < 0.5) { spawned++; dustLife[i] = 0.6 + Math.random() * 0.5; dustPos[i * 3] = G.laneX + (Math.random() < 0.5 ? -1.1 : 1.1) + (Math.random() - 0.5) * 0.6; dustPos[i * 3 + 1] = 0.2; dustPos[i * 3 + 2] = -2.5 + Math.random() * 2; }
        if (dustLife[i] <= 0) dustPos[i * 3 + 1] = -5;
      }
      dustGeo.attributes.position.needsUpdate = true;
      dustMat.opacity = 0.14 * (1 - lightsOn * 0.7);
    }
    // lamps / marker / chips on the nearest uncleared bridge
    let nb: Bridge | null = null;
    for (const b of bridges) if (b.active && !b.cleared && b.w + b.depth > d + LOAD_Z0 && (!nb || b.w < nb.w)) nb = b;
    if (nb && nb.w < d + LOOK_AHEAD) {
      updateVerdicts(nb, hEff(), hSteady());
      marker.visible = G.phase === 'run';
      marker.position.set(G.laneX, hEff(), d - nb.w + 0.6);
      marker.rotation.z = G.sway;
      const fits = nb.lanes[G.lane].clear >= hEff();
      (marker.material as THREE.MeshBasicMaterial).color.set(fits ? '#5fd68a' : '#e0463a');
      for (let i = 0; i < 3; i++) {
        const L = nb.lanes[i], c = el.chips[i];
        c.className = 'c3-chip ' + L.verdict + (i === G.lane ? ' cur' : '');
        (c.children[0] as HTMLElement).textContent = L.clear.toFixed(2);
        (c.children[1] as HTMLElement).textContent = L.verdict === 'fit' ? 'Fits' : L.verdict === 'steady' ? 'Steady only' : 'No';
      }
    } else {
      marker.visible = false;
      for (const c of el.chips) { c.className = 'c3-chip off'; (c.children[0] as HTMLElement).textContent = '–'; (c.children[1] as HTMLElement).textContent = ''; }
    }
    sun.target.position.set(G.laneX, 0, -18);
    sun.position.copy(skyU.uSunDir.value).multiplyScalar(90).add(sun.target.position);
  }
  function updateHud() {
    el.km.textContent = G.score.toFixed(2);
    el.sp.textContent = String(Math.round(G.speed * 3.6));
    el.mode.textContent = G.brake ? 'Braking' : G.hammer ? 'Hammer down' : 'Full ahead';
    el.mode.className = 'mode' + (G.brake ? ' brake' : G.hammer ? ' hammer' : '');
    el.h.textContent = hEff().toFixed(2) + ' m' + (lift() > 0.02 ? ' · swaying' : '');
    el.cl.textContent = String(G.cleared);
    el.mult.innerHTML = G.mult > 1 ? `<span>Multiplier</span><span>×${G.mult}</span>` : '';
    el.wpn.textContent = `${wpName()} · ${Math.max(0, (G.wpW - G.dist) / 1000).toFixed(2)} km`;
    el.wpt.textContent = fmtClock(G.wpClock);
    el.wpt.classList.toggle('late', G.wpClock < 0);
    const dsp = DISPATCH[G.dispIdx % DISPATCH.length];
    el.dt.textContent = dsp.text; el.dp.textContent = `${G.dispProg} / ${dsp.goal} · +0.25 km`;
    el.view.textContent = camMode === 'chase' ? 'Chase' : 'Dolly';
  }
  let last = performance.now(), raf = 0, alive = true, todAcc = 0;
  function frame(now: number) {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    const dtReal = Math.min(0.05, (now - last) / 1000);
    last = now; G.time += dtReal;
    if (G.phase === 'run') simulate(dtReal); else if (G.phase === 'crash') simulateCrash(dtReal);
    todAcc += dtReal;
    if (todAcc > 0.25 && G.phase !== 'title') { todAcc = 0; applyTimeOfDay(G.tod); }
    placeWorld(dtReal);
    updateCamera(dtReal);
    if (G.phase !== 'title') updateHud();
    renderer.render(scene, camera);
  }
  function resize() {
    const w = root.clientWidth || innerWidth, h = root.clientHeight || innerHeight;
    portrait = h > w;
    camera.aspect = w / h; camera.fov = portrait ? 62 : 52; camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(root);

  // ─── input ───
  function action(a: string) {
    switch (a) {
      case 'left': if (G.phase === 'run') G.lane = clamp(G.lane - 1, 0, 2); break;
      case 'right': if (G.phase === 'run') G.lane = clamp(G.lane + 1, 0, 2); break;
      case 'brake': case 'hold': G.brake = G.phase === 'run'; break;
      case 'release': G.brake = false; break;
      case 'hammer': case 'throttle': if (G.phase === 'run') { G.hammer = !G.hammer; banner(G.hammer ? 'Hammer down' : 'Easing off', G.hammer ? '×2 score · less time to read' : '', G.hammer, 900); } break;
      case 'camera': camMode = camMode === 'chase' ? 'dolly' : 'chase'; break;
      case 'start': if (G.phase === 'title' || G.phase === 'fail') beginRun(); break;
      case 'restart': if (G.phase === 'fail' || G.phase === 'run') beginRun(); break;
    }
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    switch (e.code) {
      case 'ArrowLeft': case 'KeyA': action('left'); e.preventDefault(); break;
      case 'ArrowRight': case 'KeyD': action('right'); e.preventDefault(); break;
      case 'Space': case 'ArrowDown': if (G.phase === 'run') action('brake'); else action('start'); e.preventDefault(); break;
      case 'KeyS': case 'ArrowUp': action('hammer'); break;
      case 'KeyC': action('camera'); break;
      case 'KeyR': action('restart'); break;
      case 'Enter': action('start'); break;
    }
  };
  const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space' || e.code === 'ArrowDown') action('release'); };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  let pid: number | null = null, px0 = 0, py0 = 0, swiped = false;
  const cvs = renderer.domElement;
  const onDown = (e: PointerEvent) => {
    if (pid !== null) return;
    pid = e.pointerId; px0 = e.clientX; py0 = e.clientY; swiped = false;
    cvs.setPointerCapture?.(e.pointerId);
    if (G.phase === 'run') action('brake');
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== pid || swiped) return;
    const dx = e.clientX - px0, dy = e.clientY - py0, th = 28;
    if (Math.abs(dx) > th && Math.abs(dx) > Math.abs(dy)) { swiped = true; action('release'); action(dx < 0 ? 'left' : 'right'); }
    else if (dy > th * 1.6 && Math.abs(dy) > Math.abs(dx)) { swiped = true; action('release'); action('hammer'); }
  };
  const onUp = (e: PointerEvent) => { if (e.pointerId !== pid) return; pid = null; action('release'); };
  cvs.addEventListener('pointerdown', onDown); cvs.addEventListener('pointermove', onMove);
  cvs.addEventListener('pointerup', onUp); cvs.addEventListener('pointercancel', onUp);
  const btn = (b: HTMLElement, a: string) => b.addEventListener('pointerdown', (e) => { e.stopPropagation(); action(a); });
  btn(el.left, 'left'); btn(el.right, 'right'); btn(el.view, 'camera');
  el.title.addEventListener('pointerup', () => action('start'));
  el.restart.addEventListener('pointerup', (e) => { e.stopPropagation(); action('restart'); });
  el.card.addEventListener('pointerdown', (e) => e.stopPropagation());

  // ─── hooks ───
  const snapshot = (): GameSnapshot => ({
    phase: G.phase, dist: G.dist, speed: G.speed, hammer: G.hammer, brake: G.brake, mult: G.mult, score: G.score,
    lane: G.lane, laneX: G.laneX, loadH: G.loadH, sway: G.sway, lift: lift(), hEff: hEff(), cleared: G.cleared, shaveChain: G.shaveChain,
    crashKind: G.crashKind, tod: G.tod,
    waypoint: G.phase === 'run' ? { name: wpName(), remaining: G.wpW - G.dist, clock: G.wpClock } : null,
    dispatch: { text: DISPATCH[G.dispIdx % DISPATCH.length].text, progress: G.dispProg, goal: DISPATCH[G.dispIdx % DISPATCH.length].goal },
    bridges: bridges.filter((b) => b.active && !b.cleared).sort((a, b) => a.w - b.w)
      .map((b) => ({ w: b.w, depth: b.depth, kind: b.kind, name: b.name, clears: b.lanes.map((L) => L.clear), verdicts: b.lanes.map((L) => L.verdict) })),
  });
  window.__game = snapshot;
  window.__gameWarp = (m: number) => { G.dist += m; G.tod = clamp(G.dist / (NIGHT_KM * 1000), 0, 1); resetBridges(); setWaypoint(G.wpIdx); applyTimeOfDay(G.tod); };
  window.__gameInput = action;
  // deterministic stepping for headless bots (rendering is not needed to advance the sim)
  window.__gameStep = (seconds: number) => { const n = Math.max(1, Math.round(seconds * 60)); for (let i = 0; i < n && G.phase === 'run'; i++) simulate(1 / 60); };

  // ─── go ───
  el.best.textContent = G.best > 0 ? `Best haul ${G.best.toFixed(2)} km` : '';
  resetRun();
  placeWorld(0);
  raf = requestAnimationFrame(frame);

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    ro.disconnect();
    window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp);
    delete window.__game; delete window.__gameWarp; delete window.__gameInput; delete window.__gameStep;
    pmrem.dispose(); envTex?.dispose(); renderer.dispose();
    root.innerHTML = ''; root.classList.remove('c3-root');
  };
}
