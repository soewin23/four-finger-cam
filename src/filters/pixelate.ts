import type { FilterDef } from './types';

/**
 * Quantises in QUAD space, not screen space — so the mosaic grid rotates and
 * skews with the hand instead of staying axis-aligned. This is the filter that
 * makes the perspective mapping visible.
 */
export const pixelate: FilterDef = {
  id: 'pixelate',
  name: 'Pixelate',
  accent: ['#8be9fd', '#3b6fff'],
  defaultIntensity: 0.5,
  glsl: /* glsl */ `
vec4 filterMain(vec2 local, vec2 uv) {
  float targetPx = mix(52.0, 9.0, uIntensity);
  vec2 cells = max(vec2(2.0), floor(uQuadPx / targetPx));

  vec2 cellCentre = (floor(local * cells) + 0.5) / cells;
  vec3 col = src(localToScreenUV(cellCentre)).rgb;

  // Hairline gap between cells reads as a deliberate mosaic.
  vec2 f = abs(fract(local * cells) - 0.5) * 2.0;
  float grid = 1.0 - smoothstep(0.86, 1.0, max(f.x, f.y)) * 0.16;

  return vec4(col * grid, 1.0);
}`,
};
