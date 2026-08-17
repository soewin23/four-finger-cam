import type { FilterDef } from './types';

/** Radial wedge mirroring in quad space, slowly rotating. */
export const kaleidoscope: FilterDef = {
  id: 'kaleidoscope',
  name: 'Kaleido',
  accent: ['#ff9ae0', '#63e6ff'],
  animated: true,
  defaultIntensity: 0.45,
  glsl: /* glsl */ `
vec4 filterMain(vec2 local, vec2 uv) {
  float segments = floor(mix(4.0, 16.0, uIntensity));
  float wedge = TAU / segments;

  vec2 p = local - 0.5;
  float r = length(p);
  float a = atan(p.y, p.x) + uTime * 0.14;

  // Fold the angle into one wedge, then mirror within it.
  a = mod(a, wedge);
  a = abs(a - wedge * 0.5);

  vec2 q = vec2(cos(a), sin(a)) * r;
  vec2 sampleLocal = clamp(q * 1.3 + 0.5, 0.002, 0.998);

  vec3 col = src(localToScreenUV(sampleLocal)).rgb;

  // Faceted look: brighten the wedge seams a touch.
  float seam = smoothstep(0.02, 0.0, abs(a));
  col += seam * 0.06;
  col *= 1.0 - smoothstep(0.42, 0.75, r) * 0.30;

  return vec4(col, 1.0);
}`,
};
