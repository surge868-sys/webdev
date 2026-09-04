// Drive the verify bot and dump the state around each crash.
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
await p.goto('file://' + process.cwd() + '/dist/clearance.html');
await p.waitForFunction(() => typeof window.__game === 'function');
await p.waitForTimeout(1000);
const input = (a) => p.evaluate((a) => window.__gameInput(a), a);
for (let run = 0; run < 3; run++) {
  await p.waitForFunction(() => window.__game().phase !== 'crash');
  await input(run === 0 ? 'start' : 'restart');
  await p.waitForTimeout(200);
  let hold = false; const hist = [];
  let s = await p.evaluate(() => window.__game());
  while (s.phase === 'run' && s.dist < 6000) {
    const nb = s.bridges[0];
    if (nb) {
      const gap = nb.w - s.dist, hRest = s.loadH, hLow = s.loadH - 0.3;
      let best = -1, bestScore = -1e9;
      for (let i = 0; i < 3; i++) { const c = nb.clears[i]; let sc = c >= hRest + 0.12 ? 100 - (c - hRest) : c >= hLow + 0.03 ? 50 + (c - hLow) : -100; sc -= Math.abs(i - s.lane) * 0.5; if (s.traffic.some((t) => t.lane === i && t.w + t.len > s.dist && t.w < s.dist + 140)) sc -= 80; if (sc > bestScore) { bestScore = sc; best = i; } }
      if (best !== s.lane && gap > 25 + s.speed * 0.4) await input(best < s.lane ? 'left' : 'right');
      const laneNow = best === s.lane ? best : s.lane;
      const want = nb.clears[laneNow] < hRest + 0.12 && gap < 12 + s.speed * 0.5 && gap + nb.depth + 14 > 0;
      if (want && !hold) { await input('hold'); hold = true; }
      if (!want && hold) { await input('release'); hold = false; }
    } else if (s.traffic.some((t) => t.lane === s.lane && t.w + t.len > s.dist && t.w < s.dist + 90)) {
      const free = [0, 1, 2].filter((i) => i !== s.lane && !s.traffic.some((t) => t.lane === i && t.w + t.len > s.dist - 10 && t.w < s.dist + 120));
      if (free.length) await input(free[0] < s.lane ? 'left' : 'right');
    }
    await p.evaluate(() => window.__gameStep(0.1));
    s = await p.evaluate(() => window.__game());
    hist.push({ d: +s.dist.toFixed(1), lane: s.lane, x: +s.laneX.toFixed(2), h: +s.hEff.toFixed(3), low: +s.lowered.toFixed(2), air: +s.air.toFixed(2), lock: s.airLocked, hold: s.hold, nb: s.bridges[0] ? { w: +s.bridges[0].w.toFixed(1), depth: +s.bridges[0].depth.toFixed(1), c: s.bridges[0].clears, v: s.bridges[0].verdicts } : null, load: s.loadName, loadH: s.loadH, kind: s.crashKind });
    if (hist.length > 14) hist.shift();
  }
  console.log(`RUN ${run}: ${s.crashKind} at ${Math.round(s.dist)} m, cleared ${s.cleared}, load ${s.loadName} ${s.loadH}`);
  for (const h of hist.slice(-8)) console.log(JSON.stringify(h));
}
await b.close();
