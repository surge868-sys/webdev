// Headless check that the music pipeline decodes and switches with the phases (no audible output under Playwright).
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') errs.push(m.text()); });
await p.goto('file://' + process.cwd() + '/dist/clearance.html');
await p.waitForFunction(() => typeof window.__game === 'function');
await p.evaluate(() => window.__gameInput('sound'));
await p.waitForTimeout(4000);
const st = await p.evaluate(() => window.__musicState && window.__musicState());
console.log('after sound on', JSON.stringify(st));
await p.evaluate(() => { window.__gameInput('start'); window.__gameStep(1); });
await p.waitForTimeout(800);
console.log('in run', JSON.stringify(await p.evaluate(() => window.__musicState())));
console.log('errors', errs.filter((e) => !e.includes('ERR_CONNECTION')));
await b.close();
