/**
 * Captures representative UI screenshots against Chromium's fake camera, which
 * is far closer to a real scene than the high-frequency test pattern the
 * correctness suite uses.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'verification');
const PORT = 4318;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };

const server = await new Promise((resolve) => {
  const s = http.createServer((req, res) => {
    let file = path.join(DIST, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(DIST, 'index.html');
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  });
  s.listen(PORT, () => resolve(s));
});

const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  executablePath: fs.existsSync(PINNED) ? PINNED : undefined,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});

const SHAPE = [
  { x: 0.30, y: 0.30 }, { x: 0.72, y: 0.24 },
  { x: 0.78, y: 0.74 }, { x: 0.26, y: 0.70 },
];

const VIEWS = [
  { name: 'phone', width: 390, height: 844, filter: 'neon' },
  { name: 'desktop', width: 1280, height: 800, filter: 'thermal' },
];

fs.mkdirSync(OUT, { recursive: true });

for (const view of VIEWS) {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 2,
    permissions: ['camera', 'microphone'],
  });
  const page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__fourFingerCam?.getState?.().phase === 'running', null, {
    timeout: 30000,
  });
  await page.evaluate(
    ([f, pts]) => {
      window.__fourFingerCam.setFilter(f);
      window.__fourFingerCam.setMarkers(true);
      window.__fourFingerCam.setPoints(pts);
    },
    [view.filter, SHAPE],
  );
  await page.waitForTimeout(1600);
  await page.screenshot({ path: path.join(OUT, `ui-${view.name}.png`) });
  console.log(`captured ui-${view.name}.png`);
  await context.close();
}

await browser.close();
server.close();
