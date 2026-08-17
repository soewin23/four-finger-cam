import type { FilterDef } from './types';

/** Animated refraction that rises from the bottom of the quad. */
export const heatwave: FilterDef = {
  id: 'heatwave',
  name: 'Heatwave',
  accent: ['#ffcf6b', '#ff5a2b'],
  animated: true,
  defaultIntensity: 0.5,
  glsl: /* glsl */ `
vec4 filterMain(vec2 local, vec2 uv) {
  float t = uTime;
  float amp = mix(0.004, 0.024, uIntensity);

  // Two octaves scrolling upward at different speeds.
  float n1 = vnoise(vec2(local.x *  9.0,        local.y *  5.0 - t * 1.10));
  float n2 = vnoise(vec2(local.x * 22.0 + 4.0,  local.y * 14.0 - t * 1.95));
  float w = (n1 - 0.5) * 0.72 + (n2 - 0.5) * 0.28;

  // Strongest near the bottom edge, like air off hot ground.
  float grad = mix(0.22, 1.0, smoothstep(0.0, 1.0, local.y));

  vec2 offset = vec2(w, w * 0.5 + sin(local.x * 28.0 + t * 3.1) * 0.22) * amp * grad;
  vec3 col = src(uv + offset).rgb;

  // Chromatic shimmer where the refraction is strongest.
  col.r = src(uv + offset * 1.15).r;
  col.b = src(uv + offset * 0.85).b;
  col += vec3(0.17, 0.06, 0.0) * abs(w) * 2.0 * grad;

  return vec4(col, 1.0);
}`,
};
