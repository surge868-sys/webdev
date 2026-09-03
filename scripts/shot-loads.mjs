// Each load on the trailer, side view, for silhouette checks.
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto('file://' + process.cwd() + '/dist/clearance.html');
await p.waitForFunction(() => typeof window.__game === 'function');
await p.waitForTimeout(2500);
for (let i = 0; i < 6; i++) {
  const name = await p.evaluate((i) => {
    if (window.__game().phase !== 'run') window.__gameInput('start');
    window.__gameWarp(i === 0 ? 0 : 400 + (i - 1) * 1600 + 120 - window.__game().dist); // past each upgrade threshold
    window.__gameStep(0.05);
    // step until the upgrade lands (needs a bridge-free window)
    window.__gameCam([-15, 3.2, -8], [0, 3.0, -7]);
    return window.__game().loadName + ' ' + window.__game().loadH;
  }, i);
  await p.waitForTimeout(400);
  await p.screenshot({ path: `verify/load-${i}.png` });
  console.log(i, name);
  await p.evaluate(() => { window.__gameInput('restart'); });
  await p.waitForTimeout(100);
}
await b.close();
