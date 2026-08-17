# Four Finger Cam

A camera app where **four of your fingertips are the four corners of a filter**.

MediaPipe tracks your hand in real time, the fingertips become a quadrilateral,
and a WebGL2 shader renders the selected effect **only inside that polygon**.
Everything outside is the untouched camera image — verified byte-for-byte, not
approximated with a CSS overlay.

```
       ●────────────●
        \  NEON     /
         \ FILTER  /
       ●────────────●
```

---

## Run it

**Fastest — no build step**

Open `four-finger-cam.html`. It is a single self-contained file.

Browsers only grant camera access on a secure origin. `file://` works in
Chrome and Firefox; if your browser refuses, serve it over localhost:

```bash
python3 -m http.server 8000     # then open http://localhost:8000/four-finger-cam.html
```

**Development**

```bash
npm install
npm run dev          # http://localhost:5173
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Type-check + production build into `dist/` |
| `npm run build:single` | Same, inlined into one portable `dist-single/index.html` |
| `npm run test:geometry` | 101 assertions on the maths (no browser needed) |
| `npm run test:render` | 88 assertions in real Chromium, incl. pixel-level mask checks |
| `npm run preview:ui` | Regenerates the UI screenshots in `verification/` |

Requires a browser with **WebGL2** and `getUserMedia` — Chrome/Edge 90+,
Safari 15+, Firefox 90+.

---

## How it works

```
camera frame
   ↓  MediaPipe Tasks Vision (hand_landmarker, GPU delegate)
21 hand landmarks
   ↓  fingertipUtils — index/middle/ring/pinky tips
4 normalised points
   ↓  One Euro filter — adaptive low-pass, per point
smoothed points
   ↓  cover-fit mapping — video space → canvas pixels
   ↓  angular sort → simple polygon, never self-intersecting
   ↓  cyclic realignment against the previous frame
   ↓  validation: separation, area, simplicity
   ↓  activation state machine: idle → arming → active → holding → fading
quadrilateral
   ↓  homography: unit square → quad, then inverted
   ↓  two triangles rasterised = the mask
   ↓  fragment shader recovers exact quad-local UVs per pixel
final WebGL canvas ──┬── screen
                     └── captureStream() → MediaRecorder → .mp4 / .webm
```

### The mask is rasterisation, not an overlay

The quad's two triangles are drawn directly. Pixels outside the polygon are
never shaded, so clipping is exact by construction. Inside, each fragment
pushes its `gl_FragCoord` through the **inverse homography** to recover where it
sits in quad space. That matters: interpolating UVs across two triangles gives
an *affine* map per triangle, which visibly kinks along the shared diagonal
whenever the quad is not a parallelogram. The projective map has no such seam,
so the effect stays glued to your fingers through rotation, shear and
perspective.

Concave quads are the one case a homography cannot express — the projective map
folds and would punch holes in the mask. Those are detected and fall back to
affine-per-triangle interpolation, with a triangulation that picks the diagonal
passing through the reflex vertex so the two triangles still tile the polygon
exactly.

Edges are antialiased in the shader: the geometry is outset by 1.5 px and
coverage is derived from the local coordinate's screen-space derivative, which
stays correct under perspective.

### Smoothing

Hand landmarks are noisy. A plain lerp trades jitter for lag. This uses the
**1€ filter** (Casiez et al., CHI 2012), which adapts its cutoff to speed —
heavy smoothing while your hand is still, almost none while it moves.

Measured on synthetic signals (`npm run test:geometry`):

- stationary jitter reduced **19.5×**
- lag during a fast sweep across the frame: **2.4% of frame width**
- lag on slow drift: **0.4%**

Note the `beta` constant is tuned for *normalised* coordinates. Published 1€
values assume pixel-scale input where speed is in the hundreds; here it is
~1000× smaller, so beta scales up to match.

### Activation

The filter does not snap on the instant four points appear:

1. four fingertips detected
2. separated enough (≥ 4% of the short edge) and enclosing ≥ 0.6% of the frame
3. points sorted into a simple polygon
4. **five consecutive valid frames** before switching on
5. a fingertip vanishing holds the last quad for **450 ms**
6. sustained loss fades out over ~800 ms

When it is not active you get *"Show four fingertips to control the filter"*, or
*"Spread your four fingertips a little wider"* when a hand is visible but the
points are bunched.

### One hand or two

| Hands | Control points |
| --- | --- |
| 1 | index, middle, ring and pinky tips — splay your fingers |
| 2 | index + pinky tip of each hand — a much larger frame |

Switching between modes resets the smoothers so the quad does not lunge.

---

## Filters

Fifteen, all GPU shaders:

Neon · Thermal · Negative · VHS · Cyber · Glitch · B&W · Duotone · Pixelate ·
Blur · Mirror · Kaleido · Heatwave · Posterize · RGB Split

Each has an intensity slider. Three use the quad's own coordinate frame rather
than the screen's, so they rotate and skew with your hand — **Pixelate**'s
mosaic grid, **Mirror**'s fold axis, and **Kaleido**'s wedges.

### Adding one

One file, one line. Create `src/filters/myfilter.ts`:

```ts
import type { FilterDef } from './types';

export const myfilter: FilterDef = {
  id: 'myfilter',
  name: 'My Filter',
  accent: ['#ff0080', '#00d4ff'],   // selector chip gradient
  animated: true,                   // uses uTime
  needsMips: false,                 // uses srcLod() above level 0
  defaultIntensity: 0.5,
  glsl: `
vec4 filterMain(vec2 local, vec2 screenUV) {
  vec3 c = src(screenUV).rgb;
  return vec4(c * vec3(1.0, 0.5, 2.0), 1.0);
}`,
};
```

Then add it to the array in `src/filters/index.ts`. The renderer compiles and
caches programs on demand and the selector rail is generated from the registry.

Available inside `filterMain`:

| | |
| --- | --- |
| `local` | position in the quad, `[0,1]²`, perspective-correct, corner 0 at `(0,0)` |
| `screenUV` | position on the canvas, `[0,1]²` |
| `src(uv)` | camera pixel at a screen UV (aspect-correct, mirror-aware, always LOD 0) |
| `srcLod(uv, lod)` | same through the mip chain — set `needsMips: true` |
| `localToScreenUV(l)` | quad space back to screen, for resampling in quad space |
| `uTime` `uIntensity` `uResolution` `uQuadPx` `uH` `uInvH` | uniforms |
| `luma` `hash12` `vnoise` `fbm` `rot2` `rgb2hsv` `hsv2rgb` `contrast` | helpers |

---

## Recording

```
camera → hand tracking → filter engine → WebGL canvas
                                            │
                            ┌───────────────┴───────────────┐
                            ▼                               ▼
                          screen                 captureStream() → MediaRecorder
```

One render pass feeds both the screen and the recorder — no duplicate work.

**The fingertip markers and polygon guides are never in the file.** They are
painted on a *separate* 2D canvas stacked above the WebGL one, and
`captureStream()` only taps the WebGL canvas. The render test asserts the GL
canvas is byte-identical with markers on and off.

- Container chosen at runtime via `MediaRecorder.isTypeSupported()`, MP4/H.264
  first (drops straight into Photos, iMessage, any editor), WebM as fallback
- 30 fps, or 60 when the loop is actually keeping up
- Bitrate ~0.12 bits/pixel/frame, clamped to 6–24 Mbps
- Microphone optional, merged as a second track; denial records silently
- Drawing buffer is kept even-dimensioned because H.264 cannot encode odd sizes
- After stopping: preview player with **Save**, **Share** (Web Share API where
  supported), **Delete**, **Record again**

The photo button captures the same composite as a JPEG, read back inside the
same animation frame so the context does not need `preserveDrawingBuffer`.

### Framing

The drawing buffer matches the **visible area's** aspect ratio, and the camera
is fitted into it with a cover mapping — filled on the short axis, cropped
symmetrically on the long one, **never stretched**. So the recording is exactly
the composition on screen. The long edge is capped at 1920 px, which puts
phone-portrait output at 1080p class.

---

## Performance

- Two draw calls per frame: full-screen camera, then the quad
- No React state touched in the frame loop — it is plain imperative code over
  refs, and status is pushed out only when something the UI shows changes
- Hand detection runs at the camera's frame rate (typically 30 Hz) while
  rendering runs at display rate; if detection cost exceeds 22 ms it drops to
  every other frame and the smoother covers the gap
- Blur and bloom use `generateMipmap` + `textureLod` — WebGL2 allows mipmaps on
  non-power-of-two textures, which is far cheaper than a separable kernel. Mips
  are only generated for filters that ask
- `texSubImage2D` after the first allocation instead of reallocating per frame
- Shader programs are compiled once at startup and cached by filter id

---

## Verification

Two suites, both runnable offline.

**`npm run test:geometry` — 101 assertions.** Clockwise sorting across all 24
permutations of 6 shapes, self-intersection, triangulation area conservation
(including concave), point-in-polygon, homography corner mapping, agreement
between the closed-form and 8×8 solvers, inverse round-trip (max error 1e-15),
`H·H⁻¹ = I`, degenerate-input rejection, outset properties, 1€ filter response.

**`npm run test:render` — 88 assertions in real Chromium.** The camera is
replaced with a frozen high-frequency test pattern and the four points are
injected through a debug hook, then pixels are read straight out of the drawing
buffer:

- for six quad shapes — rectangle, rotated, trapezoid, perspective, concave,
  and a deliberately scrambled input order — **every** pixel outside the polygon
  is byte-identical to the unfiltered baseline, and **100.00%** of interior
  pixels are the exact complement under the Negative filter
- all 15 shaders compile; each one visibly changes the interior and leaves the
  exterior untouched
- Mirror's right half matches a bilinear reflection of its left half at 100%
- shuffled input points produce a pixel-identical polygon
- the activation machine arms, holds through a 150 ms dropout, and fades to
  exactly zero after a sustained loss
- the GL canvas is unchanged with markers on vs. off
- `captureStream` + `MediaRecorder` negotiate a format and produce data
- the buffer follows portrait/landscape resizes, stays even-dimensioned, and
  clamps its long edge

Screenshots land in `verification/`.

> The MediaPipe model is fetched from Google's CDN, which is unreachable from
> the sandbox these tests were written in, so the render suite injects the four
> points rather than detecting a hand. Everything downstream of the landmarks —
> the part that has to be right — is exercised.

---

## Layout

```
src/
├── components/       CameraView, FilterSelector, FingerPoints, Controls,
│                     RecordButton, RecordingPreview, StatusOverlay
├── handTracking/     HandTracker (MediaPipe), fingertipUtils
├── filters/          15 shader modules + registry
├── rendering/        WebGLRenderer, OverlayPainter, perspective, shaders/
├── recording/        VideoRecorder, mimeSupport
├── camera/           CameraManager
├── engine/           FilterEngine — the frame loop
├── utils/            geometry, smoothing, share
├── App.tsx
└── main.tsx
```

`main.tsx` deliberately skips `StrictMode`: its development double-invoke would
start, tear down and restart `getUserMedia` and the WebGL context on every
mount, which real cameras do not enjoy.

### Assets

MediaPipe's WASM runtime is vendored into `public/mediapipe/wasm` so the dev
server works offline; the CDN is the fallback and the only source for the
single-file build. The ~7.8 MB `hand_landmarker.task` model always comes from
Google's CDN — drop a copy at `public/models/hand_landmarker.task` to serve it
yourself.

### Debug hook

`window.__fourFingerCam` exposes `setPoints`, `setFilter`, `setIntensity`,
`setMarkers`, `freezeVideo`, `useTestPattern`, `capturePixels` and `getState` —
useful for driving the quad without a camera-visible hand.

---

## Known limits

- Hand tracking needs the CDN on first load (~8 MB model, then cached)
- MediaPipe detects hands across the **full sensor frame**, including the region
  cropped away by the cover fit, so a fingertip outside the visible area can pull
  a corner off-screen. It clips cleanly; just keep your hand in view.
- Safari records MP4 only; some older Chrome builds record WebM only. Handled,
  but the file extension you get depends on the browser.
- `desynchronized: true` on the GL context lowers latency but can, on some
  drivers, make tearing visible during very fast motion.
