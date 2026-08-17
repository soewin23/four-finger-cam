import type { FilterDef } from './types';

/**
 * Straight colour inversion. Intensity blends between the original and the
 * exact complement, so at 1.0 this really is `1.0 - colour` on every channel —
 * no grading, no cast. Simple enough to assert on in the render tests, which
 * is what makes it the reference filter there.
 */
export const negative: FilterDef = {
  id: 'negative',
  name: 'Negative',
  accent: ['#7cffcb', '#ff5f6d'],
  defaultIntensity: 1.0,
  glsl: /* glsl */ `
vec4 filterMain(vec2 local, vec2 uv) {
  vec3 s = src(uv).rgb;
  return vec4(mix(s, 1.0 - s, uIntensity), 1.0);
}`,
};
