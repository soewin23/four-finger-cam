import type { FilterDef } from './types';

/** Cyan/magenta split-tone, hard contrast, two-tap bloom. */
export const cyberpunk: FilterDef = {
  id: 'cyberpunk',
  name: 'Cyber',
  accent: ['#00e5ff', '#ff00a8'],
  needsMips: true,
  defaultIntensity: 0.6,
  glsl: /* glsl */ `
vec4 filterMain(vec2 local, vec2 uv) {
  vec3 s = src(uv).rgb;
  float l = luma(s);

  // Split-tone: cyan into the shadows, magenta into the highlights.
  vec3 shadowTint = vec3(0.05, 0.62, 0.92);
  vec3 highTint   = vec3(1.00, 0.16, 0.74);
  vec3 lowEnd  = s * mix(vec3(1.0), shadowTint, 0.8);
  vec3 highEnd = s * mix(vec3(1.0), highTint, 0.8);
  vec3 graded = mix(lowEnd, highEnd, smoothstep(0.22, 0.78, l));

  graded = contrast(graded, 1.3 + uIntensity * 0.85);

  // Cheap two-level bloom off the mip chain.
  vec3 b1 = srcLod(uv, 3.0).rgb;
  vec3 b2 = srcLod(uv, 5.5).rgb;
  vec3 bloom = max(b1 - 0.52, 0.0) * 1.15 + max(b2 - 0.42, 0.0) * 1.7;
  bloom *= vec3(0.55, 0.95, 1.45);

  vec3 col = graded + bloom * (0.45 + uIntensity * 1.1);

  // Faint CRT grid so it reads as a screen, not a photo.
  col *= 0.965 + 0.035 * sin(uv.y * uResolution.y * 2.0);
  col += vec3(0.0, 0.03, 0.06) * (1.0 - smoothstep(0.0, 0.7, length(local - 0.5)));

  return vec4(col, 1.0);
}`,
};
