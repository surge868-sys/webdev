// node scripts/truck/convert.mjs <dir-with-model.dae> <out.glb>
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { chromium } from 'playwright';

const dir = resolve(process.argv[2]);
const outGlb = resolve(process.argv[3]);
const bundle = await build({ entryPoints: ['scripts/truck/convert-src.mjs'], bundle: true, format: 'iife', write: false, minify: false });
const js = bundle.outputFiles[0].text;
const server = createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') { res.setHeader('content-type', 'text/html'); res.end(`<!doctype html><body><script>${js}</script></body>`); return; }
  const f = join(dir, p);
  if (!existsSync(f)) { res.statusCode = 404; res.end(); return; }
  const types = { '.dae': 'model/vnd.collada+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
  res.setHeader('content-type', types[extname(f)] || 'application/octet-stream');
  res.end(readFileSync(f));
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
if (process.env.MIN_DIAG) await page.addInitScript(`window.MIN_DIAG = ${process.env.MIN_DIAG}`);
// split rules: tires -> one mesh per wheel (tagged wheel); c6c6c6 -> tall/thin or small parts are chrome, big boxes are paint
await page.addInitScript(`window.SPLIT = {
  'b1b7be||': (s, c, tris) => (s.y > 1 ? 'wheel' : null),
  'c6c6c6||': (s, c, tris) => (s.x > 1.5 && s.y > 1.2 && s.z > 1.2 ? 'paint' : 'chrome'),
};`);
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
await page.goto(`http://127.0.0.1:${port}/`);
const res = await page.evaluate((u) => window.convert(u), '/model.dae');
await page.screenshot({ path: 'verify/truck-preview.png' });
writeFileSync(outGlb, Buffer.from(res.b64, 'base64'));
delete res.b64;
console.log(JSON.stringify(res, null, 1));
await browser.close();
server.close();
