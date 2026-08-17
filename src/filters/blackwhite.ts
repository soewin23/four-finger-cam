import type { FilterDef } from './types';

/** Monochrome with a filmic contrast curve and a touch of grain. */
export const blackwhite: FilterDef = {
  id: 'bw',
  name: 'B&W',
  accent: ['#ffffff', '#6b6b6b'],
  defaultIntensity: 0.5,
  glsl: /* glsl */ `
vec4 filterMain(vec2 local, vec2 uv) {
  vec3 s = src(uv).rgb;

  // Slight red weighting renders skin the way a panchromatic film stock does.
  float l = dot(s, vec3(0.30, 0.59, 0.11));
  l = clamp((l - 0.5) * (1.0 + uIntensity * 0.85) + 0.5, 0.0, 1.0);
  l = pow(l, 0.94);

  // Toe and shoulder.
  l = smoothstep(0.02, 0.98, l) * 0.97 + 0.015;
  l += (hash12(uv * uResolution) - 0.5) * 0.022;

  return vec4(vec3(clamp(l, 0.0, 1.0)), 1.0);
}`,
};
