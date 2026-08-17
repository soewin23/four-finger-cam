/**
 * Homography (perspective transform) between the unit square and an arbitrary
 * quadrilateral.
 *
 * This is the piece that makes the effect correct rather than approximate.
 * Interpolating UVs across two triangles gives an affine mapping per triangle,
 * which visibly kinks along the shared diagonal whenever the quad is not a
 * parallelogram. Instead we solve for the 3x3 projective matrix once per frame
 * and invert it, so the fragment shader can recover exact, perspective-correct
 * quad-local coordinates for every pixel.
 */

import type { Quad, Vec2 } from '../utils/geometry';

/** Row-major 3x3: [a b c, d e f, g h i]. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY_MAT3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * Maps the unit square — (0,0), (1,0), (1,1), (0,1) — onto the quad's four
 * corners in order. Closed form (Heckbert, "Fundamentals of Texture Mapping
 * and Image Warping", §2.2).
 */
export function unitSquareToQuad(quad: Quad): Mat3 | null {
  const [p0, p1, p2, p3] = quad;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;

  let g: number;
  let h: number;

  if (Math.abs(dx3) < 1e-10 && Math.abs(dy3) < 1e-10) {
    // Parallelogram: the mapping is affine, no projective term.
    g = 0;
    h = 0;
  } else {
    const den = dx1 * dy2 - dx2 * dy1;
    // Degenerate (collinear / zero-area) input: no valid projective map.
    if (Math.abs(den) < 1e-12) return null;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
  }

  const a = p1.x - p0.x + g * p1.x;
  const b = p3.x - p0.x + h * p3.x;
  const c = p0.x;
  const d = p1.y - p0.y + g * p1.y;
  const e = p3.y - p0.y + h * p3.y;
  const f = p0.y;

  const m: Mat3 = [a, b, c, d, e, f, g, h, 1];
  // The affine branch above can still be degenerate (e.g. coincident points),
  // so reject anything that will not invert rather than handing the renderer
  // a matrix that silently collapses the mask to nothing.
  if (!Number.isFinite(determinant(m)) || Math.abs(determinant(m)) < 1e-9) return null;
  return m;
}

/**
 * General 4-point correspondence solver via Gauss-Jordan on the 8x8 system.
 * Slower than the closed form but works for any source quad — kept because it
 * is the reference implementation the fast path is tested against.
 */
export function computeHomography(src: Quad, dst: Quad): Mat3 | null {
  const A: number[][] = [];
  const rhs: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x: u, y: v } = src[i];
    const { x, y } = dst[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    rhs.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    rhs.push(y);
  }

  // Gaussian elimination with partial pivoting.
  const n = 8;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    }
    if (Math.abs(A[pivot][col]) < 1e-12) return null;
    if (pivot !== col) {
      [A[col], A[pivot]] = [A[pivot], A[col]];
      [rhs[col], rhs[pivot]] = [rhs[pivot], rhs[col]];
    }
    const pv = A[col][col];
    for (let c = col; c < n; c++) A[col][c] /= pv;
    rhs[col] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = A[r][col];
      if (factor === 0) continue;
      for (let c = col; c < n; c++) A[r][c] -= factor * A[col][c];
      rhs[r] -= factor * rhs[col];
    }
  }

  return [rhs[0], rhs[1], rhs[2], rhs[3], rhs[4], rhs[5], rhs[6], rhs[7], 1];
}

export function determinant(m: Mat3): number {
  const [a, b, c, d, e, f, g, h, i] = m;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

export function invertMat3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
  const inv = 1 / det;
  return [
    A * inv,
    -(b * i - c * h) * inv,
    (b * f - c * e) * inv,
    B * inv,
    (a * i - c * g) * inv,
    -(a * f - c * d) * inv,
    C * inv,
    -(a * h - b * g) * inv,
    (a * e - b * d) * inv,
  ];
}

/** Apply a homography to a 2D point, with the perspective divide. */
export function applyMat3(m: Mat3, p: Vec2): Vec2 {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  const iw = Math.abs(w) < 1e-12 ? 0 : 1 / w;
  return {
    x: (m[0] * p.x + m[1] * p.y + m[2]) * iw,
    y: (m[3] * p.x + m[4] * p.y + m[5]) * iw,
  };
}

export function multiplyMat3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9).fill(0) as number[];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out as Mat3;
}

/**
 * GLSL `mat3` uniforms are column-major; our matrices are row-major.
 * Transposing here means the shader can write `uInvH * vec3(p, 1.0)` and get
 * the mathematically expected result.
 */
export function toGLColumnMajor(m: Mat3, out = new Float32Array(9)): Float32Array {
  out[0] = m[0];
  out[1] = m[3];
  out[2] = m[6];
  out[3] = m[1];
  out[4] = m[4];
  out[5] = m[7];
  out[6] = m[2];
  out[7] = m[5];
  out[8] = m[8];
  return out;
}
