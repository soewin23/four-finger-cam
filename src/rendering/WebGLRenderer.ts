/**
 * WebGL2 renderer.
 *
 * Two draw calls per frame:
 *   1. A full-screen triangle painting the untouched camera image.
 *   2. The quadrilateral's two triangles, shaded with the selected filter.
 *
 * The mask comes from rasterisation itself — pixels outside the polygon are
 * never shaded — so the effect is genuinely clipped to the shape rather than
 * being an overlay that happens to look rectangular. Inside the polygon, each
 * fragment recovers its position in quad space by pushing gl_FragCoord through
 * the inverse homography, which stays exact under rotation, shear and
 * perspective.
 */

import type { Quad } from '../utils/geometry';
import { triangulateQuad, outsetPolygon, quadExtent, isConvex } from '../utils/geometry';
import {
  unitSquareToQuad,
  invertMat3,
  applyMat3,
  toGLColumnMajor,
  IDENTITY_MAT3,
  type Mat3,
} from './perspective';
import { FULLSCREEN_VERT, QUAD_VERT, BASE_FRAG, buildFilterFragment } from './shaders/common';
import type { FilterDef } from '../filters/types';

const UNIFORM_NAMES = [
  'uTex',
  'uResolution',
  'uVideoScale',
  'uVideoOffset',
  'uMirror',
  'uInvH',
  'uH',
  'uUseHomography',
  'uEdgeAA',
  'uTime',
  'uOpacity',
  'uIntensity',
  'uQuadPx',
  'uMaxLod',
] as const;

type UniformName = (typeof UNIFORM_NAMES)[number];

interface Program {
  program: WebGLProgram;
  uniforms: Partial<Record<UniformName, WebGLUniformLocation | null>>;
}

export interface RenderState {
  /** Ordered clockwise; null means no active quad. */
  quad: Quad | null;
  filter: FilterDef;
  intensity: number;
  /** Activation fade, 0..1. */
  opacity: number;
  timeSec: number;
  mirror: boolean;
}

export class RendererError extends Error {}

/** Edge softening in device pixels. */
const EDGE_FEATHER_PX = 1.5;

export class WebGLRenderer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private programs = new Map<string, Program>();
  private baseProgram: Program;
  private emptyVao: WebGLVertexArrayObject;
  private quadVao: WebGLVertexArrayObject;
  private quadBuffer: WebGLBuffer;
  private texture: WebGLTexture;
  private vertexData = new Float32Array(6 * 4);
  private invHScratch = new Float32Array(9);
  private hScratch = new Float32Array(9);

  private videoWidth = 0;
  private videoHeight = 0;
  private textureAllocated = false;
  private mipsValid = false;
  private mipFilterOn = false;
  private lastUploadTime = -1;
  private contextLost = false;

  private videoScale: [number, number] = [1, 1];
  private videoOffset: [number, number] = [0, 0];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false, // the shader does its own edge coverage
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      desynchronized: true,
      powerPreference: 'high-performance',
    });
    if (!gl) {
      throw new RendererError('WebGL2 is not available in this browser.');
    }
    this.gl = gl;

    canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);

    this.baseProgram = this.createProgram('__base', FULLSCREEN_VERT, BASE_FRAG);

    const emptyVao = gl.createVertexArray();
    const quadVao = gl.createVertexArray();
    const quadBuffer = gl.createBuffer();
    if (!emptyVao || !quadVao || !quadBuffer) throw new RendererError('Failed to allocate GL objects.');
    this.emptyVao = emptyVao;
    this.quadVao = quadVao;
    this.quadBuffer = quadBuffer;

    gl.bindVertexArray(quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertexData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0); // aPos
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8); // aLocal
    gl.bindVertexArray(null);

    const tex = gl.createTexture();
    if (!tex) throw new RendererError('Failed to allocate the video texture.');
    this.texture = tex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE); // winding flips freely as the hand turns over
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private onContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
  };

  private onContextRestored = (): void => {
    // Programs and buffers are gone; the app recreates the renderer.
    this.contextLost = false;
  };

  get isContextLost(): boolean {
    return this.contextLost || this.gl.isContextLost();
  }

  // ---------------------------------------------------------------- programs

  private compile(type: number, source: string, label: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new RendererError(`Could not create shader (${label}).`);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? 'unknown error';
      gl.deleteShader(shader);
      throw new RendererError(`Shader compile failed (${label}): ${log}`);
    }
    return shader;
  }

  private createProgram(key: string, vertSrc: string, fragSrc: string): Program {
    const gl = this.gl;
    const vert = this.compile(gl.VERTEX_SHADER, vertSrc, `${key}.vert`);
    const frag = this.compile(gl.FRAGMENT_SHADER, fragSrc, `${key}.frag`);
    const program = gl.createProgram();
    if (!program) throw new RendererError('Could not create program.');
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? 'unknown error';
      gl.deleteProgram(program);
      throw new RendererError(`Program link failed (${key}): ${log}`);
    }
    const uniforms: Program['uniforms'] = {};
    for (const name of UNIFORM_NAMES) uniforms[name] = gl.getUniformLocation(program, name);
    return { program, uniforms };
  }

  /** Compile + cache a filter's program. Throws with the GLSL log on failure. */
  getFilterProgram(filter: FilterDef): Program {
    const cached = this.programs.get(filter.id);
    if (cached) return cached;
    const prog = this.createProgram(filter.id, QUAD_VERT, buildFilterFragment(filter.glsl));
    this.programs.set(filter.id, prog);
    return prog;
  }

  /** Force-compile everything so a bad shader surfaces at startup, not mid-use. */
  precompile(filters: readonly FilterDef[]): { id: string; error: string }[] {
    const failures: { id: string; error: string }[] = [];
    for (const f of filters) {
      try {
        this.getFilterProgram(f);
      } catch (err) {
        failures.push({ id: f.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return failures;
  }

  // ------------------------------------------------------------------ sizing

  /** Size the drawing buffer. Returns true if it changed. */
  resize(width: number, height: number): boolean {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    this.recomputeCover();
    return true;
  }

  /**
   * Aspect-preserving "cover" fit: fill the canvas, crop the overflowing axis
   * symmetrically, never scale the axes independently.
   */
  private recomputeCover(): void {
    const { width: cw, height: ch } = this.canvas;
    if (!this.videoWidth || !this.videoHeight || !cw || !ch) {
      this.videoScale = [1, 1];
      this.videoOffset = [0, 0];
      return;
    }
    const videoAspect = this.videoWidth / this.videoHeight;
    const canvasAspect = cw / ch;
    let sx = 1;
    let sy = 1;
    if (videoAspect > canvasAspect) {
      sx = canvasAspect / videoAspect; // video is wider: crop left/right
    } else {
      sy = videoAspect / canvasAspect; // video is taller: crop top/bottom
    }
    this.videoScale = [sx, sy];
    this.videoOffset = [(1 - sx) / 2, (1 - sy) / 2];
  }

  /**
   * Maps a normalised video coordinate (what MediaPipe returns) to a canvas
   * pixel. Exactly inverts the shader's screenToVideoUV, so markers land on the
   * same pixels the filter is sampling.
   */
  videoToCanvasPx(nx: number, ny: number, mirror: boolean): { x: number; y: number } {
    const [sx, sy] = this.videoScale;
    const [ox, oy] = this.videoOffset;
    let u = sx !== 0 ? (nx - ox) / sx : nx;
    const v = sy !== 0 ? (ny - oy) / sy : ny;
    if (mirror) u = 1 - u;
    return { x: u * this.canvas.width, y: v * this.canvas.height };
  }

  get drawingBufferSize(): { width: number; height: number } {
    return { width: this.canvas.width, height: this.canvas.height };
  }

  get videoSize(): { width: number; height: number } {
    return { width: this.videoWidth, height: this.videoHeight };
  }

  // ----------------------------------------------------------------- texture

  /** Upload a new video frame. Returns false when there is nothing new. */
  updateVideoTexture(video: HTMLVideoElement): boolean {
    if (this.isContextLost) return false;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || video.readyState < 2) return false;

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    if (vw !== this.videoWidth || vh !== this.videoHeight) {
      this.videoWidth = vw;
      this.videoHeight = vh;
      this.textureAllocated = false;
      this.recomputeCover();
    }

    if (video.currentTime === this.lastUploadTime) return false;
    this.lastUploadTime = video.currentTime;

    if (!this.textureAllocated) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      this.textureAllocated = true;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
    }
    this.mipsValid = false;
    return true;
  }

  private setMipFilter(on: boolean): void {
    if (this.mipFilterOn === on) return;
    const gl = this.gl;
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      on ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
    );
    this.mipFilterOn = on;
  }

  /**
   * WebGL2 permits mipmaps on non-power-of-two textures, which is what makes
   * the mip-based blur and bloom cheap. Only generated when a filter asks.
   * The sampler mode is (re)asserted every time, because a non-mip filter may
   * have switched it back to plain LINEAR while the chain was still valid.
   */
  private ensureMips(): void {
    this.setMipFilter(true);
    if (this.mipsValid) return;
    this.gl.generateMipmap(this.gl.TEXTURE_2D);
    this.mipsValid = true;
  }

  private get maxLod(): number {
    const m = Math.max(this.videoWidth, this.videoHeight);
    return m > 0 ? Math.floor(Math.log2(m)) : 0;
  }

  // ------------------------------------------------------------------ render

  private setSharedUniforms(prog: Program, state: RenderState): void {
    const gl = this.gl;
    const u = prog.uniforms;
    const { width, height } = this.canvas;
    gl.uniform1i(u.uTex ?? null, 0);
    gl.uniform2f(u.uResolution ?? null, width, height);
    gl.uniform2f(u.uVideoScale ?? null, this.videoScale[0], this.videoScale[1]);
    gl.uniform2f(u.uVideoOffset ?? null, this.videoOffset[0], this.videoOffset[1]);
    gl.uniform1f(u.uMirror ?? null, state.mirror ? 1 : 0);
    gl.uniform1f(u.uTime ?? null, state.timeSec);
    gl.uniform1f(u.uMaxLod ?? null, this.maxLod);
  }

  render(state: RenderState): void {
    if (this.isContextLost) return;
    const gl = this.gl;
    const { width, height } = this.canvas;

    gl.viewport(0, 0, width, height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    const needsMips = state.filter.needsMips === true && state.quad !== null && state.opacity > 0;
    if (needsMips) this.ensureMips();
    else this.setMipFilter(false);

    // --- pass 1: untouched camera --------------------------------------
    gl.disable(gl.BLEND);
    gl.useProgram(this.baseProgram.program);
    this.setSharedUniforms(this.baseProgram, state);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.BLEND);

    // --- pass 2: filter, clipped to the quad ---------------------------
    const { quad, opacity } = state;
    if (!quad || opacity <= 0.001) {
      gl.bindVertexArray(null);
      return;
    }

    const H = unitSquareToQuad(quad);
    if (!H) {
      gl.bindVertexArray(null);
      return;
    }
    const invH = invertMat3(H);
    if (!invH) {
      gl.bindVertexArray(null);
      return;
    }

    // A homography only maps the unit square onto a CONVEX quad; for a concave
    // one the projective map folds and would punch holes in the mask. Those are
    // rare and transient, so fall back to affine-per-triangle interpolation and
    // skip the shader-side edge feather.
    const convex = isConvex(quad);
    // Convex: grow the geometry by a hair so the shader has room either side of
    // the true edge to compute antialiased coverage. Concave: draw the exact
    // triangles and let the corner UVs interpolate affinely.
    const geometry = convex ? (outsetPolygon(quad, EDGE_FEATHER_PX) as Quad) : quad;

    let prog: Program;
    try {
      prog = this.getFilterProgram(state.filter);
    } catch {
      gl.bindVertexArray(null);
      return;
    }

    gl.useProgram(prog.program);
    this.setSharedUniforms(prog, state);

    const u = prog.uniforms;
    gl.uniformMatrix3fv(u.uInvH ?? null, false, toGLColumnMajor(invH, this.invHScratch));
    gl.uniformMatrix3fv(u.uH ?? null, false, toGLColumnMajor(H, this.hScratch));
    gl.uniform1f(u.uUseHomography ?? null, convex ? 1 : 0);
    gl.uniform1f(u.uEdgeAA ?? null, convex ? 1 : 0);
    gl.uniform1f(u.uOpacity ?? null, opacity);
    gl.uniform1f(u.uIntensity ?? null, state.intensity);
    const extent = quadExtent(quad);
    gl.uniform2f(u.uQuadPx ?? null, extent.x, extent.y);

    // Two triangles chosen so the diagonal stays inside the polygon even when
    // the quad is concave.
    const tris = triangulateQuad(quad);
    const data = this.vertexData;
    let o = 0;
    for (const tri of tris) {
      for (const idx of tri) {
        const p = geometry[idx];
        const l = UNIT_SQUARE[idx];
        data[o++] = (p.x / width) * 2 - 1;
        data[o++] = 1 - (p.y / height) * 2; // screen y-down -> clip y-up
        data[o++] = l.x;
        data[o++] = l.y;
      }
    }

    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  /**
   * Read the drawing buffer back as top-down RGBA. Only valid inside the same
   * animation frame as the render, since the context does not preserve its
   * drawing buffer.
   */
  readPixels(): Uint8Array {
    const gl = this.gl;
    const { width, height } = this.canvas;
    const raw = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    // GL origin is bottom-left; flip so row 0 is the top of the image.
    const stride = width * 4;
    const out = new Uint8Array(raw.length);
    for (let y = 0; y < height; y++) {
      out.set(raw.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride);
    }
    return out;
  }

  /** Diagnostic: where the shader thinks a given canvas pixel sits in quad space. */
  debugLocalForPixel(quad: Quad, x: number, y: number): { x: number; y: number } | null {
    const H = unitSquareToQuad(quad);
    if (!H) return null;
    const inv = invertMat3(H);
    if (!inv) return null;
    return applyMat3(inv, { x, y });
  }

  dispose(): void {
    const gl = this.gl;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    for (const p of this.programs.values()) gl.deleteProgram(p.program);
    this.programs.clear();
    gl.deleteProgram(this.baseProgram.program);
    gl.deleteBuffer(this.quadBuffer);
    gl.deleteVertexArray(this.quadVao);
    gl.deleteVertexArray(this.emptyVao);
    gl.deleteTexture(this.texture);
  }
}

const UNIT_SQUARE = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

export { IDENTITY_MAT3 };
export type { Mat3 };
