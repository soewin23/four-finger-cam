import type { FilterDef } from './types';

/** Luminance mapped through an infrared-camera style palette. */
export const thermal: FilterDef = {
  id: 'thermal',
  name: 'Thermal',
  accent: ['#ff8a00', '#c800ff'],
  needsMips: true,
  defaultIntensity: 0.55,
  glsl: /* glsl */ `
vec3 thermalRamp(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = vec3(0.0, 0.0, 0.10);
  c = mix(c, vec3(0.24, 0.0, 0.52), smoothstep(0.00, 0.26, t));
  c = mix(c, vec3(0.86, 0.08, 0.34), smoothstep(0.22, 0.48, t));
  c = mix(c, vec3(1.00, 0.42, 0.00), smoothstep(0.44, 0.68, t));
  c = mix(c, vec3(1.00, 0.87, 0.13), smoothstep(0.65, 0.86, t));
  c = mix(c, vec3(1.00, 1.00, 0.96), smoothstep(0.85, 1.00, t));
  return c;
}

vec4 filterMain(vec2 local, vec2 uv) {
  float t = luma(src(uv).rgb);

  // Unsharp against a heavily blurred copy: pulls warm subjects away from the
  // background the way a real thermal sensor separates bodies from a room.
  float bg = luma(srcLod(uv, 5.0).rgb);
  t = clamp(t + (t - bg) * (0.4 + uIntensity * 0.9), 0.0, 1.0);
  t = pow(t, mix(1.5, 0.65, uIntensity));

  return vec4(thermalRamp(t), 1.0);
}`,
};
