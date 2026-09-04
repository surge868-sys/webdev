# BRIDGE STRIKE!

A mobile-first browser game about hauling an oversized load into a prairie city without smashing it into an overpass.

- `npm run dev` — Next.js app, game at `/`
- `npm run bundle` — single-file build at `dist/clearance.html` (esbuild)
- `npm run verify` — headless Playwright check: screenshots + plate-reading bot (`verify/`)

See `PLAN.md` for the technical plan and milestone list.

## Deploy to Vercel

The app is a standard Next.js App Router project with no server-side dependencies yet
(leaderboards, daily seed and share pages arrive with the Supabase milestone).

1. Push this branch and import the repo at vercel.com/new. Framework preset: Next.js. No env vars needed.
2. Optional: set `NEXT_PUBLIC_SITE_URL` to your production URL so Open Graph links are absolute.
3. `vercel.json` adds immutable cache headers for the model, audio and font files in `public/`.

Assets shipped from `public/`: `models/peterbilt.glb` (644 KB, meshopt), `audio/*.mp3` (1.7 MB), `fonts/*.woff2` (40 KB), `og.png`.

Local check: `npm run build && npm start`, then open http://localhost:3000.
