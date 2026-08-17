import type { FilterDef } from './types';

/** Block displacement, channel separation, corrupt blocks and tear lines. */
export const glitch: FilterDef = {
  id: 'glitch',
  name: 'Glitch',
  accent: ['#00ffa3', '#ff0044'],
  animated: true,
  defaultIntensity: 0.55,
  glsl: /* glsl */ `
vec4 filterMain(vec2 local, vec2 uv) {
  // Quantised time makes the corruption stutter instead of sliding smoothly.
  float t = floor(uTime * 11.0);
  float amt = 0.3 + uIntensity;

  // Horizontal displacement, applied to a random subset of rows.
  float rows = 26.0;
  float row = floor(local.y * rows);
  float rowRand = hash12(vec2(row, t));
  float shift = step(0.70, rowRand) * (hash12(vec2(row, t + 3.7)) - 0.5) * 0.20 * amt;

  // Occasional whole-frame slam.
  shift += step(0.94, hash12(vec2(t, 9.1))) * (hash11(t) - 0.5) * 0.06 * amt;

  vec2 duv = uv + vec2(shift, 0.0);

  float burst = step(0.86, hash12(vec2(t, 1.0)));
  float sep = (0.0035 + 0.022 * burst) * amt;

  vec3 col;
  col.r = src(duv + vec2(sep, 0.0)).r;
  col.g = src(duv).g;
  col.b = src(duv - vec2(sep * 0.85, 0.0)).b;

  // Corrupt blocks: some inverted, some flushed to a flat data colour.
  vec2 cell = floor(local * vec2(15.0, 24.0));
  float bh = hash12(cell + t * 1.7);
  float invBlock = step(0.968, bh) * amt;
  float flatBlock = step(0.952, bh) * (1.0 - step(0.968, bh)) * amt;
  col = mix(col, 1.0 - col, invBlock);
  col = mix(col, vec3(hash12(cell + t)) * vec3(0.25, 1.0, 0.85), flatBlock);

  // Bright horizontal tear.
  float tear = step(0.994, hash12(vec2(floor(local.y * 100.0), t)));
  col = mix(col, vec3(0.88, 0.96, 1.0), tear * 0.55 * amt);

  col += (hash12(uv * uResolution + t * 13.0) - 0.5) * 0.055 * amt;
  return vec4(col, 1.0);
}`,
};
