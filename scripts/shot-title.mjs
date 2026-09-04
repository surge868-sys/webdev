import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
await p.goto('file://' + process.cwd() + '/dist/clearance.html');
await p.waitForFunction(() => typeof window.__game === 'function');
await p.waitForTimeout(4000); await p.evaluate(() => document.fonts.ready); console.log('fonts', await p.evaluate(() => Array.from(document.fonts).map((f) => f.family + ':' + f.status).join(',')));
await p.screenshot({ path: 'verify/01-title.png' });
await b.close();
