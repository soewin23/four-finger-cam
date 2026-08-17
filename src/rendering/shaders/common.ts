/**
 * Shared GLSL — the contract every filter is compiled against.
 *
 * A filter file only ever provides the body of:
 *
 *     vec4 filterMain(vec2 local, vec2 screenUV)
 *
 * where `local` is the pixel's position inside the quadrilateral in [0,1]^2
 * (perspective-correct, corner 0 = (0,0)) and `screenUV` is its position on
 * the canvas in [0,1]^2. Everything below is available to it.
 */

export const FULLSCREEN_VERT = /* glsl */ `#version 300 es
// Attribute-less full-screen triangle; needs a bound VAO but no buffers.
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const QUAD_VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;    // clip space
layout(location = 1) in vec2 aLocal;  // affine fallback for concave quads
out vec2 vLocal;
void main() {
  vLocal = aLocal;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/** Uniform block + helper library shared by the base pass and every filter. */
export const SHADER_PRELUDE = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D uTex;
uniform vec2  uResolution;    // drawing-buffer size in pixels
uniform vec2  uVideoScale;    // screen UV -> video UV (aspect-preserving cover)
uniform vec2  uVideoOffset;
uniform float uMirror;        // 1.0 = selfie view
uniform mat3  uInvH;          // screen px (y down) -> quad local
uniform mat3  uH;             // quad local -> screen px (y down)
uniform float uUseHomography; // 0 = fall back to the affine varying
uniform float uEdgeAA;
uniform float uTime;          // seconds
uniform float uOpacity;       // activation fade
uniform float uIntensity;     // 0..1 user control
uniform vec2  uQuadPx;        // approx quad size in screen px
uniform float uMaxLod;

const float TAU = 6.28318530717958647692;

/**
 * Aspect-preserving "cover" mapping. The camera is never stretched: the
 * shorter axis is filled and the longer one is cropped symmetrically.
 */
vec2 screenToVideoUV(vec2 s) {
  s.x = mix(s.x, 1.0 - s.x, uMirror);
  return s * uVideoScale + uVideoOffset;
}

/**
 * Always samples level 0 explicitly. Using plain texture() would let the
 * hardware pick a mip level from the derivatives, which means the *unfiltered*
 * base pass would change appearance the moment a mip-using filter (blur, neon,
 * cyberpunk...) switched the sampler to LINEAR_MIPMAP_LINEAR. Pinning the LOD
 * keeps everything outside the quad byte-identical no matter which filter is
 * selected.
 */
vec4 src(vec2 s) {
  return textureLod(uTex, screenToVideoUV(clamp(s, 0.0, 1.0)), 0.0);
}

vec4 srcLod(vec2 s, float lod) {
  return textureLod(uTex, screenToVideoUV(clamp(s, 0.0, 1.0)), clamp(lod, 0.0, uMaxLod));
}

/** Quad-local [0,1]^2 back to screen UV — for filters that resample in quad space. */
vec2 localToScreenUV(vec2 l) {
  vec3 p = uH * vec3(l, 1.0);
  float w = abs(p.z) < 1e-8 ? 1e-8 : p.z;
  return (p.xy / w) / uResolution;
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
    mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.02; a *= 0.5; }
  return v;
}

mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

vec3 contrast(vec3 c, float k) { return clamp((c - 0.5) * k + 0.5, 0.0, 1.0); }
`;

/** Base pass: the untouched camera image, everywhere outside the quad. */
export const BASE_FRAG = `${SHADER_PRELUDE}
out vec4 fragColor;
void main() {
  vec2 fragPx = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  fragColor = vec4(src(fragPx / uResolution).rgb, 1.0);
}
`;

/**
 * Wraps a filter's GLSL into a complete fragment shader.
 *
 * The mask is produced by rasterising the quad's triangles, so pixels outside
 * the polygon are never shaded at all; the shader only has to soften the
 * boundary. Coverage is derived from the local coordinate's screen-space
 * derivative, which stays correct under rotation and perspective.
 */
export function buildFilterFragment(filterGlsl: string): string {
  return `${SHADER_PRELUDE}
in vec2 vLocal;
out vec4 fragColor;

${filterGlsl}

void main() {
  vec2 fragPx = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);

  vec3 h = uInvH * vec3(fragPx, 1.0);
  float w = abs(h.z) < 1e-8 ? 1e-8 : h.z;
  vec2 projected = h.xy / w;
  vec2 local = mix(vLocal, projected, uUseHomography);

  // Antialiased polygon coverage: signed distance to the nearest edge,
  // converted to pixels via the local coordinate's derivative.
  float cov = 1.0;
  if (uEdgeAA > 0.5) {
    vec2 d = min(local, 1.0 - local);
    vec2 fw = fwidth(local) * 1.1 + 1e-6;
    cov = clamp(d.x / fw.x + 0.5, 0.0, 1.0) * clamp(d.y / fw.y + 0.5, 0.0, 1.0);
  }
  if (cov <= 0.002) discard;

  vec4 c = filterMain(clamp(local, 0.0, 1.0), fragPx / uResolution);
  fragColor = vec4(c.rgb, c.a * cov * uOpacity);
}
`;
}
