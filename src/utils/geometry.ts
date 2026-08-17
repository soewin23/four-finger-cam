/**
 * Geometry primitives for the four-point quadrilateral.
 *
 * Coordinate convention throughout the app: screen pixels, origin top-left,
 * +x right, +y DOWN. Under that convention the shoelace signed area is
 * POSITIVE for a clockwise polygon (the opposite of the usual y-up maths
 * convention), which is worth remembering when reading the sorting code.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export type Quad = [Vec2, Vec2, Vec2, Vec2];

export const vec = (x: number, y: number): Vec2 => ({ x, y });

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const dist2 = (a: Vec2, b: Vec2): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

export function normalize(a: Vec2): Vec2 {
  const l = len(a);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
}

export function lerpVec(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function centroid(points: readonly Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  const n = Math.max(points.length, 1);
  return { x: x / n, y: y / n };
}

/**
 * Shoelace signed area. Positive => clockwise in screen space (y down).
 */
export function signedArea(poly: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Unsigned polygon area. */
export function polygonArea(poly: readonly Vec2[]): number {
  return Math.abs(signedArea(poly));
}

/**
 * Order four points so they walk the perimeter of a simple (non
 * self-intersecting) polygon, clockwise on screen.
 *
 * Angular sort around the centroid is guaranteed to produce a simple polygon
 * for any point set, which is exactly the property we need: whatever the user
 * does with their fingers, the quad never crosses itself.
 */
export function sortClockwise<T extends readonly Vec2[]>(points: T): Vec2[] {
  const c = centroid(points);
  const sorted = [...points].sort(
    (a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x),
  );
  // atan2 ascending walks counter-clockwise in y-up space, i.e. clockwise on
  // screen. Verify with the signed area and flip if a degenerate case slipped
  // through.
  if (signedArea(sorted) < 0) sorted.reverse();
  return sorted;
}

/**
 * Rotate a cyclically-ordered polygon so vertex 0 best matches `reference`
 * vertex 0, preserving winding. Without this the "corner 0" of the quad hops
 * between fingers as the hand rotates, which makes orientation-dependent
 * filters (kaleidoscope, mirror, pixelate) snap around.
 */
export function alignCyclicOrder(poly: Vec2[], reference: readonly Vec2[] | null): Vec2[] {
  if (!reference || reference.length !== poly.length) return poly;
  let best = 0;
  let bestCost = Infinity;
  for (let shift = 0; shift < poly.length; shift++) {
    let cost = 0;
    for (let i = 0; i < poly.length; i++) {
      cost += dist2(poly[(i + shift) % poly.length], reference[i]);
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = shift;
    }
  }
  if (best === 0) return poly;
  return poly.map((_, i) => poly[(i + best) % poly.length]);
}

/** Orientation test: >0 counter-clockwise in maths space, <0 clockwise. */
function orient(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
  return (
    Math.min(a.x, b.x) - 1e-9 <= p.x &&
    p.x <= Math.max(a.x, b.x) + 1e-9 &&
    Math.min(a.y, b.y) - 1e-9 <= p.y &&
    p.y <= Math.max(a.y, b.y) + 1e-9
  );
}

/** Proper or improper intersection of segments ab and cd. */
export function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  if (Math.abs(o1) < 1e-9 && onSegment(a, b, c)) return true;
  if (Math.abs(o2) < 1e-9 && onSegment(a, b, d)) return true;
  if (Math.abs(o3) < 1e-9 && onSegment(c, d, a)) return true;
  if (Math.abs(o4) < 1e-9 && onSegment(c, d, b)) return true;
  return false;
}

/** True if any pair of non-adjacent edges cross. */
export function isSelfIntersecting(poly: readonly Vec2[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Skip adjacent edges (they legitimately share a vertex).
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (
        segmentsIntersect(
          poly[i],
          poly[(i + 1) % n],
          poly[j],
          poly[(j + 1) % n],
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Even-odd ray casting point-in-polygon. */
export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const intersects =
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y + 1e-12) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export const pointInQuad = (p: Vec2, quad: Quad): boolean => pointInPolygon(p, quad);

/** True if every interior angle turns the same way. */
export function isConvex(poly: readonly Vec2[]): boolean {
  let pos = false;
  let neg = false;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const o = orient(poly[i], poly[(i + 1) % n], poly[(i + 2) % n]);
    if (o > 1e-9) pos = true;
    else if (o < -1e-9) neg = true;
    if (pos && neg) return false;
  }
  return true;
}

/**
 * Split a simple quad into two triangles using a diagonal that stays inside
 * the polygon. Fanning from vertex 0 is only valid for convex quads — for a
 * concave one the diagonal must pass through the reflex vertex.
 */
export function triangulateQuad(quad: Quad): [number, number, number][] {
  if (isConvex(quad)) {
    return [
      [0, 1, 2],
      [0, 2, 3],
    ];
  }
  // Find the reflex vertex: its turn sign differs from the polygon winding.
  const windingSign = Math.sign(signedArea(quad)) || 1;
  for (let i = 0; i < 4; i++) {
    const prev = quad[(i + 3) % 4];
    const curr = quad[i];
    const next = quad[(i + 1) % 4];
    // orient() is y-up positive; screen winding uses the opposite sign.
    const turn = -Math.sign(orient(prev, curr, next));
    if (turn !== 0 && turn !== windingSign) {
      const a = i;
      const b = (i + 2) % 4;
      // Diagonal a-b splits the quad into (a, a+1, b) and (a, b, b+1).
      return [
        [a, (a + 1) % 4, b],
        [a, b, (b + 1) % 4],
      ];
    }
  }
  return [
    [0, 1, 2],
    [0, 2, 3],
  ];
}

/** Smallest distance between any two of the points. */
export function minPairwiseDistance(points: readonly Vec2[]): number {
  let m = Infinity;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      m = Math.min(m, dist(points[i], points[j]));
    }
  }
  return m === Infinity ? 0 : m;
}

/**
 * Push every vertex outward along its angle bisector by `amount` pixels.
 * Used to grow the rasterised geometry by a hair so the fragment shader has
 * room to compute an antialiased edge instead of relying on hard rasterisation.
 */
export function outsetPolygon(poly: readonly Vec2[], amount: number): Vec2[] {
  const n = poly.length;
  const c = centroid(poly);
  return poly.map((p, i) => {
    const prev = poly[(i + n - 1) % n];
    const next = poly[(i + 1) % n];
    const e1 = normalize(sub(p, prev));
    const e2 = normalize(sub(next, p));
    // Outward normals (screen space, clockwise winding).
    const n1 = { x: e1.y, y: -e1.x };
    const n2 = { x: e2.y, y: -e2.x };
    let bis = normalize(add(n1, n2));
    if (len(bis) < 1e-6) bis = normalize(sub(p, c));
    // Miter length compensation, clamped to avoid spikes at sharp corners.
    const cosHalf = Math.max(0.25, Math.abs(dot(bis, n1)));
    const outward = dot(bis, sub(p, c)) >= 0 ? 1 : -1;
    return add(p, scale(bis, (amount / cosHalf) * outward));
  });
}

/**
 * Approximate width/height of the quad in pixels — the mean of opposite edge
 * lengths. Filters that work in "quad space" (pixelate, kaleidoscope) use this
 * to keep their feature size stable in screen pixels.
 */
export function quadExtent(quad: Quad): Vec2 {
  const w = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2;
  const h = (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2;
  return { x: w, y: h };
}

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Frame-rate independent exponential approach. */
export function damp(current: number, target: number, halfLifeMs: number, dtMs: number): number {
  if (halfLifeMs <= 0) return target;
  const k = Math.pow(0.5, dtMs / halfLifeMs);
  return target + (current - target) * k;
}
