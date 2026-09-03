// One landscape screenshot on the open road, for checking distant depth artefacts.
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto('file://' + process.cwd() + '/dist/clearance.html');
await p.waitForFunction(() => typeof window.__game === 'function');
await p.evaluate(() => { window.__gameInput('start'); window.__gameStep(2.2); });
await p.waitForTimeout(600);
await p.screenshot({ path: 'verify/08-far.png' });
await b.close();
