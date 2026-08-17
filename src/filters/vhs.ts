import type { FilterDef } from './types';

/** Tape wobble, tracking bands, scanlines, chroma bleed and luma noise. */
export const vhs: FilterDef = {
  id: 'vhs',
  name: 'VHS',
  accent: ['#3ad0ff', '#ff2f6d'],
  animated: true,
  defaultIntensity: 0.6,
  glsl: /* glsl */ `
vec4 filterMain(vec2 local, vec2 uv) {
  float t = uTime;
  float amt = 0.35 + uIntensity * 0.95;

  // Head-switching wobble: a fast fine ripple over a slow wide one.
  float wob = sin(uv.y * 190.0 + t * 6.5) * 0.0009
            + sin(uv.y * 31.0  - t * 2.1) * 0.0021;

  // A tracking band drifting down the frame, jittering the rows it crosses.
  float bandPos = fract(uv.y * 0.55 - t * 0.11);
  float band = smoothstep(0.03, 0.0, abs(bandPos - 0.5) - 0.012);
  wob += band * (hash12(vec2(floor(t * 20.0), floor(uv.y * 110.0))) - 0.5) * 0.035;

  vec2 duv = uv + vec2(wob * amt, 0.0);

  // Chroma bleed widens toward the edges of the quad.
  float edgeF = length(local - 0.5) * 1.45;
  float ca = (0.0015 + edgeF * 0.0034) * amt;

  vec3 col;
  col.r = src(duv + vec2(ca, 0.0)).r;
  col.g = src(duv).g;
  col.b = src(duv - vec2(ca * 0.9, 0.0)).b;

  // Chroma lags luma horizontally, the classic VHS smear.
  vec3 lag = src(duv - vec2(0.004 * amt, 0.0)).rgb;
  col.rb = mix(col.rb, lag.rb, 0.35 * amt);

  float sl = 0.80 + 0.20 * sin(uv.y * uResolution.y * 1.65);
  col *= mix(1.0, sl, amt * 0.75);

  float n = hash12(uv * uResolution + floor(t * 24.0) * 71.3);
  col += (n - 0.5) * 0.085 * amt;
  col += band * 0.06;

  col = mix(col, vec3(luma(col)), 0.07);
  col = pow(clamp(col, 0.0, 1.0), vec3(0.94, 1.0, 1.07));
  col *= vec3(1.03, 1.0, 0.96);

  return vec4(col, 1.0);
}`,
};
