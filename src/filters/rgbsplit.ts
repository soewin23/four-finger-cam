import type { FilterDef } from './types';

/** Channel displacement along a slowly rotating axis. */
export const rgbsplit: FilterDef = {
  id: 'rgbsplit',
  name: 'RGB Split',
  accent: ['#ff2d55', '#00d2ff'],
  animated: true,
  defaultIntensity: 0.45,
  glsl: /* glsl */ `
vec4 filterMain(vec2 local, vec2 uv) {
  float amt = mix(0.002, 0.032, uIntensity);
  float a = uTime * 0.45;
  vec2 dir = vec2(cos(a), sin(a));

  // Displacement grows toward the edges of the quad, like a lens.
  float radial = 0.6 + length(local - 0.5) * 1.2;
  vec2 off = dir * amt * radial;

  vec3 col;
  col.r = src(uv + off).r;
  col.g = src(uv).g;
  col.b = src(uv - off).b;

  // Additive fringe where the channels disagree most.
  float disp = abs(col.r - col.b);
  col += vec3(0.12, 0.0, 0.16) * disp;

  return vec4(col, 1.0);
}`,
};
