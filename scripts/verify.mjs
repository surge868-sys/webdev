// Headless verification: screenshots (title, bridge approach, crash) + a plate-reading bot.
// Usage: node scripts/verify.mjs [dist/clearance.html]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve(process.argv[2] || 'dist/clearance.html');
const out = 'verify';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('file://' + file);
await page.waitForFunction(() => typeof window.__game === 'function');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/01-title.png` });

const snap = () => page.evaluate(() => window.__game());
const input = (a) => page.evaluate((a) => window.__gameInput(a), a);
await input('start');
await page.waitForTimeout(300);

// Bot: read the next bridge's posted clearances, pick the best lane, hold when close.
const LANE_X = [-3.8, 0, 3.8];
let approachShot = false, holdActive = false, laneSwitches = 0, holds = 0;
const t0 = Date.now();
let s = await snap();
while (s.phase === 'run' && Date.now() - t0 < 120000 && s.dist < 6000) {
  const nb = s.bridges[0];
  if (nb) {
    const gap = nb.w - s.dist; // metres from truck origin to the near face
    const hRest = s.loadH, hLow = s.loadH;
    // choose lane: prefer fit at resting height (tightest fit for shave), else duckable
    let best = -1, bestScore = -1e9;
    const blocked = (i) => s.traffic.some((t) => t.lane === i && t.w + t.len > s.dist && t.w < s.dist + 140);
    for (let i = 0; i < 3; i++) {
      const c = nb.clears[i];
      let sc;
      if (c >= hRest + 0.12) sc = 100 - (c - hRest); // fits at cruise: prefer tightest
      else if (c >= hRest + 0.01) sc = 50 + (c - hLow); // graze: brake to steady
      else sc = -100;
      sc -= Math.abs(i - s.lane) * 0.5; // small bias to stay put
      if (blocked(i)) sc -= 80; // slow vehicle ahead in that lane
      if (sc > bestScore) { bestScore = sc; best = i; }
    }
    if (best !== s.lane && gap > 25 + s.speed * 0.4) {
      await input(best < s.lane ? 'left' : 'right');
      laneSwitches++;
    }
    const laneNow = best === s.lane ? best : s.lane;
    // graze lane: brake early enough for the sway to die before the deck, hold until the truss clears
    const needSteady = nb.clears[laneNow] < hRest + 0.12;
    const under = gap < 30 + s.speed * 0.8 && gap + nb.depth + 14 > 0;
    const want = needSteady && under;
    if (want && !holdActive) { await input('brake'); holdActive = true; holds++; }
    if (!want && holdActive) { await input('release'); holdActive = false; }
    if (!approachShot && gap < 60 && gap > 45 && s.cleared >= 2) {
      await page.screenshot({ path: `${out}/02-approach.png` });
      approachShot = true;
    }
  }
  if (!nb || nb.w - s.dist > 200) {
    // open road: dodge traffic in our lane
    const ahead = s.traffic.find((t) => t.lane === s.lane && t.w + t.len > s.dist && t.w < s.dist + 90);
    if (ahead) {
      const free = [0, 1, 2].filter((i) => i !== s.lane && !s.traffic.some((t) => t.lane === i && t.w + t.len > s.dist - 10 && t.w < s.dist + 120));
      if (free.length) { const to = free.sort((a, b) => Math.abs(a - s.lane) - Math.abs(b - s.lane))[0]; await input(to < s.lane ? 'left' : 'right'); laneSwitches++; }
    }
  }
  await page.evaluate(() => window.__gameStep(0.1));
  s = await snap();
}
const botResult = { phase: s.phase, dist: Math.round(s.dist), score: +s.score.toFixed(2), cleared: s.cleared, crashKind: s.crashKind, laneSwitches, holds, secs: Math.round((Date.now() - t0) / 1000) };
console.log('BOT', JSON.stringify(botResult));
if (!approachShot) await page.screenshot({ path: `${out}/02-approach.png` });

// Time-of-day: warp to dusk and night for screenshots (bot keeps driving a little).
for (const [name, m] of [['06-dusk', 1500], ['07-night', 3300]]) {
  await page.waitForFunction(() => window.__game().phase !== 'crash');
  await input('restart');
  await page.waitForTimeout(150);
  await page.evaluate((m) => window.__gameWarp(m), m);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${out}/${name}.png` });
}

// Force a crash for the crash screenshot: restart, then steer into the lowest lane.
await page.waitForFunction(() => window.__game().phase !== 'crash');
await input('restart');
await page.waitForTimeout(200);
s = await snap();
const tc = Date.now();
while (s.phase === 'run' && Date.now() - tc < 60000) {
  const nb = s.bridges[0];
  if (nb) {
    // steer INTO the lowest lane
    let worst = 0;
    for (let i = 1; i < 3; i++) if (nb.clears[i] < nb.clears[worst]) worst = i;
    if (worst !== s.lane && nb.w - s.dist > 30) await input(worst < s.lane ? 'left' : 'right');
  }
  await page.evaluate(() => window.__gameStep(0.1));
  s = await snap();
}
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/03-crash.png` });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/04-failcard.png` });
console.log('CRASH', JSON.stringify({ phase: s.phase, crashKind: s.crashKind, dist: Math.round(s.dist) }));

// landscape title for good measure
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForFunction(() => window.__game().phase !== 'crash');
await input('restart');
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/05-landscape.png` });
console.log('ERRORS', errors.length ? errors : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);
