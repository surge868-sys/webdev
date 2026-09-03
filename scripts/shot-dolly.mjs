// Side-dolly and title-orbit screenshots of the rig.
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto('file://' + process.cwd() + '/dist/clearance.html');
await p.waitForFunction(() => typeof window.__game === 'function');
await p.waitForTimeout(2500);
await p.screenshot({ path: 'verify/09-orbit.png' });
await p.evaluate(() => { window.__gameInput('start'); window.__gameInput('camera'); window.__gameStep(1.5); });
await p.waitForTimeout(1500);
await p.screenshot({ path: 'verify/10-dolly.png' });
await b.close();
