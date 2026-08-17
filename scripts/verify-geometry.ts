/**
 * Geometry + homography verification.
 * Run: npm run test:geometry   (node --experimental-strip-types)
 */
import {
  sortClockwise,
  signedArea,
  polygonArea,
  isSelfIntersecting,
  pointInPolygon,
  isConvex,
  triangulateQuad,
  minPairwiseDistance,
  outsetPolygon,
  alignCyclicOrder,
  centroid,
  quadExtent,
  type Quad,
  type Vec2,
} from '../src/utils/geometry.ts';
import {
  unitSquareToQuad,
  computeHomography,
  invertMat3,
  applyMat3,
  multiplyMat3,
} from '../src/rendering/perspective.ts';
import { OneEuroFilter, PointSmoother } from '../src/utils/smoothing.ts';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

function approxPt(a: Vec2, b: Vec2, eps = 1e-5): boolean {
  return approx(a.x, b.x, eps) && approx(a.y, b.y, eps);
}

const P = (x: number, y: number): Vec2 => ({ x, y });

const SHAPES: Record<string, Quad> = {
  rectangle: [P(100, 100), P(400, 100), P(400, 320), P(100, 320)],
  rotated: [P(250, 80), P(430, 250), P(250, 420), P(70, 250)],
  trapezoid: [P(180, 100), P(360, 100), P(460, 340), P(80, 340)],
  perspective: [P(200, 120), P(430, 90), P(490, 360), P(140, 330)],
  irregular: [P(120, 140), P(400, 90), P(470, 400), P(90, 300)],
  thin: [P(100, 200), P(500, 190), P(500, 240), P(100, 250)],
};

console.log('\n— point ordering —');
{
  // Deliberately scrambled input, including the order that produces a bowtie.
  const scrambled: Vec2[] = [P(400, 320), P(100, 100), P(100, 320), P(400, 100)];
  check('scrambled input self-intersects before sorting', isSelfIntersecting(scrambled));
  const sorted = sortClockwise(scrambled);
  check('sorted quad is simple', !isSelfIntersecting(sorted));
  check('sorted quad winds clockwise on screen', signedArea(sorted) > 0);
  check('area preserved', approx(polygonArea(sorted), 300 * 220, 1e-6));

  // Every permutation of every shape must sort to a simple polygon.
  let allSimple = true;
  let allSameArea = true;
  for (const [, quad] of Object.entries(SHAPES)) {
    const target = polygonArea(sortClockwise(quad));
    const perms = permutations([0, 1, 2, 3]);
    for (const perm of perms) {
      const s = sortClockwise(perm.map((i) => quad[i]));
      if (isSelfIntersecting(s)) allSimple = false;
      if (!approx(polygonArea(s), target, 1e-6)) allSameArea = false;
    }
  }
  check('all 24 permutations x 6 shapes sort to a simple polygon', allSimple);
  check('area is permutation-invariant', allSameArea);
}

console.log('\n— cyclic alignment stability —');
{
  const base = sortClockwise(SHAPES.rectangle);
  // Same polygon, rotated start vertex — alignment should undo the rotation.
  const rotated = [base[2], base[3], base[0], base[1]];
  const aligned = alignCyclicOrder(rotated, base);
  check(
    'rotated ordering realigns to reference',
    aligned.every((p, i) => approxPt(p, base[i])),
  );
}

console.log('\n— convexity + triangulation —');
{
  check('rectangle is convex', isConvex(SHAPES.rectangle));
  check('perspective quad is convex', isConvex(SHAPES.perspective));

  // A concave quad: one vertex pulled inside the triangle of the other three.
  const concaveRaw: Vec2[] = [P(100, 100), P(400, 100), P(250, 200), P(250, 400)];
  const concave = sortClockwise(concaveRaw) as unknown as Quad;
  check('concave quad detected', !isConvex(concave));
  check('concave quad is still simple after sorting', !isSelfIntersecting(concave));

  for (const [name, quad] of Object.entries({ ...SHAPES, concave })) {
    const tris = triangulateQuad(quad as Quad);
    const total = tris.reduce((sum, [a, b, c]) => {
      return sum + polygonArea([quad[a], quad[b], quad[c]]);
    }, 0);
    check(
      `triangulation of ${name} covers the polygon exactly`,
      approx(total, polygonArea(quad), 1e-6),
      `tri=${total.toFixed(4)} poly=${polygonArea(quad).toFixed(4)}`,
    );
  }
}

console.log('\n— point in polygon —');
{
  const q = SHAPES.rectangle;
  check('centre is inside', pointInPolygon(P(250, 210), q));
  check('outside point is outside', pointInPolygon(P(50, 50), q) === false);
  check('far right is outside', pointInPolygon(P(1000, 210), q) === false);

  const persp = SHAPES.perspective;
  check('centroid of perspective quad is inside', pointInPolygon(centroid(persp), persp));
  check('point beyond a slanted edge is outside', pointInPolygon(P(20, 20), persp) === false);
}

console.log('\n— homography: unit square -> quad —');
{
  const unit: Quad = [P(0, 0), P(1, 0), P(1, 1), P(0, 1)];
  for (const [name, quad] of Object.entries(SHAPES)) {
    const H = unitSquareToQuad(quad);
    check(`${name}: homography solved`, H !== null);
    if (!H) continue;

    const cornersOk = unit.every((u, i) => approxPt(applyMat3(H, u), quad[i], 1e-6));
    check(`${name}: maps unit-square corners onto the quad`, cornersOk);

    const G = computeHomography(unit, quad);
    // Both solvers are normalised with i = 1, so entries must match directly.
    const sameAsGeneral = G !== null && H.every((v, i) => approx(v, G[i], 1e-6));
    check(`${name}: closed form agrees with the 8x8 solver`, sameAsGeneral);

    const Hinv = invertMat3(H);
    check(`${name}: homography is invertible`, Hinv !== null);
    if (!Hinv) continue;

    // Round trip: screen -> local -> screen for a grid of interior points.
    let maxErr = 0;
    for (let i = 1; i < 10; i++) {
      for (let j = 1; j < 10; j++) {
        const local = P(i / 10, j / 10);
        const screen = applyMat3(H, local);
        const back = applyMat3(Hinv, screen);
        maxErr = Math.max(maxErr, Math.hypot(back.x - local.x, back.y - local.y));
      }
    }
    check(`${name}: inverse round-trips (max err ${maxErr.toExponential(2)})`, maxErr < 1e-9);

    // H * Hinv must be identity up to scale.
    const I = multiplyMat3(H, Hinv);
    const s = I[0];
    const isIdentity =
      approx(I[1] / s, 0, 1e-9) &&
      approx(I[2] / s, 0, 1e-9) &&
      approx(I[3] / s, 0, 1e-9) &&
      approx(I[5] / s, 0, 1e-9) &&
      approx(I[4] / s, 1, 1e-9) &&
      approx(I[8] / s, 1, 1e-9);
    check(`${name}: H * H^-1 = I`, isIdentity);

    // Every interior sample must land inside the polygon.
    let allInside = true;
    for (let i = 1; i < 8; i++) {
      for (let j = 1; j < 8; j++) {
        if (!pointInPolygon(applyMat3(H, P(i / 8, j / 8)), quad)) allInside = false;
      }
    }
    check(`${name}: unit-square interior maps strictly inside the quad`, allInside);

    // Screen points outside the quad must yield local coords outside [0,1].
    const out = [P(-500, -500), P(2000, 50), P(50, 2000)];
    const allOutside = out.every((p) => {
      const l = applyMat3(Hinv, p);
      return l.x < -1e-6 || l.x > 1 + 1e-6 || l.y < -1e-6 || l.y > 1 + 1e-6;
    });
    check(`${name}: exterior screen points map outside the unit square`, allOutside);
  }
}

console.log('\n— homography rejects degenerate input —');
{
  const collinear: Quad = [P(0, 0), P(10, 0), P(20, 0), P(30, 0)];
  check('collinear quad returns null', unitSquareToQuad(collinear) === null);
  const coincident: Quad = [P(5, 5), P(5, 5), P(5, 5), P(5, 5)];
  check('coincident points return null', unitSquareToQuad(coincident) === null);
  const zeroArea: Quad = [P(0, 0), P(100, 100), P(200, 200), P(50, 50)];
  const zh = unitSquareToQuad(zeroArea);
  check('zero-area quad is null or non-invertible', zh === null || invertMat3(zh) === null);
}

console.log('\n— outset —');
{
  for (const [name, quad] of Object.entries(SHAPES)) {
    const grown = outsetPolygon(quad, 2);
    check(`${name}: outset grows the area`, polygonArea(grown) > polygonArea(quad));
    check(`${name}: outset stays simple`, !isSelfIntersecting(grown));
    const everyOriginalInside = quad.every((p) => pointInPolygon(p, grown));
    check(`${name}: original corners fall inside the outset polygon`, everyOriginalInside);
  }
}

console.log('\n— separation + extent —');
{
  check(
    'minPairwiseDistance on the rectangle is the short side',
    approx(minPairwiseDistance(SHAPES.rectangle), 220),
  );
  const ext = quadExtent(SHAPES.rectangle);
  check('quadExtent width', approx(ext.x, 300));
  check('quadExtent height', approx(ext.y, 220));
}

console.log('\n— one euro smoothing —');
{
  // Constant signal: output converges to it.
  const f = new OneEuroFilter();
  let v = 0;
  for (let i = 0; i < 120; i++) v = f.filter(5, i * 16.7);
  check('converges on a constant signal', approx(v, 5, 1e-3), `got ${v}`);

  // Noisy stationary signal: variance must drop a lot.
  const noisy = new OneEuroFilter();
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296 - 0.5;
  };
  const raw: number[] = [];
  const out: number[] = [];
  for (let i = 0; i < 300; i++) {
    const sample = 0.5 + rand() * 0.02;
    raw.push(sample);
    out.push(noisy.filter(sample, i * 16.7));
  }
  const variance = (arr: number[]) => {
    const tail = arr.slice(100);
    const m = tail.reduce((a, b) => a + b, 0) / tail.length;
    return tail.reduce((a, b) => a + (b - m) ** 2, 0) / tail.length;
  };
  const reduction = variance(raw) / variance(out);
  check(`reduces stationary jitter (${reduction.toFixed(1)}x)`, reduction > 8);

  // Ramp at 0.6 frame-widths/sec (a brisk hand sweep): lag must stay tiny.
  const ramp = new OneEuroFilter();
  let last = 0;
  for (let i = 0; i < 200; i++) last = ramp.filter(i * 0.01, i * 16.7);
  const lag = Math.abs(199 * 0.01 - last);
  check(`tracks a fast ramp with low lag (${lag.toFixed(4)})`, lag < 0.03, `lag=${lag}`);

  // Slow drift should be smoothed hard but still arrive.
  const slow = new OneEuroFilter();
  let sv = 0;
  for (let i = 0; i < 400; i++) sv = slow.filter(0.3 + i * 0.0005, i * 16.7);
  const slowLag = Math.abs(0.3 + 399 * 0.0005 - sv);
  check(`tracks slow drift (lag ${slowLag.toFixed(5)})`, slowLag < 0.01, `lag=${slowLag}`);

  const bank = new PointSmoother(4);
  const sm = bank.smooth([P(1, 2), P(3, 4), P(5, 6), P(7, 8)], 0);
  check('PointSmoother passes through the first sample', approxPt(sm[0], P(1, 2)));
  check('PointSmoother handles all four points', sm.length === 4);
}

function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
