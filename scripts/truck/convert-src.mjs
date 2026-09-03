// Runs in the browser: loads the Collada, bakes transforms, merges by material, exports a GLB.
import * as THREE from 'three';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

window.convert = async (url) => {
  const loader = new ColladaLoader();
  const dae = await loader.loadAsync(url);
  const root = dae.scene;
  root.updateMatrixWorld(true);
  // let textures finish, then drop any that did not load
  await new Promise((r) => setTimeout(r, 2500));
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m.map && !(m.map.image && (m.map.image.naturalWidth || m.map.image.width))) { console.log('dropping texture', m.map.name || m.name); m.map = null; }
    }
  });
  const groups = new Map();
  let inTris = 0, culled = 0, culledTris = 0;
  const MIN_DIAG = window.MIN_DIAG ?? 0.12;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    g.computeBoundingBox();
    const diag = g.boundingBox.getSize(new THREE.Vector3()).length();
    if (diag < MIN_DIAG) { culled++; culledTris += g.getAttribute('position').count / 3; return; }
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (o.geometry.groups && o.geometry.groups.length > 1 && Array.isArray(o.material)) {
      // split multi-material geometries by group
      for (const grp of o.geometry.groups) {
        const m = mats[grp.materialIndex];
        const sub = new THREE.BufferGeometry();
        const idx = g.index ? g.index.array.slice(grp.start, grp.start + grp.count) : null;
        for (const name of ['position', 'normal', 'uv']) { const a = g.getAttribute(name); if (a) sub.setAttribute(name, a); }
        if (idx) sub.setIndex(new THREE.BufferAttribute(idx, 1));
        push(m, sub.toNonIndexed());
      }
    } else push(mats[0], g.index ? g.toNonIndexed() : g);
  });
  function key(m) {
    const c = m.color ? m.color.getHexString() : 'fff';
    const t = m.map ? (m.map.image && m.map.image.src ? m.map.image.src.split('/').pop() : 'tex') : '';
    return `${c}|${t}|${m.opacity < 1 ? 'a' : ''}`;
  }
  function push(m, g) {
    const k = key(m);
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    inTris += g.getAttribute('position').count / 3;
    if (!groups.has(k)) groups.set(k, { m, gs: [] });
    groups.get(k).gs.push(g);
  }
  const out = new THREE.Group();
  const report = [];
  // 1) merge + weld every group on positions only
  const welded = [];
  for (const [k, { m, gs }] of groups) {
    let merged = mergeGeometries(gs, false);
    merged.deleteAttribute('uv'); merged.deleteAttribute('normal');
    merged = mergeVertices(merged, 2e-3);
    welded.push({ k, m, g: merged });
  }
  // 2) global dedupe: SketchUp emits each face twice (front + back material); keep one copy per
  //    unordered position triple, preferring the copy whose winding faces away from the body centre.
  const center = new THREE.Vector3();
  { const bb = new THREE.Box3(); for (const w of welded) { w.g.computeBoundingBox(); bb.union(w.g.boundingBox); } bb.getCenter(center); }
  const keyOf = (x, y, z) => `${Math.round(x * 500)},${Math.round(y * 500)},${Math.round(z * 500)}`;
  const seen = new Map(); // triKey -> { gi, ti, outward }
  const drop = welded.map(() => new Set());
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c3 = new THREE.Vector3(), n = new THREE.Vector3(), cen = new THREE.Vector3();
  welded.forEach((w, gi) => {
    const pos = w.g.getAttribute('position'), idx = w.g.index.array;
    for (let t = 0; t < idx.length; t += 3) {
      a.fromBufferAttribute(pos, idx[t]); b.fromBufferAttribute(pos, idx[t + 1]); c3.fromBufferAttribute(pos, idx[t + 2]);
      const ks = [keyOf(a.x, a.y, a.z), keyOf(b.x, b.y, b.z), keyOf(c3.x, c3.y, c3.z)].sort().join('|');
      n.subVectors(b, a).cross(cen.subVectors(c3, a));
      cen.addVectors(a, b).add(c3).multiplyScalar(1 / 3).sub(center);
      // outwardness in the horizontal plane only (roofs/floors are ambiguous)
      const outward = n.x * cen.x + n.z * cen.z + n.y * cen.y * 0.3;
      const prev = seen.get(ks);
      if (!prev) { seen.set(ks, { gi, t, outward }); continue; }
      if (outward > prev.outward) { drop[prev.gi].add(prev.t); seen.set(ks, { gi, t, outward }); }
      else drop[gi].add(t);
    }
  });
  let dropped = 0;
  welded.forEach((w, gi) => {
    const idx = w.g.index.array; const keep = [];
    for (let t = 0; t < idx.length; t += 3) { if (drop[gi].has(t)) { dropped++; continue; } keep.push(idx[t], idx[t + 1], idx[t + 2]); }
    if (!keep.length) return;
    const g = w.g; g.setIndex(keep); g.computeVertexNormals();
    const makeMat = () => { const std = new THREE.MeshStandardMaterial({
      color: w.m.color ? w.m.color.clone() : new THREE.Color('#ffffff'), map: w.m.map || null,
      transparent: w.m.opacity < 1, opacity: w.m.opacity, roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide,
    }); std.name = w.k; return std; };
    const SPLIT = window.SPLIT || {};
    if (SPLIT[w.k]) {
      // split into connected components (union-find over welded indices); each becomes its own centred mesh
      const pos = g.getAttribute('position'); const n = pos.count; const parent = new Int32Array(n); for (let i = 0; i < n; i++) parent[i] = i;
      const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
      const uni = (a2, b2) => { a2 = find(a2); b2 = find(b2); if (a2 !== b2) parent[a2] = b2; };
      for (let t = 0; t < keep.length; t += 3) { uni(keep[t], keep[t + 1]); uni(keep[t + 2], keep[t]); }
      const comps = new Map();
      for (let t = 0; t < keep.length; t += 3) { const r = find(keep[t]); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(keep[t], keep[t + 1], keep[t + 2]); }
      let ci = 0;
      const byTag = new Map();
      for (const tris of comps.values()) {
        const sub = new THREE.BufferGeometry();
        sub.setAttribute('position', pos); sub.setAttribute('normal', g.getAttribute('normal')); sub.setIndex(tris);
        let cg = sub.toNonIndexed(); cg = mergeVertices(cg, 1e-4);
        cg.computeBoundingBox(); const bc = cg.boundingBox.getCenter(new THREE.Vector3()); const bs = cg.boundingBox.getSize(new THREE.Vector3());
        if (!w.m.map) cg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(cg.getAttribute('position').count * 2), 2));
        const tag = SPLIT[w.k](bs, bc, tris.length / 3);
        if (!tag) continue;
        if (tag === 'wheel') {
          cg.translate(-bc.x, -bc.y, -bc.z);
          const mesh = new THREE.Mesh(cg, makeMat()); mesh.name = `${w.k}#wheel${ci++}`; mesh.position.copy(bc); out.add(mesh);
          report.push({ k: mesh.name, tris: tris.length / 3, size: bs.toArray().map((v) => +v.toFixed(2)), at: bc.toArray().map((v) => +v.toFixed(2)) });
        } else { if (!byTag.has(tag)) byTag.set(tag, []); byTag.get(tag).push(cg); }
      }
      for (const [tag, gs2] of byTag) {
        const mg = mergeGeometries(gs2, false);
        const mesh = new THREE.Mesh(mg, makeMat()); mesh.name = `${w.k}#${tag}`; out.add(mesh);
        report.push({ k: mesh.name, tris: mg.getAttribute('position').count / 3 });
      }
      return;
    }
    if (!w.m.map) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    const mesh = new THREE.Mesh(g, makeMat()); mesh.name = w.k; out.add(mesh);
    report.push({ k: w.k, tris: keep.length / 3 });
  });
  window.__dropped = dropped;
  const box = new THREE.Box3().setFromObject(out);
  const size = box.getSize(new THREE.Vector3());
  // preview render
  const W = 1200, H = 700;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(W, H);
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#8fb0d0');
  scene.add(new THREE.HemisphereLight('#fff', '#556', 1.2));
  const d = new THREE.DirectionalLight('#fff', 2); d.position.set(5, 10, 7); scene.add(d);
  scene.add(out);
  const cam = new THREE.PerspectiveCamera(40, W / H, 0.1, 1000);
  const c = box.getCenter(new THREE.Vector3());
  const r = size.length();
  cam.position.set(c.x + r * 0.7, c.y + r * 0.35, c.z + r * 0.8);
  cam.lookAt(c);
  renderer.render(scene, cam);
  out.updateMatrixWorld(true);
  const exporter = new GLTFExporter();
  const glb = await exporter.parseAsync(out, { binary: true });
  const u8 = new Uint8Array(glb); let bin = ''; for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); const b64 = btoa(bin);
  return { culled, culledTris, dropped, size: size.toArray(), min: box.min.toArray(), max: box.max.toArray(), inTris, groups: report.sort((a, b) => b.tris - a.tris), glbBytes: glb.byteLength, b64 };
};
