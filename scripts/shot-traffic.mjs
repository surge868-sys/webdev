import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto('file://' + process.cwd() + '/dist/clearance.html');
await p.waitForFunction(() => typeof window.__game === 'function');
await p.waitForTimeout(2000);
const info = await p.evaluate(() => {
  window.__gameInput('start'); window.__gameWarp(600); window.__gameStep(2);
  const s = window.__game(); const v = s.traffic.sort((a, b) => a.w - b.w)[0]; if (!v) return null;
  const z = s.dist - v.w - v.len / 2; const x = [-3.8, 0, 3.8][v.lane];
  window.__gameCam([x + 9, 3.5, z + 14], [x, 1.2, z]);
  return { z, lane: v.lane, len: v.len };
});
await p.waitForTimeout(600);
await p.screenshot({ path: 'verify/14-traffic.png' });
console.log(JSON.stringify(info));
await b.close();
