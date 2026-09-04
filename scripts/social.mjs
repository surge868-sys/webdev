// Social screenshots: portrait 1080x1920 (title, approach, hammer, crash, game over) and a 1200x630 OG card.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
mkdirSync('verify/social', { recursive: true });
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
async function session(w, h, dpr, run) {
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  await p.goto('file://' + process.cwd() + '/dist/clearance.html');
  await p.waitForFunction(() => typeof window.__game === 'function');
  await p.waitForTimeout(3000); await p.evaluate(() => document.fonts.ready);
  await run(p); await p.close();
}
const step = (p, secs) => p.evaluate((s) => { for (let i = 0; i < s * 30; i++) window.__gameFrame(1 / 30); }, secs);
await session(540, 960, 2, async (p) => {
  await p.screenshot({ path: 'verify/social/01-title-1080x1920.png' });
  await p.evaluate(() => { window.__gamePause(true); window.__gameInput('start'); });
  await step(p, 1.2); await p.screenshot({ path: 'verify/social/02-approach-1080x1920.png' });
  await p.evaluate(() => window.__gameWarp(1450)); await step(p, 0.3);
  await p.evaluate(() => { window.__gameInput('hammer'); }); await step(p, 1.4);
  await p.screenshot({ path: 'verify/social/03-dusk-hammer-1080x1920.png' });
  await p.evaluate(() => window.__gameWarp(1900)); await step(p, 0.3);
  // steer into the lowest lane and let it hit
  for (let i = 0; i < 300; i++) { const s = await p.evaluate(() => window.__game()); if (s.phase !== 'run') break; const nb = s.bridges[0]; if (nb) { let worst = 0; for (let k = 1; k < 3; k++) if (nb.clears[k] < nb.clears[worst]) worst = k; if (worst !== s.lane && nb.w - s.dist > 30) await p.evaluate((d) => window.__gameInput(d), worst < s.lane ? 'left' : 'right'); } await step(p, 0.1); }
  await step(p, 0.25); await p.screenshot({ path: 'verify/social/04-strike-1080x1920.png' });
  await step(p, 1.6); await p.screenshot({ path: 'verify/social/05-gameover-1080x1920.png' });
});
await session(1200, 630, 1, async (p) => {
  await p.evaluate(() => { window.__gamePause(true); window.__gameInput('start'); window.__gameWarp(700); });
  await step(p, 0.4);
  await p.evaluate(() => { document.getElementById('c3-hud').style.display = 'none'; window.__gameCam([-9, 4.2, -2], [1.5, 2.8, -22]); });
  await step(p, 0.1); await p.screenshot({ path: 'verify/social/og-1200x630.png' });
});
await b.close();
console.log('social done');
