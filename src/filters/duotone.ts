import type { FilterDef } from './types';

/** Luminance remapped onto a two-colour gradient. */
export const duotone: FilterDef = {
  id: 'duotone',
  name: 'Duotone',
  accent: ['#2b1d8f', '#ffb648'],
  defaultIntensity: 0.55,
  glsl: /* glsl */ `
const vec3 DUO_SHADOW = vec3(0.055, 0.030, 0.320);
const vec3 DUO_LIGHT  = vec3(1.000, 0.720, 0.240);

vec4 filterMain(vec2 local, vec2 uv) {
  float l = luma(src(uv).rgb);
  l = clamp((l - 0.5) * (1.0 + uIntensity * 1.0) + 0.5, 0.0, 1.0);
  l = smoothstep(0.03, 0.97, l);

  vec3 col = mix(DUO_SHADOW, DUO_LIGHT, l);
  // Push the midtones a little so the gradient does not read as flat.
  col = mix(col, col * col * 1.55, 0.22);

  return vec4(clamp(col, 0.0, 1.0), 1.0);
}`,
};
