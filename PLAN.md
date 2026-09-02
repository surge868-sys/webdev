# CLEARANCE 3D — technical plan

## File structure

```
src/app/layout.tsx            Oswald via next/font, viewport meta, sw registration (M5)
src/app/page.tsx              Server shell -> <GameMount/> (client, dynamic import of game3d)
src/app/game-mount.tsx        'use client': dynamic(() => import('@/game3d/game')), startGame(root) -> cleanup
src/game3d/game.ts            THE GAME. One self-contained module: startGame(root): () => void
                              (three imported here only; esbuild bundles this file alone into dist/clearance.html)
scripts/bundle.mjs            esbuild -> dist/clearance.html (single file, inline JS, standalone shell)
scripts/verify.mjs            Playwright + SwiftShader: screenshots, bot run, hooks (window.__game / __gameWarp)
supabase/schema.sql, SETUP.md (M5)   src/app/api/og/run/[id], src/app/r/[id] (M5)
```

Later milestones may split `game.ts` into `world.ts`, `loads.ts`, `audio.ts`, `text.ts` — but all under
`src/game3d/` with `game.ts` the single entry so the esbuild bundle stays one file.

## State shape (single mutable `G` object, read-only snapshot via `window.__game()`)

```
G = {
  phase: 'title' | 'run' | 'crash' | 'fail' | 'permit',
  dist (m travelled), speed (m/s base), throttle (bool), mult, score (km),
  lane (0..2 target), laneX (current x, lerped), leanVel,
  hold (bool), lowered (m, 0..0.40), lowerVel (spring), air (0..1), airLocked,
  loadIndex, loadH (resting top height), gustLift, potholeBounce,
  bridges: Bridge[] (ring, sorted by z), nextBridgeIdx,
  shave: {chain, untilDist}, cleared, waypoint, dispatch, tod (0..1),
  rng: {world: Mulberry32(seed), fx: Mulberry32(seed^0x9e37)}   // separate streams
  cam: 'chase' | 'dolly'
}
Bridge = { z (world metre of deck near face), depth, lanes:[{clear}], kind:'girder'|'steel'|'rail',
           name, cleared:boolean, meshes, plates[], lamps[] }
```

## World scroll / recycling

Truck sits at scene origin, facing −Z (away from camera at +Z). Every scenery item stores a
world-metre `w`. Scene position each frame: `z = -(w - G.dist)`. Items whose `w < G.dist - 30`
(behind camera) are recycled: `w += poolLength` (scenery) or regenerated ahead (bridges, spawned
by the generator at the next spacing distance and recycled from a pool of 6). Road is a
single long plane with a scrolling stripe texture offset (`map.offset.y = dist / stripeLen`).
Geometry is shared; per-item meshes are instanced-by-reuse (pools), never allocated at runtime
after warm-up. One shadow-casting directional light; MeshLambert flat shaded.

## Collision spans vs drawn truck

Along the truck's forward axis (−Z), measured in metres ahead of the origin:
- origin = rear bumper of the trailer (nearest camera). Drawn trailer bed spans 0 … 12.0,
  load box occupies **[1.7, 10.3]** — the collision span. Cab spans 12.2 … 15.5.
- Bridge deck occupies world `[b.z, b.z + b.depth]`. Load is under the deck when
  `dist + 1.7 < b.z + depth` and `dist + 10.3 > b.z`.
- Effective top `hEff = loadH − lowered + gustLift + potholeBounce`.
- Under deck: `hEff > lane.clear` → BRIDGE STRIKE. `|laneX − laneCentre| > 0` with the load's
  half-width (1.3 m) crossing a pier line (x = ±1.9) → PIER STRIKE. Piers are 0.5 m wide, so
  the strike condition is `|laneX| + 1.3 > 1.9 − 0.25` i.e. `|laneX| > 0.35` while under a
  stepped bridge... which is too harsh for lane changes mid-lane. Use: strike when the load
  span [laneX−1.3, laneX+1.3] overlaps a pier's [±1.9 − 0.25, ±1.9 + 0.25]. Lane centres at
  ±3.8 and 0 give 0.35 m of slack either side, so a completed lane change is safe, a half-way
  change is not. Rail bridges have no interior piers.
- Wind-blade load (M4) extends the span to [−6, 10.3].

## Tuning constants (from brief, do not rediscover)

lanes x = −3.8/0/3.8, road half-width 5.7, lane lerp 5/s · duck 0.40 m in 0.2 s, spring k=8 c=5 ·
air 4.2 s drain, 5.0 s refill, lock until 20% · throttle 1.35× speed 2× score · speed 16 + 0.012/m cap 36 ·
spacing 55 first, then 108 + rand·55, −0.015/m, floor 78; depth 9–14 · shave <10 cm, chain ×3→×5→×7→×9→×10 for 200 m ·
camera 5.6 up / 12.6 back; FOV 62 portrait / 52 landscape · loads 3.9…5.8 every 1.6 km (first at 400 m).

## Milestones

M1 vertical slice → M2 feel/missions → M3 world/atmosphere → M4 content → M5 social. One commit each,
a `dist/clearance.html` esbuild bundle published as an artifact after each, verified with `scripts/verify.mjs`.
