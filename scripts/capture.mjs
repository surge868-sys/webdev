// Frame-by-frame gameplay capture: node scripts/capture.mjs <outdir> [seconds] [w] [h]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
const out = process.argv[2] || 'verify/frames', SECS = +(process.argv[3] || 26), W = +(process.argv[4] || 720), H = +(process.argv[5] || 1280), FPS = +(process.env.FPS || 20);
mkdirSync(out, { recursive: true });
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await p.goto('file://' + process.cwd() + '/dist/clearance.html');
await p.waitForFunction(() => typeof window.__game === 'function');
await p.waitForTimeout(3000);
await p.evaluate(() => document.fonts.ready);
let n = 0;
const shot = async () => { await p.screenshot({ path: `${out}/f${String(n++).padStart(5, '0')}.png` }); };
// title: 2 s (CSS drift runs in real time, so pace it)
for (let i = 0; i < FPS * 2; i++) { await shot(); await p.waitForTimeout(10); }
await p.evaluate(() => { window.__gamePause(true); window.__gameInput('start'); });
const input = (a) => p.evaluate((a) => window.__gameInput(a), a);
let hold = false, crashedAt = -1, log = [];
for (let i = 0; i < FPS * SECS; i++) {
  const s = await p.evaluate(() => window.__game());
  if (s.phase === 'run') {
    const nb = s.bridges[0];
    if (nb) {
      const gap = nb.w - s.dist, hRest = s.loadH, hLow = s.loadH - 0.3;
      let best = -1, bestScore = -1e9;
      for (let k = 0; k < 3; k++) { const c = nb.clears[k]; let sc = c >= hRest + 0.12 ? 100 - (c - hRest) : c >= hLow + 0.03 ? 50 + (c - hLow) : -100; sc -= Math.abs(k - s.lane) * 0.5; if (s.traffic.some((t) => t.lane === k && t.w + t.len > s.dist && t.w < s.dist + 140)) sc -= 80; if (sc > bestScore) { bestScore = sc; best = k; } }
      if (best !== s.lane && gap > 25 + s.speed * 0.4) await input(best < s.lane ? 'left' : 'right');
      const laneNow = best === s.lane ? best : s.lane;
      const want = nb.clears[laneNow] < hRest + 0.12 && gap < 12 + s.speed * 0.5 && gap + nb.depth + 14 > 0;
      if (want && !hold) { await input('hold'); hold = true; }
      if (!want && hold) { await input('release'); hold = false; }
    } else if (s.traffic.some((t) => t.lane === s.lane && t.w + t.len > s.dist && t.w < s.dist + 90)) {
      const free = [0, 1, 2].filter((k) => k !== s.lane && !s.traffic.some((t) => t.lane === k && t.w + t.len > s.dist - 10 && t.w < s.dist + 120));
      if (free.length) await input(free[0] < s.lane ? 'left' : 'right');
    }
    // a little showmanship: hammer down for a stretch mid-run
    if (i === FPS * 9) await input('hammer');
    if (i === FPS * 15) await input('hammer');
    // deliberately strike near the end so the video has a punchline
    if (i > FPS * (SECS - 7) && nb && nb.w - s.dist < 60) { let worst = 0; for (let k = 1; k < 3; k++) if (nb.clears[k] < nb.clears[worst]) worst = k; if (worst !== s.lane) await input(worst < s.lane ? 'left' : 'right'); if (hold) { await input('release'); hold = false; } }
  } else if (s.phase === 'crash' && crashedAt < 0) crashedAt = n;
  await p.evaluate((dt) => window.__gameFrame(dt), 1 / FPS);
  await shot();
  log.push({ f: n, d: Math.round(s.dist), phase: s.phase, cleared: s.cleared });
  if (s.phase === 'fail' && n - crashedAt > FPS * 3) break;
}
writeFileSync(`${out}/log.json`, JSON.stringify({ frames: n, crashedAt, fps: FPS, last: log[log.length - 1] }));
console.log('frames', n, 'crashedAt', crashedAt, JSON.stringify(log[log.length - 1]));
await b.close();
