import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
window.preview = async (url) => {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url);
  const m = gltf.scene;
  const PAL = ['#e6194b','#3cb44b','#ffe119','#4363d8','#f58231','#911eb4','#46f0f0','#f032e6','#bcf60c','#fabebe','#008080','#e6beff','#9a6324','#fffac8','#800000','#aaffc3','#808000','#ffd8b1','#000075','#808080','#ffffff','#000000','#ff7f50'];
  const legend = [];
  let gi = 0;
  m.traverse((o) => { if (o.isMesh) { const col = window.CODED ? PAL[gi % PAL.length] : null; if (col) { o.material = new THREE.MeshStandardMaterial({ color: col }); legend.push(`${gi}:${o.name}=${col}`); } gi++; o.material.flatShading = true; o.material.side = THREE.DoubleSide; o.material.needsUpdate = true; } });
  window.__legend = legend;
  const box = new THREE.Box3().setFromObject(m);
  const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  const W = 1400, H = 500;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(W, H);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#9fb8d0');
  scene.add(new THREE.HemisphereLight('#fff', '#556', 1.0));
  const d = new THREE.DirectionalLight('#fff', 2.5); d.position.set(5, 10, 7); scene.add(d);
  scene.add(m);
  const names = [];
  m.traverse((o) => { if (o.isMesh) names.push(o.material.name + ':' + (o.geometry.index ? o.geometry.index.count / 3 : 0)); });
  // three views side by side: +z end, side, -z end
  const cam = new THREE.PerspectiveCamera(35, (W / 3) / H, 0.1, 100);
  const views = [[c.x, c.y + 1, c.z + 22], [c.x + 22, c.y + 2, c.z], [c.x, c.y + 1, c.z - 22]];
  renderer.setScissorTest(true);
  views.forEach((p, i) => {
    renderer.setViewport((W / 3) * i, 0, W / 3, H); renderer.setScissor((W / 3) * i, 0, W / 3, H);
    cam.position.set(...p); cam.lookAt(c); renderer.render(scene, cam);
  });
  return { size: size.toArray(), min: box.min.toArray(), names, legend };
};
