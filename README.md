# Orrery

An interactive solar system you can fly through. Real orbits, real scale, and
every planetary surface generated on your GPU at load — there is not a single
image file in the build.

```bash
npm install
npm run dev
```

---

## What it is

Nine worlds plus the Sun, Pluto and a dozen major moons, propagated from
[JPL/Standish Keplerian elements][jpl] with secular rates. Click any body and the
camera flies to it. Drag to orbit, scroll to zoom, drag the scale slider to watch
the comfortable "textbook" spacing morph into the real, terrifying distances.

Two voices for everything: **Explorer** is written for a curious child, and
**Scientist** swaps in real units, orbital elements and mechanisms. The mode
changes the words and the numbers, never the layout.

[jpl]: https://ssd.jpl.nasa.gov/planets/approx_pos.html

## Three decisions that shaped it

**Every surface is procedural.** No textures are downloaded or bundled. At load,
each body's surface is rendered once into a cube map by an archetype shader —
rocky, terran, gas giant, ice giant, ice moon, volcanic, star — and then sampled
as an ordinary texture. Six-plus octaves of warped 3D noise per fragment is fine
on a desktop GPU and a hard failure on a phone; doing it once costs a few frames
and buys two texture fetches per pixel forever after.

The thing that makes it read as _those_ planets rather than as procedural mush is
that the landmarks are **hand-placed analytic primitives at their real
coordinates**, with noise only as connective tissue. The Great Red Spot is an
ellipse at 22°S whose sampling domain rotates with distance from its centre, so
it shears like a vortex. Valles Marineris is a polyline across Mars's equator.
The Cassini division is at 117,580–122,170 km because that is where it is.

**React never renders during animation.** The simulation is a plain-TypeScript
layer that mutates `Object3D`s from a single `useFrame`. `SimClock` deliberately
ships no React binding at all, so there is no hook to reach for — anything the
interface needs to display goes through a 10 Hz channel that writes
`textContent` directly. A live distance readout costs zero React commits.

**Nothing about the lighting uses a scene light.** One shared `DirectionalLight`
cannot light a 30 AU scene: its direction is only right for one body at a time.
Instead each material derives the sun direction in its own object space, with a
terminator whose softness comes from the Sun's actual angular radius at that
distance (half a degree from Earth, twenty arcseconds from Neptune). Ring
shadows are analytic too — one ray-plane intersection and a 1-D texture fetch,
which gives a razor-sharp Cassini-division shadow at any zoom that no shadow map
could manage.

## Production notes

- **First-run fly-in.** The first visit glides in from a high, wide view once the
  bake finishes; it is skipped on later visits and under reduced motion.
- **Graceful failure.** No WebGL 2, or a lost GPU context mid-session, shows a
  clear reload card rather than a blank page. Render errors hit the error boundary.
- **Quality tiers.** `minimal` through `ultra` scale DPR, bake size, bloom,
  MSAA, asteroids and atmosphere steps together; the adaptive controller steps
  tiers on p95 frame time. Force one with `?tier=high`.
- **Offline.** A service worker precaches the shell, so the app reopens offline.
- **Accessibility.** Visible focus rings, a screen-reader description of the
  canvas, keyboard shortcuts for time and panels, and `prefers-reduced-motion`
  disables the intro, springs and grain.

## Controls

|                |                                       |
| -------------- | ------------------------------------- |
| Drag           | Orbit                                 |
| Scroll / pinch | Zoom                                  |
| Click a body   | Fly to it                             |
| `Space`        | Play / pause time                     |
| `←` `→`        | Step a day (hold `Shift` for a month) |
| `[` `]`        | Previous / next world                 |
| `0`–`9`        | Jump to a world                       |
| `T`            | Toggle true scale                     |
| `O` / `L`      | Orbit paths / labels                  |
| `F`            | Free flight                           |
| `H`            | Back to today                         |
| `` ` ``        | Performance overlay                   |

## Accuracy

Positions come from Standish's approximate Keplerian elements with per-century
secular rates. They are good to roughly an arcminute between **1800 and 2050**;
outside that window the date readout is marked _Extrapolated_ rather than
quietly presenting extrapolation as fact.

Body radii, masses, rotation periods, obliquities and compositions are real. The
_displayed_ sizes and orbital distances are not — at true scale Mercury sits
inside the Sun's disc and Neptune is off screen. The scale slider interpolates
continuously between the artistic layout and the real one, so you can see exactly
how much is being cheated.

## Performance

The target is 120 fps on a desktop GPU and 60 on a mid-range phone, held by an
adaptive controller that watches the **p95** frame time (not the mean — a mean
hides exactly the hitches you notice) and steps quality up and down with
hysteresis: DPR first, then post-processing, then geometry detail, then instance
counts. Press `` ` `` to watch it work.

> **What has and has not been measured.** The visual results here were verified
> by rendering in headless Chromium, which uses SwiftShader — software
> rasterisation. Every shader is confirmed to compile and produce the intended
> image, and the structural budgets (draw calls, zero React commits per frame,
> zero allocation in the frame loop) are asserted in the test suite. Absolute
> frame rate on real GPU hardware is **not** measured here; check it yourself
> with the performance overlay.

## Development

```bash
npm run dev          # dev server
npm run build        # typecheck + production build
npm run lint
npm run test         # vitest: ephemeris, springs, quality controller
npm run test:e2e     # playwright: rendering, budgets, interaction
```

The e2e suite needs a Chromium with working WebGL2. If your environment ships
one Playwright did not install itself, point at it:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome npm run test:e2e
```

`?tier=ultra|high|balanced|efficient|minimal` forces a quality tier, which is
how you exercise the bloom and atmosphere paths on a software renderer.

### Layout

```
src/
  sim/        clock, ephemeris, world state, floating origin, springs
  scene/      the single useFrame driver, scene graph, picking, composer
  gfx/        bakery (procedural cube maps), shaders, materials, geometry
  camera/     orbit / follow / free-flight rig
  perf/       device probe, quality tiers, adaptive controller
  state/      discrete UI store, 10 Hz telemetry channel
  data/       body definitions and dual-track copy
  ui/         design system, panels, jog wheel, labels
  audio/      Web Audio synthesis (no asset files)
tools/        screenshot + tour harnesses used to verify the render
```

## License

MIT.
