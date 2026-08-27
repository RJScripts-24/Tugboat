# Tugboat — Frontend

Next.js 15 (App Router) + TypeScript + Tailwind v4 front end for **Tugboat**, the
AI revenue recovery agent (Razorpay AI Buildathon, Track 03). See
`../docs/TUGBOAT-Track3-PRD.md` for the product spec.

## Run

The Control Tower is API-backed: start the backend first (`cd ../backend && npm run dev`,
see `../backend/.env.example`), then:

```bash
cp .env.local.example .env.local   # API_URL + NEXT_PUBLIC_API_URL, both http://localhost:4000 by default
npm install
npm run dev      # http://localhost:3000
npm run build && npm run start
```

Sign in with the seeded demo merchant (`demo@tugboat.dev` / `tugboat-demo`) or the
"Try the demo" door — both are real logins against the API; the session is an
httpOnly cookie set by the Next route (`src/app/api/auth/login/route.ts`).

## What is built

| Route | Status |
|---|---|
| `/` | Landing page — replica of `design/landing.png`, hero illustration replaced by looping video; the KPI band reads `GET /simulations/headline` |
| `/login` | Sign-in (credentials or demo) — proxies to the API and sets the session cookie |
| `/dashboard` | Control Tower — KPIs, funnel, live Boa activity feed, root causes, gateway health, working list |
| `/cases`, `/cases/[id]` | Recovery Pipeline and Case Detail (timeline, bounds, ledger, manual overrides) |
| `/approvals` | Approvals Queue — pending cards, history, stats |
| `/simulation` | Simulation Lab — configure, watch a real batch run over the socket, read the evidence report |
| `/policies` | Policies & Guardrails — the pack in force, revisions, firing counts |
| `/audit` | Audit Explorer — the hash-chained ledger, verified in the browser |

Which endpoints and socket events each page uses, and where its state lives, is
recorded page by page in `../docs/FRONTEND-MAP.md`.

## Structure

```
src/app/               layout (fonts + metadata), globals.css (design tokens), page.tsx
src/components/landing/
  site-header.tsx      wordmark + Login, blurs in on scroll
  hero.tsx             headline + CTA + trust strip over the looping video plate
  what-tugboat-does.tsx  the five-stage pipeline cards (Detect → Measure)
  boa-stats.tsx        Boa avatar + KPI band
  trusted-by.tsx       partner strip
  icons.tsx            all stage / UI icons as inline SVG
  brand-marks.tsx      partner wordmarks (drawn in-house, no external assets)
scripts/               shot.js, compare.sh — screenshot + mockup-diff dev tooling
```

Design tokens live in `src/app/globals.css` under `@theme`. Colour semantics follow
PRD §6.4: **green = money recovered only**, amber = waiting, red = halted, blue =
diagnosis, teal = promise.

## Hero video pipeline

`design/Hero_video.mp4` is not used directly. `public/media/hero-tugboat.mp4` is
derived from it, and is regenerated with:

```bash
CLEAN="[0:v]delogo=x=1130:y=570:w=56:h=58,split=2[b][p];[p]crop=150:150:1085:530,gblur=sigma=11,format=yuva444p,geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':a='255*min(1,min(min(X,W-1-X),min(Y,H-1-Y))/38)'[pf];[b][pf]overlay=x=1085:y=530[s1];color=c=black:s=110x130:d=10:r=24,format=yuva444p,geq=lum=8:cb=128:cr=128:a='78*max(0,1-hypot((X-W/2)/(W/2),(Y-H/2)/(H/2)))'[dk];[s1][dk]overlay=x=1090:y=530:shortest=1,format=yuv420p,split=2[body][pre];[body]trim=start=1,setpts=PTS-STARTPTS[bodyt];[pre]trim=end=1,setpts=PTS-STARTPTS[pret];[bodyt][pret]xfade=transition=fade:duration=1:offset=8[v]"

ffmpeg -y -i ../design/Hero_video.mp4 -filter_complex "$CLEAN" -map "[v]" -an   -c:v libx264 -profile:v high -level 4.0 -crf 24 -preset slow   -pix_fmt yuv420p -r 24 -movflags +faststart   public/media/hero-tugboat.mp4
```

That does three things:

1. **Removes the Gemini watermark** (bottom-right sparkle) — `delogo` kills the
   bright mark, then a feathered blur patch plus a soft dark blob dissolve the
   interpolation streak into the existing vignette.
2. **Makes it loop seamlessly** — the last second is cross-faded onto the first,
   yielding a 9s clip whose wrap-around frames are *closer* to each other
   (PSNR 26.3 dB) than two adjacent mid-clip frames (20.2 dB), so no visible jump.
3. **Strips the audio track** and encodes for web (faststart, ~1.6 MB).

Other derived assets: `tugboat-logo.png` / `tugboat-mark.png` (from `design/logo.png`),
`boa-avatar.png` (circular crop of the cleaned footage), `hero-tugboat-poster.jpg`.

## Design-fidelity tooling

```bash
node scripts/shot.js out.png 1440              # full-page screenshot (pins video to frame 0)
scripts/compare.sh out.png cmp.png 0 130 470 560 2   # mockup above, render below
```
