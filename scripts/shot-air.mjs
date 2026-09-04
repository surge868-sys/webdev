import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
await p.goto('file://' + process.cwd() + '/dist/clearance.html');
await p.waitForFunction(() => typeof window.__game === 'function');
await p.waitForTimeout(800);
await p.mouse.click(195, 420); // first tap anywhere arms audio (lands on HAUL)
await p.waitForTimeout(3500);
console.log('after first tap', JSON.stringify(await p.evaluate(() => window.__musicState())));
await p.evaluate(() => { if (window.__game().phase !== 'run') window.__gameInput('start'); window.__gameInput('hold'); window.__gameStep(2.5); });
await p.waitForTimeout(400);
await p.screenshot({ path: 'verify/17-air.png', clip: { x: 0, y: 700, width: 390, height: 144 } });
console.log('air', await p.evaluate(() => window.__game().air.toFixed(2)), JSON.stringify(await p.evaluate(() => window.__musicState())));
await b.close();
