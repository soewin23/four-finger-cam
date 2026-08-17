import type { FilterDef } from './types';

/**
 * Mip-based blur. WebGL2 allows mipmaps on non-power-of-two textures, so a
 * per-frame generateMipmap plus a handful of textureLod taps buys a very wide
 * blur for a fraction of the cost of a separable kernel.
 */
export const blur: FilterDef = {
  id: 'blur',
  name: 'Blur',
  accent: ['#cbd5ff', '#7a86b8'],
  needsMips: true,
  defaultIntensity: 0.5,
  glsl: /* glsl */ `
vec4 filterMain(vec2 local, vec2 uv) {
  float lod = mix(1.2, 6.0, uIntensity);
  vec2 tap = (1.0 / uResolution) * pow(2.0, lod) * 0.55;

  vec3 c = srcLod(uv, lod).rgb * 0.36;
  c += srcLod(uv + tap * vec2( 1.0,  0.0), lod).rgb * 0.16;
  c += srcLod(uv + tap * vec2(-1.0,  0.0), lod).rgb * 0.16;
  c += srcLod(uv + tap * vec2( 0.0,  1.0), lod).rgb * 0.16;
  c += srcLod(uv + tap * vec2( 0.0, -1.0), lod).rgb * 0.16;

  return vec4(c, 1.0);
}`,
};
