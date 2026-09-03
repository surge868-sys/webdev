// Close-ups of the rig for model placement checks.
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto('file://' + process.cwd() + '/dist/clearance.html');
await p.waitForFunction(() => typeof window.__game === 'function');
await p.waitForTimeout(2500);
await p.evaluate(() => { window.__gameInput('start'); window.__gameStep(0.5); });
const shots = [['11-side', [-16, 2.5, -14], [0, 2.4, -14]], ['12-front34', [-9, 3.2, -30], [0, 2.4, -16]], ['13-rear34', [10, 4, 6], [0, 2.4, -10]]];
for (const [name, pos, t] of shots) {
  await p.evaluate(([pos, t]) => window.__gameCam(pos, t), [pos, t]);
  await p.waitForTimeout(400);
  await p.screenshot({ path: `verify/${name}.png` });
}
await b.close();
