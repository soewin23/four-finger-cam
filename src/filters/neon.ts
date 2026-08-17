import type { FilterDef } from './types';

/** Sobel edge detection driving a cycling pink/purple/cyan/magenta glow. */
export const neon: FilterDef = {
  id: 'neon',
  name: 'Neon',
  accent: ['#ff3fd0', '#5b3bff'],
  needsMips: true,
  animated: true,
  defaultIntensity: 0.6,
  glsl: /* glsl */ `
vec4 filterMain(vec2 local, vec2 uv) {
  vec2 px = 1.0 / uResolution;

  float tl = luma(src(uv + px * vec2(-1.0, -1.0)).rgb);
  float tt = luma(src(uv + px * vec2( 0.0, -1.0)).rgb);
  float tr = luma(src(uv + px * vec2( 1.0, -1.0)).rgb);
  float ll = luma(src(uv + px * vec2(-1.0,  0.0)).rgb);
  float cc = luma(src(uv).rgb);
  float rr = luma(src(uv + px * vec2( 1.0,  0.0)).rgb);
  float bl = luma(src(uv + px * vec2(-1.0,  1.0)).rgb);
  float bb = luma(src(uv + px * vec2( 0.0,  1.0)).rgb);
  float br = luma(src(uv + px * vec2( 1.0,  1.0)).rgb);

  float gx = (tr + 2.0 * rr + br) - (tl + 2.0 * ll + bl);
  float gy = (bl + 2.0 * bb + br) - (tl + 2.0 * tt + tr);
  float mag = length(vec2(gx, gy));
  float edge = clamp(mag * (1.4 + uIntensity * 3.2), 0.0, 1.0);
  float ang = atan(gy, gx);

  // Hue cycles with edge orientation and time: cyan -> magenta -> violet -> pink.
  vec3 tint = 0.5 + 0.5 * cos(vec3(0.0, 0.85, 1.85) + ang * 1.15 + uTime * 0.55 + cc * 2.6);
  tint = mix(tint, vec3(1.0, 0.22, 0.86), 0.22);

  // Wide glow so bright regions bleed like actual tubing.
  vec3 wide = srcLod(uv, 4.0).rgb;
  float bloom = smoothstep(0.5, 1.0, luma(wide));

  vec3 base = mix(vec3(0.015, 0.0, 0.05), vec3(0.09, 0.01, 0.16), cc);
  vec3 col = base
           + tint * pow(edge, 0.7) * (1.8 + uIntensity * 1.6)
           + vec3(1.0, 0.18, 0.9) * bloom * 0.55
           + vec3(0.1, 0.6, 1.0) * pow(edge, 2.5) * 0.5;

  return vec4(col, 1.0);
}`,
};
