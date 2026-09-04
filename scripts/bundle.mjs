// Bundles src/game3d/game.ts + three into a single self-contained HTML file (dist/clearance.html).
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const res = await build({
  entryPoints: ['src/game3d/game.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'Clearance',
  target: ['es2019'],
  write: false,
  legalComments: 'none',
});
const js = res.outputFiles[0].text;
const glb = readFileSync('public/models/peterbilt.glb').toString('base64');
const fontUri = (f) => `data:font/woff2;base64,${readFileSync('public/fonts/' + f).toString('base64')}`;
const jsEmbedded = js.replace('url(/fonts/anton.woff2)', `url(${fontUri('anton.woff2')})`).replace('url(/fonts/oswald.woff2)', `url(${fontUri('oswald.woff2')})`);
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#0b6b3a">
<title>BRIDGE STRIKE!</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#0b1020;overscroll-behavior:none}#game{position:fixed;inset:0}</style>
</head><body><div id="game"></div>
<script>${jsEmbedded}</script>
<script>Clearance.startGame(document.getElementById('game'), { modelUrl: 'data:model/gltf-binary;base64,${glb}' });</script>
</body></html>`;
mkdirSync('dist', { recursive: true });
writeFileSync('dist/clearance.html', html);
console.log('dist/clearance.html', (html.length / 1024).toFixed(0) + ' KB');
