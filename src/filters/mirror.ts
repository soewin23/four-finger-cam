import type { FilterDef } from './types';

/**
 * Horizontal mirror inside the quad: the left half is reflected onto the
 * right across the quad's own vertical axis, so the fold tilts with the hand.
 */
export const mirror: FilterDef = {
  id: 'mirror',
  name: 'Mirror',
  accent: ['#a0f0ff', '#5f7cff'],
  defaultIntensity: 1.0,
  glsl: /* glsl */ `
vec4 filterMain(vec2 local, vec2 uv) {
  vec2 folded = vec2(local.x < 0.5 ? local.x : 1.0 - local.x, local.y);

  vec3 original = src(uv).rgb;
  vec3 mirrored = src(localToScreenUV(folded)).rgb;
  vec3 col = mix(original, mirrored, uIntensity);

  // Soft specular seam along the fold line.
  float seam = smoothstep(0.014, 0.0, abs(local.x - 0.5));
  col += seam * 0.10 * uIntensity;

  return vec4(col, 1.0);
}`,
};
