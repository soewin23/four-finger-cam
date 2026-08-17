import type { FilterDef } from './types';

/** Colour quantisation with ordered dithering and a saturation lift. */
export const posterize: FilterDef = {
  id: 'posterize',
  name: 'Posterize',
  accent: ['#ff4d6d', '#ffd166'],
  defaultIntensity: 0.55,
  glsl: /* glsl */ `
// 4x4 Bayer matrix, built by recursion instead of a lookup table — cheap
// ordered dither that keeps banding from looking like compression artefacts.
float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x * 0.5 + a.y * a.y * 0.75);
}
float bayer4(vec2 a) {
  return bayer2(a * 0.5) * 0.25 + bayer2(a) - 0.5;
}

vec4 filterMain(vec2 local, vec2 uv) {
  float levels = floor(mix(14.0, 3.0, uIntensity));
  vec3 s = src(uv).rgb;

  float d = bayer4(gl_FragCoord.xy) / levels;
  vec3 q = floor((s + d) * levels + 0.5) / levels;

  float l = luma(q);
  q = clamp(mix(vec3(l), q, 1.4), 0.0, 1.0);
  q = contrast(q, 1.12);

  return vec4(q, 1.0);
}`,
};
