// node scripts/truck/preview.mjs <file.glb> <out.png>
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, basename, dirname, join } from 'node:path';
import { chromium } from 'playwright';
const file = resolve(process.argv[2]);
const bundle = await build({ entryPoints: ['scripts/truck/preview-src.mjs'], bundle: true, format: 'iife', write: false });
const js = bundle.outputFiles[0].text;
const server = createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') { res.setHeader('content-type', 'text/html'); res.end(`<!doctype html><body style="margin:0"><script>${js}</script></body>`); return; }
  const f = join(dirname(file), p);
  if (!existsSync(f)) { res.statusCode = 404; res.end(); return; }
  res.end(readFileSync(f));
}).listen(0);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 500 } });
if (process.env.CODED) await page.addInitScript('window.CODED = true');
page.on('pageerror', (e) => console.log('pageerror', e));
await page.goto(`http://127.0.0.1:${server.address().port}/`);
const res = await page.evaluate((u) => window.preview(u), '/' + basename(file));
await page.screenshot({ path: process.argv[3] });
console.log(JSON.stringify(res));
await browser.close(); server.close();
