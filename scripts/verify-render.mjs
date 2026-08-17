/**
 * End-to-end verification of the rendering path in a real browser.
 *
 * MediaPipe's model is fetched from Google's CDN, which is unavailable in this
 * sandbox, so the four control points are injected through the app's debug hook
 * instead. That exercises everything downstream of the landmarks — ordering,
 * homography, triangulation, masking and the shaders — which is the part that
 * has to be right.
 *
 * The video is paused so the source frame is static, and the assertions are
 * made on real pixels read straight out of the drawing buffer:
 *   • outside the polygon, every byte must equal the unfiltered baseline
 *     (nothing leaks out of the mask);
 *   • inside the polygon, with the Negative filter, every channel must be the
 *     exact inverse of the baseline (real pixels are processed, not faked).
 */

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const SHOTS = path.join(ROOT, 'verification');
const PORT = 4317;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.json': 'application/json',
};

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function serve(dir, port) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(dir, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(dir, 'index.html');
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Content-Length': body.length,
    });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

/**
 * Injected into the page: polygon maths plus the pixel comparison, so the
 * multi-megabyte frame buffers never have to cross the CDP bridge.
 */
const PAGE_HELPERS = `
window.__vt = {
  pointInPolygon(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > p.y) !== (b.y > p.y) &&
          p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y + 1e-12) + a.x) inside = !inside;
    }
    return inside;
  },
  distToPolygon(p, poly) {
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      let t = l2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
    }
    return best;
  },
  async capture(name) {
    const d = await window.__fourFingerCam.capturePixels();
    window.__frames = window.__frames || {};
    window.__frames[name] = d;
    return d ? d.length : 0;
  },
  /**
   * mode 'invert'  -> interior must equal 255 - baseline
   * mode 'changed' -> interior must merely differ from baseline
   */
  compare(baseName, testName, quad, size, mode, margin) {
    const A = window.__frames[baseName];
    const B = window.__frames[testName];
    const { width, height } = size;
    let outsideChanged = 0, insideTotal = 0, insideOk = 0, insideBad = 0, outsideTotal = 0;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const p = { x: x + 0.5, y: y + 0.5 };
        if (this.distToPolygon(p, quad) < margin) continue;
        const i = (y * width + x) * 4;
        const same = A[i] === B[i] && A[i+1] === B[i+1] && A[i+2] === B[i+2];
        if (this.pointInPolygon(p, quad)) {
          insideTotal++;
          let ok;
          if (mode === 'invert') {
            ok = Math.abs(255 - A[i] - B[i]) <= 2 &&
                 Math.abs(255 - A[i+1] - B[i+1]) <= 2 &&
                 Math.abs(255 - A[i+2] - B[i+2]) <= 2;
          } else {
            ok = !same;
          }
          ok ? insideOk++ : insideBad++;
        } else {
          outsideTotal++;
          if (!same) outsideChanged++;
        }
      }
    }
    return { outsideChanged, outsideTotal, insideTotal, insideOk, insideBad };
  },
  /**
   * For an axis-aligned rectangular quad, the Mirror filter must make the
   * right half a reflection of the left half about the quad's vertical axis.
   */
  mirrorCheck(baseName, testName, quad, size) {
    const A = window.__frames[baseName], B = window.__frames[testName];
    const xs = quad.map((p) => p.x);
    const cx = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2;
    const { width, height } = size;
    let total = 0, ok = 0, worst = 0;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const p = { x: x + 0.5, y: y + 0.5 };
        if (p.x <= cx + 8) continue;                       // right half only
        if (!this.pointInPolygon(p, quad)) continue;
        if (this.distToPolygon(p, quad) < 6) continue;

        // Reflect the pixel CENTRE, then convert back to a (fractional) pixel
        // index and interpolate — the reflection of a centre is generally not
        // an integer index, and the shader samples bilinearly.
        const fx = 2 * cx - p.x - 0.5;
        const x0 = Math.floor(fx);
        const x1 = x0 + 1;
        const t = fx - x0;
        if (x0 < 0 || x1 >= width) continue;

        const i = (y * width + x) * 4;
        const j0 = (y * width + x0) * 4;
        const j1 = (y * width + x1) * 4;
        total++;
        let d = 0;
        for (let ch = 0; ch < 3; ch++) {
          const ref = A[j0 + ch] * (1 - t) + A[j1 + ch] * t;
          d += Math.abs(B[i + ch] - ref);
        }
        worst = Math.max(worst, d);
        if (d <= 30) ok++;
      }
    }
    return { total, ok, worst };
  },
  identical(a, b) {
    const A = window.__frames[a], B = window.__frames[b];
    if (!A || !B || A.length !== B.length) return -1;
    let n = 0;
    for (let i = 0; i < A.length; i += 4) if (A[i] !== B[i] || A[i+1] !== B[i+1] || A[i+2] !== B[i+2]) n++;
    return n;
  },
};
`;

// Normalised video coordinates, as MediaPipe would emit.
const SHAPES = {
  rectangle: [
    { x: 0.30, y: 0.28 }, { x: 0.70, y: 0.28 },
    { x: 0.70, y: 0.72 }, { x: 0.30, y: 0.72 },
  ],
  rotated: [
    { x: 0.50, y: 0.18 }, { x: 0.78, y: 0.50 },
    { x: 0.50, y: 0.82 }, { x: 0.22, y: 0.50 },
  ],
  trapezoid: [
    { x: 0.38, y: 0.24 }, { x: 0.62, y: 0.24 },
    { x: 0.82, y: 0.76 }, { x: 0.18, y: 0.76 },
  ],
  perspective: [
    { x: 0.31, y: 0.30 }, { x: 0.76, y: 0.20 },
    { x: 0.85, y: 0.78 }, { x: 0.22, y: 0.66 },
  ],
  concave: [
    { x: 0.22, y: 0.22 }, { x: 0.78, y: 0.22 },
    { x: 0.50, y: 0.54 }, { x: 0.50, y: 0.86 },
  ],
  // Scrambled ordering: the app must sort these into a simple polygon itself.
  scrambled: [
    { x: 0.72, y: 0.72 }, { x: 0.28, y: 0.28 },
    { x: 0.28, y: 0.72 }, { x: 0.72, y: 0.28 },
  ],
};

/** Filters whose design means they cannot change most of the quad. */
const MIN_CHANGED = { mirror: 0.25 };

const FILTER_IDS = [
  'neon', 'thermal', 'negative', 'vhs', 'cyberpunk', 'glitch', 'bw', 'duotone',
  'pixelate', 'blur', 'mirror', 'kaleidoscope', 'heatwave', 'posterize', 'rgbsplit',
];

const server = await serve(DIST, PORT);
fs.mkdirSync(SHOTS, { recursive: true });

const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  executablePath: fs.existsSync(PINNED) ? PINNED : undefined,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});

const context = await browser.newContext({
  viewport: { width: 900, height: 600 },
  deviceScaleFactor: 1,
  permissions: ['camera', 'microphone'],
});

const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
await page.evaluate(PAGE_HELPERS);

console.log('\n— boot —');
await page.waitForFunction(() => !!window.__fourFingerCam, null, { timeout: 20000 });
check('debug hook is exposed', true);

const running = await page
  .waitForFunction(() => window.__fourFingerCam?.getState?.().phase === 'running', null, {
    timeout: 30000,
  })
  .then(() => true)
  .catch(() => false);

const state0 = await page.evaluate(() => window.__fourFingerCam.getState());
check('engine reached the running phase', running, `phase=${state0.phase} err=${state0.error}`);
check(
  `camera stream is live (${state0.videoSize.width}x${state0.videoSize.height})`,
  state0.videoSize.width > 0 && state0.videoSize.height > 0,
);
check(
  `all ${FILTER_IDS.length} filter shaders compiled`,
  state0.shaderFailures.length === 0,
  JSON.stringify(state0.shaderFailures).slice(0, 400),
);
check(
  `drawing buffer matches the viewport (${state0.outputSize.width}x${state0.outputSize.height})`,
  state0.outputSize.width === 900 && state0.outputSize.height === 600,
);
check(
  'output dimensions are even (H.264 requirement)',
  state0.outputSize.width % 2 === 0 && state0.outputSize.height % 2 === 0,
);

if (!running) {
  console.log('\nAborting: the engine never started.\n');
  await browser.close();
  server.close();
  process.exit(1);
}

// Swap in a static high-frequency test pattern. Chromium's fake webcam is
// mostly flat, which would make resampling filters (blur, pixelate, mirror,
// RGB split) look like no-ops even when they work. Freezing it also makes
// every comparison below deterministic.
await page.evaluate(async () => {
  window.__fourFingerCam.setMarkers(false);
  window.__fourFingerCam.setPoints(null);
  window.__fourFingerCam.setFilter('negative');
  window.__fourFingerCam.setIntensity(1);
  await window.__fourFingerCam.useTestPattern();
});
await page.waitForTimeout(700);
const patternState = await page.evaluate(() => window.__fourFingerCam.getState());
check(
  `test pattern is the source (${patternState.videoSize.width}x${patternState.videoSize.height})`,
  patternState.videoSize.width === 1280 && patternState.videoSize.height === 720,
);
await page.evaluate(() => window.__fourFingerCam.freezeVideo(true));
await page.waitForTimeout(300);

const size = state0.outputSize;
await page.evaluate(() => window.__vt.capture('baseline'));
await page.waitForTimeout(400);
await page.evaluate(() => window.__vt.capture('baseline2'));
const drift = await page.evaluate(() => window.__vt.identical('baseline', 'baseline2'));
check('frozen source renders identically across frames', drift === 0, `${drift} px drifted`);

const glCanvas = page.locator('canvas.layer--gl');
await glCanvas.screenshot({ path: path.join(SHOTS, '00-baseline.png') });

async function applyShape(points) {
  await page.evaluate((pts) => window.__fourFingerCam.setPoints(pts), points);
  await page.waitForFunction(
    () => {
      const s = window.__fourFingerCam.getState();
      return s.activation === 'active' && s.opacity > 0.999;
    },
    null,
    { timeout: 6000 },
  );
  await page.waitForTimeout(80);
  return page.evaluate(() => window.__fourFingerCam.getState());
}

async function clearShape() {
  await page.evaluate(() => window.__fourFingerCam.setPoints(null));
  await page.waitForFunction(
    () => window.__fourFingerCam.getState().activation === 'idle',
    null,
    { timeout: 4000 },
  );
}

console.log('\n— mask clipping (Negative filter, exact pixel assertions) —');
for (const [name, points] of Object.entries(SHAPES)) {
  const state = await applyShape(points);
  await page.evaluate((n) => window.__vt.capture(n), name);
  await glCanvas.screenshot({ path: path.join(SHOTS, `10-mask-${name}.png`) });

  const r = await page.evaluate(
    ([n, quad, sz]) => window.__vt.compare('baseline', n, quad, sz, 'invert', 3),
    [name, state.quad, size],
  );

  check(`${name}: quad activated`, state.quad !== null);
  check(
    `${name}: nothing outside the polygon changed (${r.outsideTotal} px checked)`,
    r.outsideChanged === 0,
    `${r.outsideChanged} px leaked`,
  );
  check(`${name}: polygon covers a real area (${r.insideTotal} px)`, r.insideTotal > 2000);
  const ratio = r.insideTotal > 0 ? r.insideOk / r.insideTotal : 0;
  check(
    `${name}: interior pixels are exactly inverted (${(ratio * 100).toFixed(2)}%)`,
    ratio > 0.995,
    `${r.insideBad} interior px not inverted`,
  );

  await clearShape();
}

console.log('\n— point ordering is input-order independent —');
{
  const a = await applyShape(SHAPES.rectangle);
  await page.evaluate(() => window.__vt.capture('orderA'));
  await clearShape();

  const shuffled = [
    SHAPES.rectangle[2], SHAPES.rectangle[0],
    SHAPES.rectangle[3], SHAPES.rectangle[1],
  ];
  const b = await applyShape(shuffled);
  await page.evaluate(() => window.__vt.capture('orderB'));

  const diff = await page.evaluate(() => window.__vt.identical('orderA', 'orderB'));
  check('shuffled input renders the identical polygon', diff === 0, `${diff} px differ`);
  check(
    'quad vertices land in the same order regardless of input order',
    JSON.stringify(a.quad.map((p) => [Math.round(p.x), Math.round(p.y)])) ===
      JSON.stringify(b.quad.map((p) => [Math.round(p.x), Math.round(p.y)])),
  );
  await clearShape();
}

console.log('\n— every filter renders inside the mask only —');
const perspState = await applyShape(SHAPES.perspective);
for (const id of FILTER_IDS) {
  await page.evaluate((f) => window.__fourFingerCam.setFilter(f), id);
  await page.waitForTimeout(220);
  await page.evaluate((n) => window.__vt.capture(n), `f-${id}`);
  await glCanvas.screenshot({ path: path.join(SHOTS, `20-filter-${id}.png`) });

  const r = await page.evaluate(
    ([n, quad, sz]) => window.__vt.compare('baseline', n, quad, sz, 'changed', 3),
    [`f-${id}`, perspState.quad, size],
  );
  check(`${id}: leaves the outside untouched`, r.outsideChanged === 0, `${r.outsideChanged} px leaked`);
  const changed = r.insideTotal > 0 ? r.insideOk / r.insideTotal : 0;
  // Mirror folds the left half onto the right, so the left half is unchanged
  // by construction and the ceiling for this metric is ~50%. Its correctness
  // is asserted properly below.
  const floor = MIN_CHANGED[id] ?? 0.5;
  check(`${id}: visibly alters the inside (${(changed * 100).toFixed(0)}%)`, changed > floor);
}
await clearShape();

console.log('\n— mirror really reflects (axis-aligned quad) —');
{
  const rect = await applyShape(SHAPES.rectangle);
  await page.evaluate(() => window.__fourFingerCam.setFilter('mirror'));
  await page.evaluate(() => window.__fourFingerCam.setIntensity(1));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__vt.capture('mirrored'));
  await glCanvas.screenshot({ path: path.join(SHOTS, '21-mirror-check.png') });

  const m = await page.evaluate(
    ([quad, sz]) => window.__vt.mirrorCheck('baseline', 'mirrored', quad, sz),
    [rect.quad, size],
  );
  const ratio = m.total > 0 ? m.ok / m.total : 0;
  check(
    `right half is a reflection of the left (${(ratio * 100).toFixed(1)}% of ${m.total} px)`,
    ratio > 0.9,
    `worst channel-sum delta ${m.worst}`,
  );

  await page.evaluate(() => window.__fourFingerCam.setFilter('negative'));
  await page.evaluate(() => window.__fourFingerCam.setIntensity(1));
  await clearShape();
}

console.log('\n— activation state machine —');
{
  const settledIdle = await page
    .waitForFunction(
      () => {
        const s = window.__fourFingerCam.getState();
        return s.activation === 'idle' && s.opacity === 0;
      },
      null,
      { timeout: 4000 },
    )
    .then(() => true)
    .catch(() => false);
  const idle = await page.evaluate(() => window.__fourFingerCam.getState());
  check('returns to idle when tracking is lost', idle.activation === 'idle');
  check('opacity settles at exactly zero', settledIdle, `opacity=${idle.opacity}`);

  await page.evaluate(() =>
    window.__fourFingerCam.setPoints([
      { x: 0.500, y: 0.500 }, { x: 0.512, y: 0.500 },
      { x: 0.512, y: 0.512 }, { x: 0.500, y: 0.512 },
    ]),
  );
  await page.waitForTimeout(700);
  const tooClose = await page.evaluate(() => window.__fourFingerCam.getState());
  check('rejects fingertips bunched too close together', tooClose.activation === 'idle');

  await page.evaluate(() => window.__fourFingerCam.setPoints(null));
  await page.waitForTimeout(400);
  await page.evaluate((pts) => window.__fourFingerCam.setPoints(pts), SHAPES.rectangle);
  const immediate = await page.evaluate(() => window.__fourFingerCam.getState());
  check(
    'does not switch on at full strength on the first valid frame',
    immediate.activation !== 'active' || immediate.opacity < 1,
    `activation=${immediate.activation} opacity=${immediate.opacity}`,
  );

  await page.waitForTimeout(800);
  const settled = await page.evaluate(() => window.__fourFingerCam.getState());
  check('activates after the arming window', settled.activation === 'active');

  await page.evaluate(() => window.__fourFingerCam.setPoints(null));
  await page.waitForTimeout(150);
  const held = await page.evaluate(() => window.__fourFingerCam.getState());
  check(
    'holds the last quad through a brief dropout',
    held.opacity > 0.9 && held.quad !== null,
    `opacity=${held.opacity} activation=${held.activation}`,
  );

  const t0 = Date.now();
  const fadedOut = await page
    .waitForFunction(
      () => {
        const s = window.__fourFingerCam.getState();
        return s.activation === 'idle' && s.opacity === 0;
      },
      null,
      { timeout: 5000 },
    )
    .then(() => true)
    .catch(() => false);
  const elapsed = Date.now() - t0;
  check(`fades out after a sustained loss (${elapsed} ms)`, fadedOut);
  check('hold + fade completes within ~2 s', fadedOut && elapsed < 2200, `${elapsed} ms`);
}

console.log('\n— markers stay out of the recorded canvas —');
{
  await applyShape(SHAPES.rectangle);
  await page.evaluate(() => window.__fourFingerCam.setMarkers(false));
  await page.waitForTimeout(260);
  await page.evaluate(() => window.__vt.capture('noMarkers'));

  await page.evaluate(() => window.__fourFingerCam.setMarkers(true));
  await page.waitForTimeout(420);
  await page.evaluate(() => window.__vt.capture('withMarkers'));

  const diff = await page.evaluate(() => window.__vt.identical('noMarkers', 'withMarkers'));
  check('GL canvas is byte-identical with markers on and off', diff === 0, `${diff} px differ`);

  const overlayInk = await page.evaluate(() => {
    const c = document.querySelector('canvas.layer--overlay');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
    return n;
  });
  check('overlay canvas does draw the markers', overlayInk > 2000, `${overlayInk} px`);
  await page.screenshot({ path: path.join(SHOTS, '30-full-ui.png') });
}

console.log('\n— recording pipeline —');
{
  const rec = await page.evaluate(async () => {
    const canvas = document.querySelector('canvas.layer--gl');
    if (typeof MediaRecorder === 'undefined' || typeof canvas.captureStream !== 'function') {
      return { supported: false };
    }
    const stream = canvas.captureStream(30);
    const types = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    const supportedTypes = types.filter((t) => MediaRecorder.isTypeSupported(t));
    const chosen = supportedTypes[0] ?? '';
    const recorder = new MediaRecorder(stream, chosen ? { mimeType: chosen } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    recorder.start(200);
    await new Promise((r) => setTimeout(r, 1500));
    const blob = await new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
      recorder.stop();
    });
    stream.getTracks().forEach((t) => t.stop());
    return {
      supported: true,
      videoTracks: stream.getVideoTracks().length,
      supportedTypes,
      mimeType: recorder.mimeType,
      size: blob.size,
      chunks: chunks.length,
    };
  });

  check('canvas.captureStream + MediaRecorder are available', rec.supported === true);
  if (rec.supported) {
    check('capture stream carries exactly one video track', rec.videoTracks === 1);
    check(
      `isTypeSupported found usable formats (${rec.supportedTypes.join(', ') || 'none'})`,
      rec.supportedTypes.length > 0,
    );
    check(`recorder produced data (${(rec.size / 1024).toFixed(0)} KB, ${rec.chunks} chunks)`, rec.size > 1000);
    check(`negotiated container is ${rec.mimeType}`, typeof rec.mimeType === 'string' && rec.mimeType.length > 0);
  }
}

console.log('\n— photo capture —');
{
  const cap = await page.evaluate(async () => {
    const blob = await window.__fourFingerCam.engine.captureStill();
    return blob ? { type: blob.type, size: blob.size } : null;
  });
  check('captureStill returns an image blob', cap !== null && cap.size > 5000, JSON.stringify(cap));
  check('captured image is a JPEG', cap?.type === 'image/jpeg');
}

console.log('\n— responsive resize —');
{
  await page.setViewportSize({ width: 414, height: 896 });
  await page.waitForTimeout(900);
  const portrait = await page.evaluate(() => window.__fourFingerCam.getState());
  check(
    `drawing buffer follows a portrait viewport (${portrait.outputSize.width}x${portrait.outputSize.height})`,
    portrait.outputSize.width === 414 && portrait.outputSize.height === 896,
  );
  check(
    'portrait dimensions stay even',
    portrait.outputSize.width % 2 === 0 && portrait.outputSize.height % 2 === 0,
  );

  // A 16:9 source cover-fitted into a tall portrait canvas shows only the
  // middle ~26% of the frame's width, so use a shape that stays visible there.
  const PORTRAIT_SHAPE = [
    { x: 0.42, y: 0.30 }, { x: 0.58, y: 0.30 },
    { x: 0.58, y: 0.70 }, { x: 0.42, y: 0.70 },
  ];
  await page.evaluate((pts) => window.__fourFingerCam.setPoints(pts), PORTRAIT_SHAPE);
  await page.waitForTimeout(800);
  const afterResize = await page.evaluate(() => window.__fourFingerCam.getState());
  check('quad re-activates after a viewport change', afterResize.activation === 'active');
  const inBounds =
    afterResize.quad?.every(
      (p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 414 && p.y >= 0 && p.y <= 896,
    ) ?? false;
  check(
    'quad is remapped into the new canvas',
    inBounds,
    JSON.stringify(afterResize.quad?.map((p) => [Math.round(p.x), Math.round(p.y)])),
  );
  await page.screenshot({ path: path.join(SHOTS, '40-portrait.png') });

  await page.setViewportSize({ width: 1600, height: 500 });
  await page.waitForTimeout(800);
  const wide = await page.evaluate(() => window.__fourFingerCam.getState());
  check(
    `long edge clamped for recording quality (${wide.outputSize.width}x${wide.outputSize.height})`,
    Math.max(wide.outputSize.width, wide.outputSize.height) <= 1920,
  );
}

console.log('\n— console —');
const ignorable = (t) =>
  /hand_landmarker|mediapipe|tasks-vision|Hand tracking|Failed to load resource|net::|ERR_/i.test(t);
const realErrors = consoleErrors.filter((t) => !ignorable(t));
check('no unexpected console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
if (consoleErrors.length > realErrors.length) {
  console.log(
    `  note  ${consoleErrors.length - realErrors.length} MediaPipe/network errors ignored ` +
      '(the model CDN is blocked in this sandbox)',
  );
}

await browser.close();
server.close();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(`failing: ${failures.join(', ')}`);
console.log(`screenshots in ${path.relative(ROOT, SHOTS)}/\n`);
process.exit(failed > 0 ? 1 : 0);
