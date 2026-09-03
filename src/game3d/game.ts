/*
 * CLEARANCE 3D — self-contained game module (rebuild #2: high-fidelity pass).
 * startGame(root) builds renderer + HUD inside `root` and returns a cleanup function.
 * No model/texture assets: every material is canvas-generated, every mesh procedural.
 * See PLAN.md for state shape, world scroll and collision spans.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

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
const DUCK_MAX = 0.3; // hydraulics drop (m) — "a little bit"
const DUCK_SPEED = DUCK_MAX / 0.2;
const SPRING_K = 8;
const SPRING_C = 5;
const AIR_DRAIN = 1 / 4.2;
const AIR_REFILL = 1 / 5.0;
const AIR_RELOCK = 0.2;
const UPGRADE_FIRST = 400;
const UPGRADE_EVERY = 1600;
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
const SWAY_C_LOW = 4.5; // lowered load = low centre of gravity = steady
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
  { id: 'nobrake', text: 'Clear 4 bridges without ducking', goal: 4 },
  { id: 'shave3', text: '3 close shaves in a row', goal: 3 },
  { id: 'hammer2', text: 'Hammer down under 2 bridges', goal: 2 },
  { id: 'clear8', text: 'Clear 8 bridges', goal: 8 },
];

// ───────────────────────────── terrain (vertical curves) ─────────────────────────────
// Gentle prairie crests: enough to hide a plate behind a rise, never a real hill.
const hAt = (w: number) => 4.0 * Math.sin(w / 300) + 2.2 * Math.sin(w / 113 + 2.1) + 0.5 * Math.sin(w / 41);
const slopeAt = (w: number) => (4.0 / 300) * Math.cos(w / 300) + (2.2 / 113) * Math.cos(w / 113 + 2.1) + (0.5 / 41) * Math.cos(w / 41);

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
const PLATE_FONT = "'Oswald', var(--font-hud), 'Arial Narrow', Impact, sans-serif";
const HUD_FONT = "'Oswald', var(--font-hud), 'Arial Narrow', Impact, sans-serif";
const BIG_FONT = "'Anton', var(--font-big), 'Oswald', Impact, 'Arial Narrow', sans-serif";

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
type Verdict = 'fit' | 'duck' | 'no';
interface Lane { clear: number; deck: THREE.Group; plate: THREE.Mesh; lamp: THREE.Mesh; board: THREE.Mesh; verdict: Verdict }
interface Bridge {
  id: number; w: number; depth: number; kind: 'girder' | 'steel' | 'rail'; name: string; lanes: Lane[];
  group: THREE.Group; piers: THREE.Mesh[]; abut: THREE.Mesh[]; cleared: boolean; minMargin: number; active: boolean;
  faceHidden: boolean; duckedUnder: boolean; hammeredUnder: boolean;
}
interface Chunk { m: THREE.Mesh; v: THREE.Vector3; av: THREE.Vector3 }
interface Inst { w: number; x: number; s: number; rot: number; span: number }
type Phase = 'title' | 'run' | 'crash' | 'fail';

export interface GameSnapshot {
  phase: Phase; dist: number; speed: number; hammer: boolean; hold: boolean; lowered: number; air: number; airLocked: boolean; mult: number; score: number;
  lane: number; laneX: number; loadH: number; loadName: string; sway: number; lift: number; hEff: number; cleared: number; shaveChain: number;
  crashKind: string | null; tod: number; waypoint: { name: string; remaining: number; clock: number } | null;
  dispatch: { text: string; progress: number; goal: number } | null;
  bridges: { w: number; depth: number; kind: string; name: string; clears: number[]; verdicts: Verdict[] }[];
  traffic: { w: number; len: number; lane: number; v: number }[];
}
declare global {
  interface Window { __game?: () => GameSnapshot; __gameWarp?: (metres: number) => void; __gameInput?: (action: string) => void; __gameStep?: (seconds: number) => void; __gameCam?: (pos: number[] | null, target?: number[]) => void }
}

// ───────────────────────────── HUD ─────────────────────────────
const CSS = `
.c3-root{position:relative;width:100%;height:100%;overflow:hidden;background:#0b1020;font-family:${HUD_FONT};color:#fff;user-select:none;-webkit-user-select:none;touch-action:none;-webkit-tap-highlight-color:transparent;--y:#f2b32a;--yd:#111;--g:#1f8a48;--gd:#12602f;--o:#f2711c;--r:#d9271f;--cream:#f4ecd8;--ink:#141414}
.c3-root canvas{display:block;width:100%;height:100%}
.c3-vig{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at 50% 55%,rgba(0,0,0,0) 58%,rgba(0,0,0,.4) 100%)}
.c3-hud{position:absolute;inset:0;pointer-events:none}
.c3-hud *{box-sizing:border-box}
.c3-hud.hidden,.c3-title.hidden{display:none}
.c3-sign{border-radius:8px;border:3px solid #fff;box-shadow:0 3px 0 rgba(0,0,0,.45),0 6px 14px rgba(0,0,0,.35);text-transform:uppercase;letter-spacing:.04em;line-height:1}
.c3-green{background:linear-gradient(#22954f,#176e3a);border-color:#fff;color:#fff}
.c3-yellow{background:linear-gradient(#f7c235,#e8a91a);border-color:#111;color:#111}
.c3-white{background:linear-gradient(#fff,#e9e9e9);border-color:#111;color:#111}
.c3-orange{background:linear-gradient(#ff8a2a,#e8641a);border-color:#111;color:#111}
.c3-lbl{font-size:10px;letter-spacing:.2em;opacity:.85;font-weight:700}
.c3-big{font-family:${BIG_FONT};font-weight:400;font-variant-numeric:tabular-nums}
.c3-wp{position:absolute;top:max(12px,env(safe-area-inset-top));left:12px;right:70px;padding:6px 10px 7px;max-width:300px}
.c3-wp .n{font-size:11px;letter-spacing:.14em;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.c3-wp .row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-top:2px}
.c3-wp .km{font-size:28px}.c3-wp .km small{font-size:12px;margin-left:4px;letter-spacing:.1em}
.c3-wp .t{font-size:20px}.c3-wp .t.late{color:#ffb3a8}
.c3-wp .mult{font-size:12px;letter-spacing:.12em;color:#ffd24a;font-weight:700;min-height:12px;margin-top:2px}
.c3-snd,.c3-view{position:absolute;top:max(12px,env(safe-area-inset-top));width:46px;height:46px;border-radius:50%;background:#111;border:3px solid #fff;display:flex;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer;font-size:11px;letter-spacing:.06em;font-weight:700;box-shadow:0 3px 0 rgba(0,0,0,.45)}
.c3-snd{right:12px}.c3-view{right:12px;top:calc(max(12px,env(safe-area-inset-top)) + 54px);font-size:10px}
.c3-snd.on{background:var(--y);color:#111;border-color:#111}
.c3-next{position:absolute;top:calc(max(12px,env(safe-area-inset-top)) + 110px);left:50%;transform:translateX(-50%);display:flex;gap:8px}
.c3-chip{width:74px;padding:5px 0 6px;text-align:center;border-radius:7px;border:3px solid #111;box-shadow:0 3px 0 rgba(0,0,0,.45);background:#8a8a8a;color:#111;transition:background .12s}
.c3-chip .h{font-family:${BIG_FONT};font-size:22px;line-height:1;font-variant-numeric:tabular-nums}
.c3-chip .v{font-size:9px;letter-spacing:.16em;font-weight:700;margin-top:3px;text-transform:uppercase}
.c3-chip .bar{display:none}
.c3-chip.fit{background:linear-gradient(#2fbf62,#1f8a48);color:#fff;border-color:#fff}.c3-chip.duck{background:linear-gradient(#f7c235,#e8a91a)}.c3-chip.no{background:linear-gradient(#ff7a2a,#e04b12);color:#111}
.c3-chip.cur{transform:translateY(-3px);box-shadow:0 6px 0 rgba(0,0,0,.45)}
.c3-chip.off{opacity:.3}
.c3-bl{position:absolute;left:12px;bottom:max(14px,env(safe-area-inset-bottom));width:124px;padding:6px 10px 8px}
.c3-bl .sp{font-size:34px;line-height:1}.c3-bl .sp small{font-size:12px;letter-spacing:.1em;margin-left:4px}
.c3-bl .mode{font-size:10px;letter-spacing:.16em;font-weight:700;margin-top:3px;min-height:12px}
.c3-bl .mode.hammer{color:#c8320f}.c3-bl .mode.brake{color:#0b5fa8}
.c3-bl .disp{display:none}
.c3-br{position:absolute;right:12px;bottom:max(14px,env(safe-area-inset-bottom));width:150px;padding:6px 10px 8px;text-align:right}
.c3-br .c3-lbl{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.c3-br .sc{display:none}
.c3-br .row{display:flex;justify-content:space-between;font-size:10px;letter-spacing:.1em;font-weight:700;margin-top:3px}
.c3-br .row.load{display:block;text-align:right;font-family:${BIG_FONT};font-weight:400;font-size:26px;letter-spacing:.02em;margin-top:0}
.c3-br .row.mult{display:none}
.c3-air{position:absolute;left:50%;bottom:calc(max(14px,env(safe-area-inset-bottom)) + 4px);transform:translateX(-50%);width:clamp(76px,100vw - 320px,180px);height:22px;border:3px solid #111;border-radius:6px;background:#1c1c1c;overflow:hidden;box-shadow:0 3px 0 rgba(0,0,0,.45)}
.c3-air i{display:block;height:100%;width:100%;transform-origin:left;background:repeating-linear-gradient(135deg,#f2b32a 0 12px,#111 12px 24px)}
.c3-air.low i{background:repeating-linear-gradient(135deg,#f2711c 0 12px,#111 12px 24px)}.c3-air.lock i{background:repeating-linear-gradient(135deg,#d9271f 0 12px,#111 12px 24px)}
.c3-airlbl{position:absolute;left:50%;bottom:calc(max(14px,env(safe-area-inset-bottom)) + 30px);transform:translateX(-50%);font-size:10px;letter-spacing:.24em;font-weight:700;text-shadow:0 1px 2px #000}
.c3-dispo{position:absolute;left:12px;top:calc(max(12px,env(safe-area-inset-top)) + 88px);font-size:10px;letter-spacing:.1em;font-weight:700;text-shadow:0 1px 2px #000;white-space:nowrap;max-width:70vw;overflow:hidden;text-overflow:ellipsis;opacity:.9}
.c3-hint{position:absolute;left:50%;top:calc(max(12px,env(safe-area-inset-top)) + 206px);transform:translateX(-50%);font-size:11px;letter-spacing:.18em;font-weight:700;white-space:nowrap;text-shadow:0 1px 3px #000;transition:opacity 1s;max-width:94vw;overflow:hidden;text-overflow:ellipsis;text-transform:uppercase}
.c3-banner{position:absolute;left:50%;top:38%;transform:translate(-50%,-50%) scale(.85) rotate(-2deg);text-align:center;opacity:0;transition:opacity .15s,transform .15s;white-space:nowrap}
.c3-banner.show{opacity:1;transform:translate(-50%,-50%) scale(1) rotate(-2deg)}
.c3-banner .a{font-family:${BIG_FONT};font-size:46px;line-height:1;text-transform:uppercase;color:var(--y);-webkit-text-stroke:2px #111;text-shadow:0 4px 0 #111,0 6px 12px rgba(0,0,0,.5);letter-spacing:.02em}
.c3-banner .b{display:inline-block;margin-top:8px;background:#111;color:#fff;font-size:12px;letter-spacing:.2em;font-weight:700;padding:4px 10px;text-transform:uppercase}
.c3-banner.warn .a{color:var(--o)}
.c3-flash{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none}
.c3-btn{position:absolute;bottom:calc(max(14px,env(safe-area-inset-bottom)) + 76px);width:58px;height:58px;border:3px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:22px;pointer-events:auto;cursor:pointer;background:rgba(17,17,17,.55);opacity:.6;box-shadow:0 3px 0 rgba(0,0,0,.45)}
.c3-btn:active{background:var(--y);color:#111;opacity:1}
#c3-left{left:12px}#c3-right{right:12px}
.c3-title{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:auto;text-align:center;padding:0 18px;gap:12px}
.c3-mark{width:min(92vw,400px);transform:rotate(-2deg);filter:drop-shadow(0 8px 0 rgba(0,0,0,.4)) drop-shadow(0 14px 24px rgba(0,0,0,.4))}
.c3-mark svg{display:block}
.c3-menu{display:flex;flex-direction:column;gap:9px;width:min(80vw,300px);margin-top:6px}
.c3-menu .m{border-radius:9px;border:3px solid #fff;box-shadow:inset 0 0 0 2px #176e3a,inset 0 0 0 3px #fff,0 4px 0 rgba(0,0,0,.45),0 8px 16px rgba(0,0,0,.35);background:linear-gradient(#22954f,#176e3a);color:#fff;font-family:${BIG_FONT};font-size:26px;letter-spacing:.06em;padding:11px 12px;cursor:pointer;text-transform:uppercase;line-height:1}
.c3-menu .m small{display:block;font-family:${HUD_FONT};font-size:10px;letter-spacing:.2em;font-weight:700;opacity:.85;margin-top:3px}
.c3-menu .m:active{transform:translateY(3px);box-shadow:inset 0 0 0 2px #176e3a,inset 0 0 0 3px #fff,0 1px 0 rgba(0,0,0,.45)}
.c3-menu .m.dim{filter:saturate(.4) brightness(.8)}
.c3-title .gc{font-size:11px;letter-spacing:.2em;font-weight:700;text-shadow:0 1px 3px #000;text-transform:uppercase}
.c3-title .eb{font-size:11px;letter-spacing:.24em;font-weight:700;text-shadow:0 1px 3px #000;text-transform:uppercase;opacity:.9}
.c3-live{position:absolute;left:0;right:0;bottom:0;height:44px;background:#141414;border-top:3px solid #fff;display:flex;align-items:center;overflow:hidden;pointer-events:none}
.c3-live .tag{flex:none;background:var(--r);color:#fff;font-family:${BIG_FONT};font-size:20px;letter-spacing:.08em;padding:0 14px;height:100%;display:flex;align-items:center;border-right:3px solid #fff}
.c3-live .tk{flex:1;overflow:hidden;white-space:nowrap;font-size:14px;letter-spacing:.1em;font-weight:700;text-transform:uppercase}
.c3-live .tk span{display:inline-block;padding-left:100%;animation:c3tick 38s linear infinite}
@keyframes c3tick{to{transform:translateX(-100%)}}
.c3-card{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:flex-end;padding:0 16px max(16px,env(safe-area-inset-bottom));background:linear-gradient(rgba(0,0,0,.05),rgba(0,0,0,.55));pointer-events:auto;gap:12px}
.c3-card.show{display:flex}
.c3-over{font-family:${BIG_FONT};font-size:min(21vw,96px);line-height:.88;text-align:center;-webkit-text-stroke:3px #111;text-shadow:0 6px 0 #111,0 10px 18px rgba(0,0,0,.5);letter-spacing:.02em;margin-bottom:auto;margin-top:8vh}
.c3-over .y{color:var(--y);display:block}.c3-over .r{color:var(--r);display:block}
.c3-panel{width:min(92vw,420px);background:var(--cream);color:var(--ink);border:4px solid #111;border-radius:14px;padding:14px 16px;box-shadow:0 8px 0 rgba(0,0,0,.4),0 14px 30px rgba(0,0,0,.45);text-align:left}
.c3-panel h1{margin:0;font-family:${BIG_FONT};font-size:34px;letter-spacing:.02em;line-height:1;text-transform:uppercase;color:var(--r)}
.c3-panel h2{margin:4px 0 10px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;font-weight:700;color:#444}
.c3-panel .rows{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px 10px}
.c3-panel .rows span{display:block;font-size:9px;letter-spacing:.18em;text-transform:uppercase;font-weight:700;color:#555}
.c3-panel .rows b{display:block;font-family:${BIG_FONT};font-size:22px;font-weight:400;font-variant-numeric:tabular-nums;line-height:1.1}
.c3-strip{width:min(92vw,420px);height:16px;border:3px solid #111;border-radius:4px;background:repeating-linear-gradient(135deg,#f2b32a 0 14px,#111 14px 28px);box-shadow:0 3px 0 rgba(0,0,0,.4)}
.c3-acts{display:flex;gap:12px;width:min(92vw,420px)}
.c3-acts .a{flex:1;border-radius:10px;border:3px solid #111;font-family:${BIG_FONT};font-size:24px;letter-spacing:.06em;text-transform:uppercase;padding:14px 0;text-align:center;cursor:pointer;color:#111;box-shadow:0 5px 0 rgba(0,0,0,.45);line-height:1}
.c3-acts .a:active{transform:translateY(4px);box-shadow:0 1px 0 rgba(0,0,0,.45)}
.c3-acts .share{background:linear-gradient(#ff8a2a,#e8641a)}
.c3-acts .go{background:linear-gradient(#5ed26a,#2fa53d)}
`;
const HEADLINES = [
  'FIFTH OVERPASS STRIKE THIS YEAR — CITY ENGINEERS "NOT SURPRISED"',
  'GRAIN BIN WEDGED UNDER 51ST STREET; BIN REPORTED "FINE", BRIDGE LESS SO',
  'DRIVER TOLD POLICE THE BRIDGE "CAME OUT OF NOWHERE"',
  '$11,200 FINE FOR TRACK HOE THAT MET THE HWY 16 OVERPASS',
  'REPAIR BILLS PASS $650,000 — CLEARANCE SIGNS STILL LEGIBLE, REPORT CONFIRMS',
  'SEVENTH STRIKE IN THE PROVINCE — MAYOR REQUESTS A NAP',
  'TRUCKING GROUP URGES ENFORCEMENT; OVERPASSES URGE LOWER LOADS',
  'DRIVER ASKS IF BRIDGE "COULD MAYBE DUCK"',
  'ANOTHER DAY, ANOTHER OVERPASS',
  'CITY TO PURSUE "ALL LEGAL AVENUES" AND POSSIBLY A TALLER BRIDGE',
];
const HUD_HTML = `
<div class="c3-vig"></div>
<div class="c3-hud hidden" id="c3-hud">
  <div class="c3-sign c3-green c3-wp"><div class="n" id="c3-wpn">—</div><div class="row"><div class="km c3-big"><span id="c3-km">0.00</span><small>km</small></div><div class="t c3-big" id="c3-wpt">—</div></div><div class="mult" id="c3-mult"></div></div>
  <div class="c3-snd" id="c3-snd">OFF</div>
  <div class="c3-view" id="c3-view">CAM</div>
  <div class="c3-next" id="c3-next">
    <div class="c3-chip" id="c3-chip0"><div class="h">–</div><div class="v"></div><div class="bar"></div></div>
    <div class="c3-chip" id="c3-chip1"><div class="h">–</div><div class="v"></div><div class="bar"></div></div>
    <div class="c3-chip" id="c3-chip2"><div class="h">–</div><div class="v"></div><div class="bar"></div></div>
  </div>
  <div class="c3-sign c3-white c3-bl"><div class="c3-lbl">Speed</div><div class="sp c3-big"><span id="c3-sp">0</span><small>km/h</small></div><div class="mode" id="c3-mode">Full ahead</div><div class="disp" id="c3-disp"></div></div>
  <div class="c3-sign c3-yellow c3-br"><div class="c3-lbl" id="c3-hl">Load</div><div class="row load" id="c3-h">4.75 m</div><div class="row"><span>Cleared</span><span id="c3-cl">0</span></div></div>
  <div class="c3-dispo" id="c3-dispo"></div>
  <div class="c3-airlbl">AIR</div><div class="c3-air" id="c3-air"><i id="c3-airbar"></i></div>
  <div class="c3-btn" id="c3-left">◀</div><div class="c3-btn" id="c3-right">▶</div>
  <div class="c3-hint" id="c3-hint">Swipe ◀ ▶ lane · hold to lower the load · swipe ▼ hammer down</div>
  <div class="c3-banner" id="c3-banner"><div class="a"></div><div class="b"></div></div>
</div>
<div class="c3-flash" id="c3-flash"></div>
<div class="c3-title" id="c3-title">
  <div class="eb">Saskatoon · Circle Drive approach · 2026</div>
  <div class="c3-mark"><svg viewBox="0 0 1000 420" width="100%" role="img" aria-label="BRIDGE STRIKE! Oversize load">
    <rect x="6" y="6" width="988" height="408" rx="34" fill="#f2b32a" stroke="#141414" stroke-width="12"/>
    <rect x="30" y="30" width="940" height="360" rx="20" fill="none" stroke="#141414" stroke-width="7"/>
    <g font-family="Anton, 'Arial Narrow', Impact, sans-serif" font-size="230" fill="#141414" font-weight="400">
      <text x="62" y="278" textLength="522" lengthAdjust="spacingAndGlyphs">BRIDGE ST</text>
      <text x="676" y="278" textLength="262" lengthAdjust="spacingAndGlyphs">IKE!</text>
    </g>
    <rect x="600" y="86" width="64" height="192" rx="10" fill="#141414"/>
    <g fill="#f4ecd8"><path d="M632 100 l22 34 h-13 v96 h13 l-22 34 l-22 -34 h13 v-96 h-13 z"/></g>
    <rect x="360" y="312" width="280" height="56" fill="#141414"/>
    <text x="500" y="353" text-anchor="middle" textLength="244" lengthAdjust="spacingAndGlyphs" font-family="Oswald, 'Arial Narrow', sans-serif" font-weight="700" font-size="38" fill="#f2b32a">OVERSIZE LOAD</text>
  </svg></div>
  <div class="c3-menu">
    <div class="m" id="c3-start">Haul<small>Endless run · three excavators, a grain bin, farm equipment</small></div>
    <div class="m" id="c3-how">How to drive<small>Swipe lanes · hold to lower · swipe down to hammer</small></div>
    <div class="m dim" id="c3-daily">Daily route<small>Coming soon</small></div>
  </div>
  <div class="gc" id="c3-best"></div>
  <div class="c3-live"><div class="tag">LIVE</div><div class="tk"><span id="c3-ticker"></span></div></div>
</div>
<div class="c3-card" id="c3-card">
  <div class="c3-over"><span class="y">GAME</span><span class="r">OVER</span></div>
  <div class="c3-panel">
    <h1 id="c3-kind">Bridge strike</h1><h2 id="c3-bname">—</h2>
    <div class="rows">
      <div><span>Hauled</span><b id="c3-fkm">0.00 km</b></div><div><span>Top multiplier</span><b id="c3-fmult">×1</b></div><div><span>Cleared</span><b id="c3-fcl">0</b></div>
      <div><span>City repair bill</span><b id="c3-frep">$0</b></div><div><span>Your fine</span><b id="c3-ffine">$0</b></div><div><span>Best</span><b id="c3-fbest">0.00 km</b></div>
    </div>
  </div>
  <div class="c3-strip"></div>
  <div class="c3-acts"><div class="a share" id="c3-share">Share</div><div class="a go" id="c3-restart">Haul again</div></div>
</div>`;

// ───────────────────────────── the game ─────────────────────────────
export function startGame(root: HTMLElement, opts: { seed?: number; modelUrl?: string; sound?: boolean } = {}): () => void {
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
    disp: $('c3-disp'), snd: $('c3-snd'), sp: $('c3-sp'), air: $('c3-air'), airbar: $('c3-airbar'), mode: $('c3-mode'), km: $('c3-km'), h: $('c3-h'), cl: $('c3-cl'), mult: $('c3-mult'),
    left: $('c3-left'), right: $('c3-right'), hint: $('c3-hint'), banner: $('c3-banner'), flash: $('c3-flash'),
    title: $('c3-title'), best: $('c3-best'), card: $('c3-card'), kind: $('c3-kind'), bname: $('c3-bname'), fkm: $('c3-fkm'),
    fmult: $('c3-fmult'), fcl: $('c3-fcl'), fbest: $('c3-fbest'), frep: $('c3-frep'), ffine: $('c3-ffine'), restart: $('c3-restart'),
    share: $('c3-share'), start: $('c3-start'), how: $('c3-how'), ticker: $('c3-ticker'), dispo: $('c3-dispo'), hl: $('c3-hl'),
  };

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(52, 1, 1.0, 1600);
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
    grass: new THREE.MeshStandardMaterial({ map: grass.map, roughness: 1, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }),
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
  grass.map.repeat.set(60, 26);
  // every ground strip is a plane with rows along the road; rows are re-heighted each frame from hAt()
  const strips: THREE.Mesh[] = [];
  const strip = (w: number, len: number, rows: number, m: THREE.Material, x: number, y: number, zc: number) => {
    const g = new THREE.PlaneGeometry(w, len, 1, rows);
    const mesh = new THREE.Mesh(g, m);
    mesh.rotation.x = -Math.PI / 2; mesh.position.set(x, y, zc); mesh.receiveShadow = true;
    scene.add(mesh); strips.push(mesh); return mesh;
  };
  const ground = strip(2600, 1150, 115, mat.grass, 0, -0.35, -1150 / 2 + 120);
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
    const m = new THREE.Mesh(new THREE.PlaneGeometry(340, 200, 1, 20), new THREE.MeshStandardMaterial({ map: t, roughness: 1, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }));
    m.rotation.x = -Math.PI / 2; m.position.y = -0.3; m.receiveShadow = true;
    scene.add(m); strips.push(m);
    fields.push({ m, w: i * 200, x: side * (170 + 34), span: 10 * 200 });
  }
  asphalt.map.repeat.set(1, 30); asphalt.rough.repeat.set(1, 30);
  const ROAD_LEN = 760;
  const ROAD2_X = -ROAD_HALF * 2 - 14;
  strip(ROAD_HALF * 2, ROAD_LEN, 190, mat.asphalt, 0, 0.0, -ROAD_LEN / 2 + 60);
  strip(ROAD_HALF * 2 + 5, ROAD_LEN, 190, mat.gravel, 0, -0.12, -ROAD_LEN / 2 + 60);
  // oncoming carriageway across a grass median (divided highway like the photo)
  const road2 = strip(ROAD_HALF * 2, ROAD_LEN, 190, mat.asphalt, ROAD2_X, 0.0, -ROAD_LEN / 2 + 60);
  road2.rotation.z = Math.PI;
  strip(ROAD_HALF * 2 + 5, ROAD_LEN, 190, mat.gravel, ROAD2_X, -0.12, -ROAD_LEN / 2 + 60);
  function deformStrips(d: number, h0: number) {
    for (const m of strips) {
      const pos = m.geometry.attributes.position as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      // local +y of the plane maps to world ±z depending on the mesh rotation; take the sign from the quaternion
      tmpV.set(0, 1, 0).applyQuaternion(m.quaternion);
      const flip = tmpV.z < 0 ? 1 : -1;
      for (let i = 0; i < pos.count; i++) {
        const yl = arr[i * 3 + 1] * flip;
        arr[i * 3 + 2] = hAt(d - m.position.z + yl) - h0;
      }
      pos.needsUpdate = true;
    }
  }

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
  scatterGroups.push({ ...instanced(cardGeo, leafMat, 260, () => ({ w: rngFx() * 1000, x: (rngFx() < 0.5 ? -1 : 1) * (11 + rngFx() * 50), s: 1.4 + rngFx() * 2.2, rot: rngFx() * 3, span: 1000 })), y: 0 });
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
  const cabProc = new THREE.Group(); // procedural stand-in until the Peterbilt loads
  cab.add(cabProc);
  box(1.0, 0.4, 7.6, mat.frame, 0, 0.95, -2.6, cabProc); // frame rails
  for (const z of [0.0, 1.3]) for (const x of [-1.05, 1.05]) addWheel(x, z, true, cabProc); // tandem drive
  for (const x of [-1.05, 1.05]) addWheel(x, -5.2, false, cabProc); // steer axle
  // sleeper + cab
  const sleeper = box(2.5, 2.1, 2.0, mat.paint, 0, 2.2, -1.2, cabProc);
  const cabBox = box(2.45, 1.75, 1.7, mat.paint, 0, 2.15, -3.0, cabProc);
  box(2.4, 0.5, 2.2, mat.paint, 0, 3.5, -1.15, cabProc); // roof fairing base
  const fairing = box(2.3, 0.9, 1.6, mat.paint, 0, 3.75, -0.9, cabProc);
  fairing.rotation.x = 0.25;
  const wind = box(2.3, 0.8, 0.06, mat.glass, 0, 2.5, -3.88, cabProc, false);
  box(0.06, 0.6, 0.8, mat.glass, -1.24, 2.5, -3.1, cabProc, false); box(0.06, 0.6, 0.8, mat.glass, 1.24, 2.5, -3.1, cabProc, false); // door glass
  box(0.06, 0.5, 0.6, mat.glass, -1.26, 2.6, -1.3, cabProc, false); box(0.06, 0.5, 0.6, mat.glass, 1.26, 2.6, -1.3, cabProc, false); // sleeper windows
  void sleeper; void cabBox; void wind;
  // long hood
  const hood = box(2.1, 1.25, 2.7, mat.paint, 0, 1.85, -5.2, cabProc);
  void hood;
  box(2.15, 1.3, 0.12, mat.chrome, 0, 1.75, -6.55, cabProc); // grille surround
  box(1.6, 1.0, 0.02, new THREE.MeshStandardMaterial({ color: '#0d0f12', roughness: 0.4, metalness: 0.8 }), 0, 1.75, -6.62, cabProc, false);
  box(2.5, 0.35, 0.3, mat.chrome, 0, 0.95, -6.7, cabProc); // bumper
  const headL = cyl(0.17, 0.06, mat.lampFace, -0.85, 1.35, -6.6, 'z', cabProc, 12);
  const headR = cyl(0.17, 0.06, mat.lampFace, 0.85, 1.35, -6.6, 'z', cabProc, 12);
  // fenders over steer wheels: half cylinders
  for (const x of [-1.05, 1.05]) {
    const f = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.5, 14, 1, false, 0, Math.PI), mat.paint);
    f.rotation.z = Math.PI / 2; f.rotation.y = Math.PI / 2; f.position.set(x, 0.62, -5.2); f.castShadow = true; cabProc.add(f);
  }
  // stacks, tanks, mirrors, steps
  for (const x of [-1.35, 1.35]) {
    cyl(0.1, 3.4, mat.chrome, x, 2.6, -1.9, 'y', cabProc, 10);
    cyl(0.16, 0.9, mat.chrome, x, 1.3, -1.9, 'y', cabProc, 10);
    cyl(0.33, 1.5, mat.chrome, x * 0.95, 0.95, -3.3, 'z', cabProc, 14); // fuel tank
    box(0.6, 0.06, 0.6, mat.chrome, x, 0.55, -3.3, cabProc); // step
    box(0.05, 0.05, 1.0, mat.frame, x * 1.02, 2.9, -3.6, cabProc); // mirror arm
    box(0.04, 0.55, 0.22, mat.chrome, x * 1.1, 2.75, -4.1, cabProc);
  }
  // cab roof marker lights + bug deflector chrome
  const roofMarkers: THREE.Mesh[] = [];
  for (const x of [-0.8, -0.4, 0, 0.4, 0.8]) roofMarkers.push(box(0.1, 0.07, 0.07, mat.amber, x, 4.22, -1.1, cabProc, false));
  const hoodLamps = [box(0.1, 0.07, 0.07, mat.amber, -1.0, 2.5, -6.5, cabProc, false), box(0.1, 0.07, 0.07, mat.amber, 1.0, 2.5, -6.5, cabProc, false)];
  // headlight spots (night)
  const spots: THREE.SpotLight[] = [];
  for (const x of [-0.85, 0.85]) {
    const s = new THREE.SpotLight('#ffe9c4', 0, 90, 0.42, 0.55, 1.2);
    s.position.set(x, 1.35, -6.6);
    s.target.position.set(x * 2, 0.2, -60);
    cab.add(s, s.target);
    spots.push(s);
  }
  // ─── the Peterbilt (GLB, meshopt-compressed; recoloured by mesh group) ───
  const modelWheels: THREE.Mesh[] = [];
  let modelLoaded = false;
  const paintMat = mat.paint;
  const modelMats: Record<string, THREE.Material> = {
    '000000||': paintMat, '151616||': paintMat, 'c6c6c6||#paint': paintMat, 'ffffff||': paintMat,
    'c6c6c6||#chrome': mat.chrome, 'cccccc||': mat.chrome, 'c0c0c0||': mat.chrome,
    '1e1e1e||': mat.frame, '232323||': mat.frame, '2d2d2d||': new THREE.MeshStandardMaterial({ color: '#0f1113', roughness: 0.45, metalness: 0.7 }),
    '212121||a': mat.glass, '808080||a': mat.glass, 'ffffff|__Translucent_Glass_Gold_1.jpg|a': mat.glass,
    'ff7f00||': mat.amber,
  };
  const wheelMat = new THREE.MeshStandardMaterial({ color: '#1a1b1d', roughness: 0.95 });
  function loadModel(url: string) {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.load(url, (gltf) => {
      const m = gltf.scene;
      m.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const name = o.name;
        let mm: THREE.Material | undefined = modelMats[name];
        if (name.includes('#wheel')) { mm = wheelMat; modelWheels.push(o); }
        if (!mm) mm = name.endsWith('a') ? mat.glass : mat.chrome;
        mm = mm.clone(); mm.side = THREE.DoubleSide; (mm as THREE.MeshStandardMaterial).flatShading = true;
        o.material = mm; o.castShadow = true; o.receiveShadow = true;
      });
      // model: +z forward, x 0..4.1, tires touch y=-0.4; game: -z forward, fifth wheel at the cab group origin
      m.rotation.y = Math.PI;
      m.position.set(2.06, 0.4, 1.7);
      cab.add(m);
      cabProc.visible = false;
      for (const sp of spots) { sp.position.set(sp.position.x, 1.25, -9.4); }
      modelLoaded = true;
    }, undefined, (err) => console.warn('truck model failed to load, keeping the stand-in', err));
  }

  // ─── the load: galvanized steel truss (a bridge girder, of course) ───
  const loadG = new THREE.Group();
  truck.add(loadG);
  // Loads are the loads that actually hit Saskatoon overpasses in 2026: excavators, a grain bin, farm equipment.
  interface LoadDef { name: string; h: number; z0: number; z1: number; build: () => THREE.Group }
  const catYellow = new THREE.MeshStandardMaterial({ color: '#e8a21a', roughness: 0.55, metalness: 0.2 });
  const catDark = new THREE.MeshStandardMaterial({ color: '#2a2a2a', roughness: 0.9 });
    const agGreen = new THREE.MeshStandardMaterial({ color: '#2f7a2a', roughness: 0.5, metalness: 0.2 });
  const corrug = new THREE.MeshStandardMaterial({ color: '#c9ccd0', roughness: 0.35, metalness: 0.85, envMapIntensity: 1.2 });
  function excavatorGroup(top: number, z0: number, z1: number, boomDown: number): THREE.Group {
    const g = new THREE.Group(); const y0 = BED_H; const zc = -(z0 + z1) / 2 + 1.0;
    box(2.7, 0.6, 4.6, catDark, 0, y0 + 0.3, zc, g); // tracks
    box(2.3, 1.2, 3.4, catYellow, 0, y0 + 1.2, zc, g); // house
    box(1.3, 1.1, 1.5, catYellow, 0.55, y0 + 2.35, zc + 0.8, g); // cab
    box(1.0, 0.7, 0.08, mat.glass, 0.55, y0 + 2.45, zc + 1.55, g, false);
    box(0.9, 0.5, 1.2, catDark, -0.5, y0 + 2.0, zc + 1.3, g); // counterweight-ish engine hood
    // boom rises forward from a pivot on the house; its knuckle is the load's true top
    const px = -0.5, py = y0 + 1.7, pz = zc - 0.6, L = 4.6;
    const th = Math.asin(clamp((top - 0.25 - py) / L, 0.15, 0.95));
    const boom = box(0.6, 0.55, L, catYellow, px, py + (L / 2) * Math.sin(th), pz - (L / 2) * Math.cos(th), g); boom.rotation.x = th;
    const tipY = py + L * Math.sin(th), tipZ = pz - L * Math.cos(th);
    const Ls = 3.2, ph = 1.05 + boomDown * 0.4; // stick folds down and forward
    const stick = box(0.45, 0.45, Ls, catYellow, px, tipY - (Ls / 2) * Math.sin(ph), tipZ - (Ls / 2) * Math.cos(ph), g); stick.rotation.x = -ph;
    const bY = tipY - Ls * Math.sin(ph), bZ = tipZ - Ls * Math.cos(ph);
    box(1.3, 0.8, 0.9, catDark, px, Math.max(y0 + 0.5, bY), bZ - 0.3, g); // bucket
    box(0.5, 0.2, 0.7, mat.red, px, top - 0.1, tipZ, g, false); // knuckle marker at the posted height
    cyl(0.12, 2.2, mat.chrome, px + 0.45, py + 1.2, pz - 1.4, 'z', g, 8); // hydraulic ram
    return g;
  }
  function grainBinGroup(top: number, z0: number, z1: number): THREE.Group {
    const g = new THREE.Group(); const zc = -(z0 + z1) / 2; const r = 1.4; const wallH = (top - BED_H) * 0.72;
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(r, r, wallH, 28), corrug); wall.position.set(0, BED_H + wallH / 2, zc); wall.castShadow = true; g.add(wall);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(r + 0.05, top - BED_H - wallH, 28), corrug); roof.position.set(0, BED_H + wallH + (top - BED_H - wallH) / 2, zc); roof.castShadow = true; g.add(roof);
    for (let i = 0; i < 5; i++) { const ring = new THREE.Mesh(new THREE.TorusGeometry(r + 0.02, 0.03, 6, 28), mat.galv); ring.rotation.x = Math.PI / 2; ring.position.set(0, BED_H + 0.3 + i * (wallH / 5), zc); g.add(ring); }
    box(2.6, 0.2, 3.2, mat.frame, 0, BED_H + 0.1, zc, g); // cradle
    return g;
  }
  function airSeederGroup(top: number, z0: number, z1: number): THREE.Group {
    const g = new THREE.Group(); const zc = -(z0 + z1) / 2;
    box(2.6, 0.35, 9.8, mat.frame, 0, BED_H + 0.45, zc, g); // main toolbar
    // folded wings: two tall open frames of green tubes with shank rows
    for (const x of [-1.2, 1.2]) {
      for (const z of [zc - 4.6, zc - 1.5, zc + 1.5, zc + 4.6]) box(0.14, top - BED_H - 0.7, 0.14, agGreen, x, BED_H + 0.3 + (top - BED_H - 0.7) / 2, z, g);
      for (const yy of [BED_H + 1.4, BED_H + 2.5, top - 0.5]) box(0.12, 0.12, 9.4, agGreen, x, yy, zc, g, false);
      for (let i = 0; i < 14; i++) box(0.06, 0.9, 0.05, mat.galv, x + (x < 0 ? 0.25 : -0.25), BED_H + 1.9 + (i % 2) * 0.9, zc - 4.4 + i * 0.68, g, false);
    }
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 3.2, 20), agGreen); tank.rotation.z = Math.PI / 2; tank.position.set(0, top - 1.05, zc + 1.9); tank.castShadow = true; g.add(tank);
    const tank2 = tank.clone(); tank2.position.z = zc - 2.0; g.add(tank2);
    box(0.5, 0.4, 0.5, mat.galv, 0, top - 0.2, zc + 1.9, g, false); // fill lid = true top
    return g;
  }
  // Chronological: every load here actually hit a Saskatoon-area overpass in 2026. Nothing invented.
  const LOADS: LoadDef[] = [
    { name: 'Caterpillar track hoe', h: 4.75, z0: 1.5, z1: 10.5, build: () => excavatorGroup(4.75, 1.5, 10.5, 0.42) }, // Mar 5 · Circle Dr / Hwy 11 (posted 4.7 m)
    { name: 'Excavator, over-height', h: 4.9, z0: 1.5, z1: 10.5, build: () => excavatorGroup(4.9, 1.5, 10.5, 0.55) }, // Mar 11 · 108th Street
    { name: 'Heavy equipment', h: 5.05, z0: 1.5, z1: 10.5, build: () => excavatorGroup(5.05, 1.5, 10.5, 0.7) }, // Mar 22 · CPKC + McKercher
    { name: 'Grain bin', h: 5.2, z0: 4.5, z1: 9.5, build: () => grainBinGroup(5.2, 4.5, 9.5) }, // Jul 24 · 51st Street
    { name: 'Farm equipment', h: 5.35, z0: 1.0, z1: 13.0, build: () => airSeederGroup(5.35, 1.0, 13.0) }, // Sep 2 · Borden Bridge rail bridge
  ];
  let loadMesh: THREE.Group | null = null;
  const loadMarkers: THREE.Mesh[] = [];
  function setLoad(i: number) {
    G.loadIdx = i; G.loadH = LOADS[i].h; G.z0 = LOADS[i].z0; G.z1 = LOADS[i].z1;
    if (loadMesh) loadG.remove(loadMesh);
    loadMesh = LOADS[i].build();
    loadG.add(loadMesh);
    for (const m of loadMarkers) loadG.remove(m); loadMarkers.length = 0;
    for (const z of [-G.z0 - 0.3, -G.z1 + 0.3]) for (const x of [-LOAD_HALF_W, LOAD_HALF_W]) loadMarkers.push(box(0.1, 0.1, 0.1, mat.amber, x, BED_H + 0.2, z, loadG, false));
    el.h.textContent = LOADS[i].h.toFixed(2) + ' m'; el.hl.textContent = LOADS[i].name;
  }

  // ─── traffic: half-tons and grain trucks in our lanes, oncoming on the far carriageway ───
  interface Vehicle { g: THREE.Group; w: number; x: number; v: number; len: number; kind: 'pickup' | 'grain'; lane: number; active: boolean; lights: THREE.Mesh[]; wheels: THREE.Mesh[] }
  const VEH_COLORS = ['#e8e6df', '#b9bec4', '#7a1f1a', '#2b4a7a', '#1b1c1e', '#4d6b3a', '#c8c2b0'];
  const vehWheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 14); vehWheelGeo.rotateZ(Math.PI / 2);
  const bigWheelGeo = new THREE.CylinderGeometry(0.52, 0.52, 0.6, 14); bigWheelGeo.rotateZ(Math.PI / 2);
  const headMat = new THREE.MeshStandardMaterial({ color: '#f6f3e6', emissive: '#fff2c8', emissiveIntensity: 0 });
  const tailMat = new THREE.MeshStandardMaterial({ color: '#7a1010', emissive: '#ff2a1a', emissiveIntensity: 0 });
  function makeVehicle(kind: 'pickup' | 'grain', col: string): Vehicle {
    const g = new THREE.Group();
    const paint = new THREE.MeshPhysicalMaterial({ color: col, roughness: 0.4, metalness: 0.3, clearcoat: 0.5 });
    const lights: THREE.Mesh[] = []; const wheelsV: THREE.Mesh[] = [];
    const B = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, shadow = true) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); b.castShadow = shadow; g.add(b); return b;
    };
    if (kind === 'pickup') {
      B(1.95, 0.55, 5.4, paint, 0, 0.78, 0);
      B(1.85, 0.62, 1.7, paint, 0, 1.36, 0.3);
      B(1.75, 0.5, 1.3, mat.glass, 0, 1.4, 0.3, false);
      B(1.9, 0.45, 2.3, paint, 0, 0.98, -1.5);
      lights.push(B(0.35, 0.12, 0.05, headMat, -0.7, 0.85, 2.72, false), B(0.35, 0.12, 0.05, headMat, 0.7, 0.85, 2.72, false));
      lights.push(B(0.3, 0.14, 0.05, tailMat, -0.8, 0.9, -2.72, false), B(0.3, 0.14, 0.05, tailMat, 0.8, 0.9, -2.72, false));
      for (const z of [1.7, -1.7]) for (const x of [-0.85, 0.85]) { const w = new THREE.Mesh(vehWheelGeo, mat.rubber); w.position.set(x, 0.42, z); g.add(w); wheelsV.push(w); }
    } else {
      B(2.4, 1.1, 2.3, paint, 0, 1.6, 2.6);
      B(2.3, 0.7, 0.06, mat.glass, 0, 1.85, 3.78, false);
      B(2.2, 0.9, 1.4, paint, 0, 1.0, 4.1);
      B(2.5, 2.3, 6.2, paint, 0, 2.05, -1.5);
      B(2.55, 0.25, 6.3, mat.hazard, 0, 0.75, -1.5, false);
      B(1.2, 0.5, 8.5, mat.frame, 0, 0.55, 0.5);
      lights.push(B(0.32, 0.16, 0.05, headMat, -0.85, 1.0, 4.82, false), B(0.32, 0.16, 0.05, headMat, 0.85, 1.0, 4.82, false));
      lights.push(B(0.3, 0.18, 0.05, tailMat, -1.05, 1.1, -4.62, false), B(0.3, 0.18, 0.05, tailMat, 1.05, 1.1, -4.62, false));
      for (const z of [3.6, -1.6, -3.0]) for (const x of [-1.0, 1.0]) { const w = new THREE.Mesh(bigWheelGeo, mat.rubber); w.position.set(x, 0.52, z); g.add(w); wheelsV.push(w); }
    }
    g.visible = false;
    scene.add(g);
    return { g, w: 0, x: 0, v: 0, len: kind === 'pickup' ? 5.5 : 9.7, kind, lane: 1, active: false, lights, wheels: wheelsV };
  }
  const traffic: Vehicle[] = [];
  const oncoming: Vehicle[] = [];
  for (let i = 0; i < 6; i++) traffic.push(makeVehicle(i % 3 === 0 ? 'grain' : 'pickup', VEH_COLORS[Math.floor(rngFx() * VEH_COLORS.length)]));
  for (let i = 0; i < 6; i++) oncoming.push(makeVehicle(i % 2 === 0 ? 'grain' : 'pickup', VEH_COLORS[Math.floor(rngFx() * VEH_COLORS.length)]));
  for (const v of oncoming) v.g.rotation.y = Math.PI;
  function nearBridge(w: number, before = 70, after = 30) {
    for (const b of bridges) if (b.active && w > b.w - before && w < b.w + b.depth + after) return true;
    return false;
  }
  function spawnTraffic() {
    if (G.dist < 250) return;
    const ahead = traffic.filter((v) => v.active);
    if (ahead.length >= 4) return;
    const v = traffic.find((t) => !t.active);
    if (!v) return;
    let w = G.dist + 260 + rngWorld() * 260;
    let tries = 0;
    while (tries++ < 8 && (nearBridge(w) || ahead.some((o) => Math.abs(o.w - w) < 110))) w += 45 + rngWorld() * 60;
    if (tries >= 8) return;
    const lane = Math.floor(rngWorld() * 3);
    v.w = w; v.lane = lane; v.x = LANE_X[lane]; v.v = (0.52 + rngWorld() * 0.22); v.active = true; v.g.visible = true;
  }
  function spawnOncoming() {
    const v = oncoming.find((t) => !t.active);
    if (!v || rngFx() > 0.02) return;
    v.w = G.dist + 520 + rngFx() * 260; v.x = ROAD2_X + (rngFx() < 0.5 ? -1.9 : 1.9); v.v = 22 + rngFx() * 9; v.active = true; v.g.visible = true;
  }

  // marker bar at next bridge
  const marker = new THREE.Mesh(new THREE.BoxGeometry(LOAD_HALF_W * 2, 0.06, 0.3), new THREE.MeshBasicMaterial({ color: '#5fd68a', fog: false }));
  marker.visible = false;
  scene.add(marker);

  // ─── bridges: concrete box girder on round piers · green plate girder · rail ballast deck ───
  const lampTex: Record<Verdict, THREE.Texture> = {
    fit: plateTex('FITS', '#1f8f3f', '#fff', 256, 128, 80, '#0d4a20'),
    duck: plateTex('DUCK ▼', '#f2b32a', '#111', 256, 128, 72, '#7a5a00'),
    no: plateTex('✕', '#e2382f', '#fff', 256, 128, 96, '#6a1410'),
  };
  const lampMat: Record<Verdict, THREE.MeshBasicMaterial> = {
    fit: new THREE.MeshBasicMaterial({ map: lampTex.fit }), duck: new THREE.MeshBasicMaterial({ map: lampTex.duck }), no: new THREE.MeshBasicMaterial({ map: lampTex.no }),
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
  // square pyramid with edges axis-aligned (rotate the geometry, never the scaled mesh)
  const bermGeo = new THREE.CylinderGeometry(0.01, 1, 1, 4, 1); bermGeo.rotateY(Math.PI / 4); bermGeo.scale(0.707, 1, 0.707);
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
      const berm = new THREE.Mesh(bermGeo, mat.grass); berm.name = 'berm'; berm.receiveShadow = true; group.add(berm); abut.push(berm);
    }
    const nameSign = new THREE.Mesh(new THREE.PlaneGeometry(9, 1.1), railNameMat); nameSign.name = 'railname'; nameSign.visible = false; group.add(nameSign);
    // the deck continues over the median and the oncoming carriageway (no plates there)
    const ext = new THREE.Mesh(railTieGeo, mat.concrete); ext.name = 'ext'; ext.castShadow = true; ext.receiveShadow = true; group.add(ext);
    for (let i = 0; i < 2; i++) { const p = new THREE.Mesh(new THREE.CylinderGeometry(PIER_R, PIER_R * 1.15, 1, 18), mat.concrete); p.name = 'extpier' + i; p.castShadow = true; group.add(p); }
    return { id: 0, w: 0, depth: 10, kind: 'girder', name: '', lanes, group, piers, abut, cleared: false, minMargin: 9, active: false, faceHidden: false, duckedUnder: false, hammeredUnder: false };
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
      berm.position.set(side * (ROAD_HALF + 15), hA / 2 - 0.2, -d / 2); berm.scale.set(24, hA + 0.4, d + 40);
    }
    {
      const L0 = b.lanes[0]; const x0 = -(ROAD_HALF + 3.5), x1 = ROAD2_X - ROAD_HALF - 3.5;
      const ext = b.group.getObjectByName('ext') as THREE.Mesh;
      ext.material = isSteel ? mat.steelGreen : isRail ? mat.railDark : mat.concrete;
      ext.position.set((x0 + x1) / 2, L0.clear + thick / 2 + 0.1, -d / 2); ext.scale.set(x0 - x1, thick, d);
      for (let i = 0; i < 2; i++) { const p = b.group.getObjectByName('extpier' + i) as THREE.Mesh; const px = i === 0 ? ROAD2_X + 1.9 : ROAD2_X - 1.9; p.visible = !isRail; p.position.set(px, (L0.clear + 0.3) / 2, -d / 2); p.scale.set(1, L0.clear + 0.3, 1); }
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

  // ─── audio: synthesized diesel, jake brake, air, shave zing, crunch (muted until the speaker is tapped) ───
  const audio = {
    ctx: null as AudioContext | null, on: false, master: null as GainNode | null,
    eng: null as OscillatorNode | null, eng2: null as OscillatorNode | null, engG: null as GainNode | null, turbo: null as OscillatorNode | null, turboG: null as GainNode | null,
    noise: null as AudioBufferSourceNode | null, jakeG: null as GainNode | null, hissG: null as GainNode | null, brakeWas: false,
  };
  function audioInit() {
    if (audio.ctx) return;
    const C = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    audio.ctx = C;
    const master = C.createGain(); master.gain.value = 0; master.connect(C.destination); audio.master = master;
    const engG = C.createGain(); engG.gain.value = 0.18; engG.connect(master);
    const lp = C.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.connect(engG);
    const eng = C.createOscillator(); eng.type = 'sawtooth'; eng.frequency.value = 32; eng.connect(lp); eng.start();
    const eng2 = C.createOscillator(); eng2.type = 'square'; eng2.frequency.value = 64; const g2 = C.createGain(); g2.gain.value = 0.35; eng2.connect(g2); g2.connect(lp); eng2.start();
    const turboG = C.createGain(); turboG.gain.value = 0; turboG.connect(master);
    const turbo = C.createOscillator(); turbo.type = 'sine'; turbo.frequency.value = 900; turbo.connect(turboG); turbo.start();
    // noise bed for jake brake / air
    const buf = C.createBuffer(1, C.sampleRate * 2, C.sampleRate); const dd = buf.getChannelData(0); for (let i = 0; i < dd.length; i++) dd[i] = Math.random() * 2 - 1;
    const noise = C.createBufferSource(); noise.buffer = buf; noise.loop = true; noise.start();
    const jakeG = C.createGain(); jakeG.gain.value = 0; const jbp = C.createBiquadFilter(); jbp.type = 'bandpass'; jbp.frequency.value = 180; jbp.Q.value = 2; noise.connect(jbp); jbp.connect(jakeG); jakeG.connect(master);
    const hissG = C.createGain(); hissG.gain.value = 0; const hhp = C.createBiquadFilter(); hhp.type = 'highpass'; hhp.frequency.value = 3000; noise.connect(hhp); hhp.connect(hissG); hissG.connect(master);
    Object.assign(audio, { eng, eng2, engG, turbo, turboG, noise, jakeG, hissG });
  }
  function audioSet(on: boolean) {
    audio.on = on;
    el.snd.textContent = on ? 'ON' : 'OFF'; el.snd.classList.toggle('on', on);
    if (on) { audioInit(); audio.ctx!.resume(); audio.master!.gain.setTargetAtTime(0.6, audio.ctx!.currentTime, 0.1); }
    else if (audio.master) audio.master.gain.setTargetAtTime(0, audio.ctx!.currentTime, 0.05);
  }
  function audioTick() {
    if (!audio.on || !audio.ctx) return;
    const t = audio.ctx.currentTime;
    const running = G.phase === 'run';
    const rpm = running ? 0.35 + 0.65 * (G.speed / SPEED_CAP) : 0.25;
    audio.eng!.frequency.setTargetAtTime(24 + rpm * 46, t, 0.15);
    audio.eng2!.frequency.setTargetAtTime(48 + rpm * 92, t, 0.15);
    audio.engG!.gain.setTargetAtTime(running ? 0.16 + rpm * 0.1 : 0.08, t, 0.2);
    audio.turbo!.frequency.setTargetAtTime(600 + rpm * 1900 * (G.hammer ? 1.2 : 1), t, 0.3);
    audio.turboG!.gain.setTargetAtTime(running ? 0.012 * rpm * (G.hammer ? 2 : 1) : 0, t, 0.3);
    const ducking = running && G.hold && !G.airLocked;
    audio.jakeG!.gain.setTargetAtTime(ducking ? 0.12 : 0, t, 0.05);
    audio.hissG!.gain.setTargetAtTime(ducking ? 0.08 : 0, t, 0.05);
    if (audio.brakeWas && !G.hold) { audio.hissG!.gain.setValueAtTime(0.25, t); audio.hissG!.gain.setTargetAtTime(0, t + 0.05, 0.25); }
    audio.brakeWas = G.hold;
  }
  function sfx(kind: 'shave' | 'crash' | 'lane' | 'stamp') {
    if (!audio.on || !audio.ctx) return;
    const C = audio.ctx, t = C.currentTime;
    const g = C.createGain(); g.connect(audio.master!);
    if (kind === 'shave') {
      const o = C.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(1400, t); o.frequency.exponentialRampToValueAtTime(4200, t + 0.25);
      g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5); o.connect(g); o.start(t); o.stop(t + 0.5);
    } else if (kind === 'crash') {
      const n = C.createBufferSource(); n.buffer = audio.noise!.buffer; const lp = C.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(3000, t); lp.frequency.exponentialRampToValueAtTime(120, t + 1.2);
      g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 1.4); n.connect(lp); lp.connect(g); n.start(t); n.stop(t + 1.5);
      for (let i = 0; i < 4; i++) { const o = C.createOscillator(); o.type = 'square'; o.frequency.value = 80 + i * 37; const gg = C.createGain(); gg.connect(audio.master!); const t0 = t + 0.35 + i * 0.22; gg.gain.setValueAtTime(0, t0); gg.gain.linearRampToValueAtTime(0.15, t0 + 0.01); gg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.2); o.connect(gg); o.start(t0); o.stop(t0 + 0.25); }
    } else if (kind === 'lane') {
      const n = C.createBufferSource(); n.buffer = audio.noise!.buffer; const bp = C.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.setValueAtTime(400, t); bp.frequency.exponentialRampToValueAtTime(1600, t + 0.3); bp.Q.value = 1.5;
      g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35); n.connect(bp); bp.connect(g); n.start(t); n.stop(t + 0.4);
    } else {
      const o = C.createOscillator(); o.type = 'square'; o.frequency.value = 90; g.gain.setValueAtTime(0.3, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12); o.connect(g); o.start(t); o.stop(t + 0.13);
    }
  }

  // ─── state ───
  const G = {
    phase: 'title' as Phase, dist: 0, speed: 0, hold: false, lowered: 0, lowerVel: 0, air: 1, airLocked: false, hammer: false, mult: 1, score: 0,
    lane: 1, laneX: 0, loadH: 4.75, loadIdx: 0, z0: LOAD_Z0, z1: LOAD_Z1, nextUpgrade: UPGRADE_FIRST, sway: 0, swayV: 0, swayPh: 0, gustLift: 0, potholeBounce: 0,
    cleared: 0, shaveChain: 0, shaveUntil: -1, shaveRun: 0, topMult: 1, bridgeCount: 0, nextW: FIRST_BRIDGE,
    wpIdx: 0, wpW: 0, wpDeadline: 0, wpClock: 0, dispIdx: 0, dispProg: 0, bonusKm: 0,
    crashKind: null as string | null, crashBridge: '', crashT: 0, crashPt: new THREE.Vector3(), shake: 0, time: 0, best: 0, tod: 0,
  };
  try { G.best = parseFloat(localStorage.getItem('clr3d.best') || '0') || 0; } catch { /* private mode */ }
  const lift = () => SWAY_ARM * Math.abs(Math.sin(G.sway));
  const hEff = () => G.loadH - G.lowered + lift() + G.gustLift + G.potholeBounce;
  const hMin = () => G.loadH - DUCK_MAX + G.gustLift + G.potholeBounce; // fully lowered and steady

  // ─── clearance generation (relative to the load's resting height h; posted in 0.05 m steps) ───
  // graze: fits untouched by <10 cm (the greed tier) · easy · tight: partial duck · max: near-full duck
  function solutionClear(h: number): number {
    const tutorial = G.loadIdx === 0 && G.dist < UPGRADE_FIRST;
    const r = rngWorld();
    if (r < 0.3 || (tutorial && r < 0.6)) return step05(h + 0.03 + rngWorld() * 0.05 + 0.001);
    if (r < 0.6 || tutorial) return step05(h + 0.15 + rngWorld() * 0.25);
    if (r < 0.85) return step05(h - (DUCK_MAX - 0.1) + rngWorld() * (DUCK_MAX - 0.15)); // tight
    return step05(h - DUCK_MAX + 0.02 + rngWorld() * 0.08); // max
  }
  function decoyClear(h: number): number {
    return rngWorld() < 0.45 ? step05(h - (DUCK_MAX - 0.1) + rngWorld() * (DUCK_MAX - 0.15)) : step05(h - 0.85 + rngWorld() * 0.3);
  }
  function spawnBridge(b: Bridge, w: number, idx: number) {
    b.id = ++bridgeSeq; b.w = w; b.depth = 9 + rngWorld() * 5; b.cleared = false; b.minMargin = 9; b.active = true; b.faceHidden = false;
    b.duckedUnder = false; b.hammeredUnder = false;
    const isRail = idx % 3 === 2 && idx > 1;
    b.kind = isRail ? 'rail' : rngWorld() < 0.55 ? 'girder' : 'steel';
    b.name = isRail ? RAIL_NAME : BRIDGE_NAMES[Math.floor(rngWorld() * BRIDGE_NAMES.length)];
    const h = G.loadH;
    if (idx < 2) { const c = idx === 0 ? step05(h + 0.25) : step05(h + 0.2); for (const L of b.lanes) L.clear = c; }
    else if (isRail) { const c = solutionClear(h); for (const L of b.lanes) L.clear = c; }
    else { const sol = Math.floor(rngWorld() * 3); for (let i = 0; i < 3; i++) b.lanes[i].clear = i === sol ? solutionClear(h) : decoyClear(h); }
    if (!b.lanes.some((L) => L.clear >= h - DUCK_MAX + 0.04)) b.lanes[Math.floor(rngWorld() * 3)].clear = step05(h + 0.05);
    layoutBridge(b);
    updateVerdicts(b, G.loadH, G.loadH - DUCK_MAX);
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
      const v: Verdict = L.clear >= hNow ? 'fit' : L.clear >= hLow ? 'duck' : 'no';
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
    G.dist = 0; G.speed = BASE_SPEED; G.hold = false; G.lowered = 0; G.lowerVel = 0; G.air = 1; G.airLocked = false; G.hammer = false; G.mult = 1; G.score = 0;
    G.loadIdx = 0; G.nextUpgrade = UPGRADE_FIRST; setLoad(0);
    G.lane = 1; G.laneX = 0; G.sway = 0; G.swayV = 0; G.swayPh = rngFx() * 6; G.gustLift = 0; G.potholeBounce = 0;
    G.cleared = 0; G.shaveChain = 0; G.shaveUntil = -1; G.shaveRun = 0; G.topMult = 1; G.bonusKm = 0;
    G.crashKind = null; G.crashBridge = ''; G.crashT = 0; G.shake = 0; G.tod = 0; G.dispIdx = 0; G.dispProg = 0;
    rngWorld = mulberry32(seed + 1);
    resetBridges();
    setWaypoint(0);
    for (const c of chunks) c.m.visible = false;
    for (const v of [...traffic, ...oncoming]) { v.active = false; v.g.visible = false; }
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
    let seen = false; try { seen = localStorage.getItem('clr3d.seen') === '1'; localStorage.setItem('clr3d.seen', '1'); } catch { /* ignore */ }
    el.hint.style.opacity = seen ? '0' : '1';
    setTimeout(() => (el.hint.style.opacity = '0'), 7000);
  }
  function crash(kind: 'BRIDGE STRIKE' | 'PIER STRIKE' | 'COLLISION', b: Bridge | null, point: THREE.Vector3, label = '') {
    G.phase = 'crash'; G.crashKind = kind; G.crashBridge = b ? b.name : label; G.crashT = 0; G.crashPt.copy(point); G.hold = false;
    if (G.score > G.best) { G.best = G.score; try { localStorage.setItem('clr3d.best', String(G.best)); } catch { /* ignore */ } }
    if (reduceMotion) { showFail(); return; }
    loadG.visible = false;
    for (const c of chunks) {
      c.m.visible = true;
      c.m.position.set(point.x + (rngFx() - 0.5) * 2.8, point.y - rngFx() * 2.2, point.z + (rngFx() - 0.5) * 6);
      c.v.set((rngFx() - 0.5) * 10, 2 + rngFx() * 8, 5 + rngFx() * 12);
      c.av.set(rngFx() * 6, rngFx() * 6, rngFx() * 6);
    }
    G.shake = 1; sfx('crash');
    el.flash.style.transition = 'none'; el.flash.style.opacity = '0.7';
    requestAnimationFrame(() => { el.flash.style.transition = 'opacity .6s'; el.flash.style.opacity = '0'; });
  }
  function shareRun() {
    const text = `I hauled ${G.score.toFixed(2)} km in BRIDGE STRIKE! before the ${G.crashBridge} got it. ${G.cleared} overpasses survived. Repair bill ${el.frep.textContent}.`;
    const url = typeof location !== 'undefined' ? location.href : '';
    if (navigator.share) navigator.share({ title: 'BRIDGE STRIKE!', text, url }).catch(() => { /* cancelled */ });
    else if (navigator.clipboard) { navigator.clipboard.writeText(text + ' ' + url).then(() => banner('Copied', 'Paste it somewhere loud')); }
  }
  function showFail() {
    G.phase = 'fail';
    el.kind.textContent = G.crashKind === 'COLLISION' ? 'Rear-ended' : (G.crashKind || 'BRIDGE STRIKE') + '!';
    el.bname.textContent = G.crashBridge;
    el.fkm.textContent = G.score.toFixed(2) + ' km'; el.fmult.textContent = '×' + G.topMult;
    el.fcl.textContent = String(G.cleared); el.fbest.textContent = G.best.toFixed(2) + ' km';
    // the 2026 strikes ran $283k and $350k in repairs; the driver's fine was $11,200
    const repair = G.crashKind === 'COLLISION' ? 18000 + G.speed * 900 : 180000 + G.speed * 5200 + (G.loadH - 4.3) * 90000;
    el.frep.textContent = '$' + Math.round(repair / 1000) + ',000'; el.ffine.textContent = G.crashKind === 'COLLISION' ? '$580' : '$11,200';
    el.card.classList.add('show'); el.hud.classList.add('hidden');
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
    if (d.id === 'nobrake' && ev === 'clear') G.dispProg = b && b.duckedUnder ? 0 : G.dispProg + 1;
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
    G.speed = base * (G.hammer ? HAMMER_SPEED : 1);
    G.dist += G.speed * dt;
    // air + hydraulics
    if (G.hold && !G.airLocked) { G.air -= AIR_DRAIN * dt; if (G.air <= 0) { G.air = 0; G.airLocked = true; } }
    else { G.air = Math.min(1, G.air + AIR_REFILL * dt); if (G.airLocked && G.air >= AIR_RELOCK) G.airLocked = false; }
    const ducking = G.hold && !G.airLocked;
    if (ducking) { G.lowered = Math.min(DUCK_MAX, G.lowered + DUCK_SPEED * dt); G.lowerVel = 0; }
    else if (G.lowered !== 0 || G.lowerVel !== 0) {
      const acc = -SPRING_K * G.lowered - SPRING_C * G.lowerVel;
      G.lowerVel += acc * dt; G.lowered += G.lowerVel * dt;
      if (Math.abs(G.lowered) < 0.002 && Math.abs(G.lowerVel) < 0.01) { G.lowered = 0; G.lowerVel = 0; }
    }
    // load upgrades: never while under or within 60 m of an uncleared bridge
    if (G.dist >= G.nextUpgrade && G.loadIdx < LOADS.length - 1) {
      const near = bridges.some((b) => b.active && !b.cleared && b.w - 60 < G.dist + G.z1 && b.w + b.depth + 5 > G.dist);
      if (!near) {
        setLoad(G.loadIdx + 1);
        G.nextUpgrade = G.dist + UPGRADE_EVERY;
        // regenerate every bridge not yet in view for the new height; bridges already in view keep their
        // plates but must still offer one survivable lane for the taller load
        for (const b of bridges) {
          if (!b.active || b.cleared) continue;
          if (b.w > G.dist + LOOK_AHEAD) { b.active = false; b.group.visible = false; continue; }
          if (!b.lanes.some((L) => L.clear >= G.loadH - DUCK_MAX + 0.04)) {
            const best = b.lanes.reduce((m, L) => (L.clear > m.clear ? L : m), b.lanes[0]);
            const c = step05(G.loadH + 0.05 + rngWorld() * 0.1);
            if (b.kind === 'rail') for (const L of b.lanes) L.clear = c; else best.clear = c;
            layoutBridge(b); updateVerdicts(b, G.loadH, G.loadH - DUCK_MAX);
          }
        }
        const last = bridges.filter((b) => b.active).reduce((m, b) => Math.max(m, b.w + b.depth), G.dist);
        G.nextW = Math.max(G.nextW - 1e9, last + spacing());
        G.bridgeCount = Math.max(G.bridgeCount, 3);
        fillBridges();
        banner(LOADS[G.loadIdx].name, `New load · ${LOADS[G.loadIdx].h.toFixed(2)} m · ${LOADS[G.loadIdx].h > 4.15 ? 'permit required (you did not obtain this)' : 'approved'}`, LOADS[G.loadIdx].h > 4.15, 2600);
        sfx('stamp');
      }
    }
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
    const c = lerp(SWAY_C, SWAY_C_LOW, G.lowered / DUCK_MAX);
    G.swayV += (-SWAY_K * G.sway - c * G.swayV + ex) * dt - dx * 0.03; // lane changes kick the load
    G.sway += G.swayV * dt;
    // waypoint clock
    G.wpClock -= dt;
    if (G.dist >= G.wpW) {
      if (G.wpClock >= 0) { G.score += 0.4; G.bonusKm += 0.4; banner(wpName(), 'On time · +0.40 km'); }
      else banner(wpName(), 'Late. Dispatch has noted it.', true, 2200);
      setWaypoint(G.wpIdx + 1);
    }
    // traffic
    spawnTraffic(); spawnOncoming();
    const base0 = base;
    for (const v of traffic) {
      if (!v.active) continue;
      v.w += v.v * base0 * dt;
      if (v.w + v.len < G.dist - 40 || v.w > G.dist + 900) { v.active = false; v.g.visible = false; continue; }
      // our rig spans [dist, dist + 20.9] in lane laneX
      const overlapW = v.w < G.dist + 20.9 && v.w + v.len > G.dist;
      if (overlapW && Math.abs(G.laneX - v.x) < LOAD_HALF_W + 1.05) {
        crash('COLLISION', null, new THREE.Vector3(v.x, 1.5, G.dist - v.w - 1), v.kind === 'grain' ? 'REAR-ENDED A GRAIN TRUCK' : 'REAR-ENDED A HALF-TON');
        return;
      }
    }
    for (const v of oncoming) {
      if (!v.active) continue;
      v.w -= v.v * dt;
      if (v.w < G.dist - 80) { v.active = false; v.g.visible = false; }
    }
    // bridges
    fillBridges();
    const top = hEff();
    const z0 = G.dist + G.z0, z1 = G.dist + G.z1;
    for (const b of bridges) {
      if (!b.active) continue;
      if (b.w + b.depth < G.dist - 70) { b.active = false; b.group.visible = false; continue; }
      const under = z1 > b.w && z0 < b.w + b.depth;
      if (under && !b.cleared) {
        if (G.lowered > 0.05) b.duckedUnder = true;
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
          banner('Close shave', `${Math.max(0, Math.round(b.minMargin * 100))} cm · ×${m}`); sfx('shave');
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
  void headL; void headR; void tail; void sideMarkers; void roofMarkers; void hoodLamps;

  // ─── camera ───
  let portrait = false;
  let camMode: 'chase' | 'dolly' = 'chase';
  let camOverride: { p: THREE.Vector3; t: THREE.Vector3 } | null = null;
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
      camPos.lerp(tmpV.set(G.laneX - 11, 2.4, -6), Math.min(1, 4 * dt));
      camTarget.set(G.laneX + 3, 2.6, -15);
    } else {
      camPos.lerp(tmpV.set(G.laneX * 0.5, CAM_UP, CAM_BACK), Math.min(1, 4 * dt));
      camTarget.set(G.laneX * 0.3, 2.6 + (hAt(G.dist + 30) - hAt(G.dist)) * 0.8, -28);
    }
    if (camOverride) { camPos.copy(camOverride.p); camTarget.copy(camOverride.t); }
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
    const h0 = hAt(d);
    asphalt.map.offset.y = (d / (ROAD_LEN / 30)) % 1; asphalt.rough.offset.y = asphalt.map.offset.y;
    grass.map.offset.y = (d / (1150 / 26)) % 1;
    for (const f of fields) { while (f.w < d - 260) f.w += f.span; f.m.position.set(f.x, f.m.position.y, d - f.w); }
    deformStrips(d, h0);
    // traffic
    for (const v of traffic) if (v.active) {
      v.g.position.set(v.x, hAt(v.w) - h0, d - v.w - v.len / 2);
      v.g.rotation.x = Math.atan(slopeAt(v.w));
      const spin = v.v * G.speed * dt / 0.45; for (const w of v.wheels) w.rotation.x -= spin;
    }
    for (const v of oncoming) if (v.active) { v.g.position.set(v.x, hAt(v.w) - h0, d - v.w); v.g.rotation.x = -Math.atan(slopeAt(v.w)); }
    headMat.emissiveIntensity = 3 * lightsOn; tailMat.emissiveIntensity = 2 * lightsOn;
    for (const g of scatterGroups) {
      const { im, items } = g;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        while (it.w < d - 60) it.w += it.span;
        tmpP.set(it.x, g.y + hAt(it.w) - h0 - 0.15, d - it.w); tmpQ.setFromAxisAngle(tmpV.set(0, 1, 0), it.rot); tmpS.setScalar(it.s);
        im.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      }
      im.instanceMatrix.needsUpdate = true;
    }
    for (const c of clouds) c.s.position.set(c.x - (d * 0.02) % 400, c.y, c.z);
    city.position.set(0, hAt(d + 1000) - h0 - 2, -1000); city.scale.setScalar(1 + Math.min(2.2, d / 2600));
    beam.position.set(0, 210 + hAt(G.wpW) - h0, d - G.wpW);
    beam.visible = G.phase !== 'title';
    for (const b of bridges) {
      if (!b.active) continue;
      b.group.position.set(0, hAt(b.w + b.depth / 2) - h0, d - b.w);
      const passed = b.w < d - 1;
      if (passed !== b.faceHidden) { b.faceHidden = passed; for (const L of b.lanes) L.plate.visible = L.lamp.visible = L.board.visible = !passed; }
    }
    // truck pose
    const tx = LANE_X[G.lane];
    truck.position.x = G.laneX;
    if (G.phase !== 'crash') { truck.rotation.z = (tx - G.laneX) * 0.03; truck.rotation.y = (tx - G.laneX) * -0.05; truck.rotation.x = Math.atan(slopeAt(d + 8)); }
    loadG.rotation.z = G.sway;
    loadG.position.y = -G.lowered - 0.02 * Math.abs(Math.sin(G.time * 9)) * (G.speed / 30);
    const spin = G.speed * dt / 0.53;
    for (const w of wheels) w.rotation.x -= spin;
    const spinBig = G.speed * dt / 0.8;
    for (const w of modelWheels) w.rotation.x += spinBig;
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
    for (const b of bridges) if (b.active && !b.cleared && b.w + b.depth > d + G.z0 && (!nb || b.w < nb.w)) nb = b;
    if (nb && nb.w < d + LOOK_AHEAD) {
      updateVerdicts(nb, hEff(), hMin());
      marker.visible = G.phase === 'run';
      marker.position.set(G.laneX, hEff() + hAt(nb.w + nb.depth / 2) - h0, d - nb.w + 0.6);
      marker.rotation.z = G.sway;
      const fits = nb.lanes[G.lane].clear >= hEff();
      (marker.material as THREE.MeshBasicMaterial).color.set(fits ? '#5fd68a' : '#e0463a');
      for (let i = 0; i < 3; i++) {
        const L = nb.lanes[i], c = el.chips[i];
        c.className = 'c3-chip ' + L.verdict + (i === G.lane ? ' cur' : '');
        (c.children[0] as HTMLElement).textContent = L.clear.toFixed(2);
        (c.children[1] as HTMLElement).textContent = L.verdict === 'fit' ? 'Fits' : L.verdict === 'duck' ? 'Duck ▼' : 'No';
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
    el.mode.textContent = G.airLocked ? 'Air empty' : G.lowered > 0.02 ? 'Load lowered' : G.hammer ? 'Hammer down' : 'Full ahead';
    el.mode.className = 'mode' + (G.airLocked ? ' hammer' : G.lowered > 0.02 ? ' brake' : G.hammer ? ' hammer' : '');
    el.airbar.style.transform = `scaleX(${G.air.toFixed(3)})`;
    el.air.className = 'air' + (G.airLocked ? ' lock' : G.air < 0.3 ? ' low' : '');
    el.h.textContent = hEff().toFixed(2) + ' m'; el.hl.textContent = LOADS[G.loadIdx].name;
    el.mult.textContent = G.mult > 1 ? `×${G.mult}${G.hammer ? ' · HAMMER DOWN' : ''}` : '';
    el.wpn.textContent = `${wpName()} · ${Math.max(0, (G.wpW - G.dist) / 1000).toFixed(2)} km`;
    el.wpt.textContent = fmtClock(G.wpClock);
    el.wpt.classList.toggle('late', G.wpClock < 0);
    const dsp = DISPATCH[G.dispIdx % DISPATCH.length];
    el.dispo.textContent = `DISPATCH · ${dsp.text.toUpperCase()} · ${G.dispProg}/${dsp.goal}`;
    el.cl.textContent = String(G.cleared);
    el.view.textContent = camMode === 'chase' ? 'CAM' : 'SIDE';
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
    audioTick();
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
      case 'left': if (G.phase === 'run' && G.lane > 0) { G.lane--; sfx('lane'); } break;
      case 'right': if (G.phase === 'run' && G.lane < 2) { G.lane++; sfx('lane'); } break;
      case 'hold': case 'brake': G.hold = G.phase === 'run'; break;
      case 'release': G.hold = false; break;
      case 'hammer': case 'throttle': if (G.phase === 'run') { G.hammer = !G.hammer; banner(G.hammer ? 'Hammer down' : 'Easing off', G.hammer ? '×2 score · less time to read' : '', G.hammer, 900); } break;
      case 'camera': camMode = camMode === 'chase' ? 'dolly' : 'chase'; break;
      case 'sound': audioSet(!audio.on); break;
      case 'start': if (G.phase === 'title' || G.phase === 'fail') beginRun(); break;
      case 'restart': if (G.phase === 'fail' || G.phase === 'run') beginRun(); break;
    }
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    switch (e.code) {
      case 'ArrowLeft': case 'KeyA': action('left'); e.preventDefault(); break;
      case 'ArrowRight': case 'KeyD': action('right'); e.preventDefault(); break;
      case 'Space': case 'ArrowDown': if (G.phase === 'run') action('hold'); else action('start'); e.preventDefault(); break;
      case 'KeyS': case 'ArrowUp': action('hammer'); break;
      case 'KeyC': action('camera'); break;
      case 'KeyM': action('sound'); break;
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
    if (G.phase === 'run') action('hold');
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
  btn(el.left, 'left'); btn(el.right, 'right'); btn(el.view, 'camera'); btn(el.snd, 'sound');
  el.start.addEventListener('pointerup', () => action('start'));
  el.how.addEventListener('pointerup', () => { el.how.innerHTML = 'How to drive<small>Read the yellow plates. Green FITS, yellow DUCK: hold to lower. Orange: change lane. Air runs out.</small>'; });
  el.share.addEventListener('pointerup', (e) => { e.stopPropagation(); shareRun(); });
  el.ticker.textContent = HEADLINES.join('   •   ') + '   •   ';
  el.restart.addEventListener('pointerup', (e) => { e.stopPropagation(); action('restart'); });
  el.card.addEventListener('pointerdown', (e) => e.stopPropagation());

  // ─── hooks ───
  const snapshot = (): GameSnapshot => ({
    phase: G.phase, dist: G.dist, speed: G.speed, hammer: G.hammer, hold: G.hold, lowered: G.lowered, air: G.air, airLocked: G.airLocked, mult: G.mult, score: G.score,
    lane: G.lane, laneX: G.laneX, loadH: G.loadH, loadName: LOADS[G.loadIdx].name, sway: G.sway, lift: lift(), hEff: hEff(), cleared: G.cleared, shaveChain: G.shaveChain,
    crashKind: G.crashKind, tod: G.tod,
    waypoint: G.phase === 'run' ? { name: wpName(), remaining: G.wpW - G.dist, clock: G.wpClock } : null,
    dispatch: { text: DISPATCH[G.dispIdx % DISPATCH.length].text, progress: G.dispProg, goal: DISPATCH[G.dispIdx % DISPATCH.length].goal },
    bridges: bridges.filter((b) => b.active && !b.cleared).sort((a, b) => a.w - b.w)
      .map((b) => ({ w: b.w, depth: b.depth, kind: b.kind, name: b.name, clears: b.lanes.map((L) => L.clear), verdicts: b.lanes.map((L) => L.verdict) })),
    traffic: traffic.filter((v) => v.active).map((v) => ({ w: v.w, len: v.len, lane: v.lane, v: v.v })),
  });
  window.__game = snapshot;
  window.__gameWarp = (m: number) => {
    G.dist += m; G.tod = clamp(G.dist / (NIGHT_KM * 1000), 0, 1);
    const idx = G.dist < UPGRADE_FIRST ? 0 : Math.min(LOADS.length - 1, 1 + Math.floor((G.dist - UPGRADE_FIRST) / UPGRADE_EVERY));
    setLoad(idx); G.nextUpgrade = idx === 0 ? UPGRADE_FIRST : UPGRADE_FIRST + idx * UPGRADE_EVERY;
    resetBridges(); setWaypoint(G.wpIdx); applyTimeOfDay(G.tod);
  };
  window.__gameInput = action;
  window.__gameCam = (pos, target) => { camOverride = pos ? { p: new THREE.Vector3(...pos), t: new THREE.Vector3(...(target || [0, 2, -12])) } : null; };
  // deterministic stepping for headless bots (rendering is not needed to advance the sim)
  window.__gameStep = (seconds: number) => { const n = Math.max(1, Math.round(seconds * 60)); for (let i = 0; i < n && G.phase === 'run'; i++) simulate(1 / 60); };

  // ─── go ───
  loadModel(opts.modelUrl || '/models/peterbilt.glb');
  el.best.textContent = G.best > 0 ? `Best haul ${G.best.toFixed(2)} km` : '';
  resetRun();
  placeWorld(0);
  raf = requestAnimationFrame(frame);

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    ro.disconnect();
    window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp);
    delete window.__game; delete window.__gameWarp; delete window.__gameInput; delete window.__gameStep; delete window.__gameCam;
    pmrem.dispose(); envTex?.dispose(); renderer.dispose(); audio.ctx?.close();
    root.innerHTML = ''; root.classList.remove('c3-root');
  };
}
