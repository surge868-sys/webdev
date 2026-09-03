# BRIDGE STRIKE! (was CLEARANCE 3D) — technical plan

Rebuild #2 (after M1 review): high-fidelity look (PBR + procedural maps, sky shader, env reflections,
soft shadows, time-of-day), hold-to-brake replaces hold-to-lower, Saskatoon / Circle Drive on the signs,
everything else fictional.

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
- origin = rear of the trailer (nearest camera). Drawn step-deck spans 0 … 12.5; the steel truss
  occupies **[1.0, 13.5]** — the collision span (it overhangs the neck, on purpose). Tractor sits at 11.2 … 18.
- Round piers r = 0.36 at x = ±1.9; truss half-width 1.45 → 9 cm of pier slack at lane centre. A lane
  change must be complete before the deck.
- Bridge deck occupies world `[b.z, b.z + b.depth]`. Load is under the deck when
  `dist + 1.7 < b.z + depth` and `dist + 10.3 > b.z`.
- Effective top `hEff = loadH + swayLift + gustLift + potholeBounce`, where `swayLift = 1.6·|sin θ|` and θ is
  the load's roll from a driven oscillator (k=4, c=0.55; braking c=4.5; speed² and hammer-down excite it;
  lane changes kick it). Verbs: swipe lane · HOLD to lower the load 0.30 m on the hydraulics (air tank 4.2 s
  drain / 5.0 s refill / relock at 20%; a lowered load is also a steady load) · swipe ▼ HAMMER DOWN
  (1.35× speed, 2× score, 2.2× sway). Effective top = loadH − lowered + swayLift + gust + pothole.

## Loads (the 2026 Saskatoon strikes, in order of stupidity)

| # | load | top | span (m ahead of trailer rear) | strike |
|---|---|---|---|---|
| 0 | Caterpillar track hoe (tutorial) | 4.75 | 1.5 – 10.5 | Mar 5 · Circle Dr / Hwy 11, posted 4.7 m, $283k, $11,200 fine |
| 1 | excavator, over-height | 4.90 | 1.5 – 10.5 | Mar 11 · 108th Street, ~$350k |
| 2 | heavy equipment | 5.05 | 1.5 – 10.5 | Mar 22 · CPKC rail overpass + McKercher Drive |
| 3 | grain bin | 5.20 | 4.5 – 9.5 | Jul 24 · 51st Street / Idylwyld |
| 4 | farm equipment | 5.35 | 1.0 – 13.0 | Sep 2 · CPKC rail bridge near Borden Bridge |

Upgrades at 400 m then every 1600 m, deferred while any uncleared bridge is within 60 m; bridges beyond
230 m regenerate for the new height, bridges in view get one lane bumped to survivable if none was.
Fail card shows a city repair estimate (real figures: $283k, $350k) and the $11,200 fine.
- Under deck: `hEff > lane.clear` → BRIDGE STRIKE. `|laneX − laneCentre| > 0` with the load's
  half-width (1.3 m) crossing a pier line (x = ±1.9) → PIER STRIKE. Piers are 0.5 m wide, so
  the strike condition is `|laneX| + 1.3 > 1.9 − 0.25` i.e. `|laneX| > 0.35` while under a
  stepped bridge... which is too harsh for lane changes mid-lane. Use: strike when the load
  span [laneX−1.3, laneX+1.3] overlaps a pier's [±1.9 − 0.25, ±1.9 + 0.25]. Lane centres at
  ±3.8 and 0 give 0.35 m of slack either side, so a completed lane change is safe, a half-way
  change is not. Rail bridges have no interior piers.
- Wind-blade load (M4) extends the span to [−6, 10.3].

## Tuning constants (from brief, do not rediscover)

lanes x = −3.8/0/3.8, road half-width 5.7, lane lerp 5/s · brake 0.45× · hammer 1.35× speed 2× score ·
clearance tiers vs steady height h: graze h+0.03…0.08 (fits only steady, 45% of solutions), easy h+0.15…0.40; decoys: second graze lane 45% else h−0.85…−0.55 · speed 16 + 0.012/m cap 36 ·
spacing 55 first, then 108 + rand·55, −0.015/m, floor 78; depth 9–14 · shave <10 cm, chain ×3→×5→×7→×9→×10 for 200 m ·
camera 5.6 up / 12.6 back; FOV 62 portrait / 52 landscape · loads 3.9…5.8 every 1.6 km (first at 400 m).

## Milestones

M1 vertical slice → M2 feel/missions → M3 world/atmosphere → M4 content → M5 social. One commit each,
a `dist/clearance.html` esbuild bundle published as an artifact after each, verified with `scripts/verify.mjs`.
