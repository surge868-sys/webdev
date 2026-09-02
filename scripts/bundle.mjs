// Bundles src/game3d/game.ts + three into a single self-contained HTML file (dist/clearance.html).
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';

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
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#0b6b3a">
<title>CLEARANCE 3D</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;700&display=swap" rel="stylesheet">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#6ea7dd;overscroll-behavior:none}#game{position:fixed;inset:0}</style>
</head><body><div id="game"></div>
<script>${js}</script>
<script>Clearance.startGame(document.getElementById('game'));</script>
</body></html>`;
mkdirSync('dist', { recursive: true });
writeFileSync('dist/clearance.html', html);
console.log('dist/clearance.html', (html.length / 1024).toFixed(0) + ' KB');
