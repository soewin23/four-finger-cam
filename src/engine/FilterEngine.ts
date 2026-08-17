/**
 * The frame loop that ties everything together.
 *
 *   camera frame -> hand landmarks -> four fingertips -> smoothing ->
 *   clockwise ordering -> validation -> activation state machine ->
 *   quadrilateral -> WebGL mask + filter -> screen (and recorder)
 *
 * Nothing in here touches React state per frame: the loop is plain imperative
 * code over refs, and status is pushed out only when it actually changes.
 */

import {
  minPairwiseDistance,
  polygonArea,
  isSelfIntersecting,
  sortClockwise,
  alignCyclicOrder,
  damp,
  type Quad,
  type Vec2,
} from '../utils/geometry';
import { PointSmoother } from '../utils/smoothing';
import { WebGLRenderer, RendererError } from '../rendering/WebGLRenderer';
import { OverlayPainter } from '../rendering/OverlayPainter';
import { HandTracker, HandTrackerError, type HandLandmarkerResult } from '../handTracking/HandTracker';
import { selectFingertips, type TrackingMode } from '../handTracking/fingertipUtils';
import { CameraManager, CameraError, type FacingMode } from '../camera/CameraManager';
import { FILTERS, getFilter, DEFAULT_FILTER_ID, type FilterDef } from '../filters';

export type ActivationState = 'idle' | 'arming' | 'active' | 'holding' | 'fading';
export type EnginePhase = 'idle' | 'starting' | 'running' | 'error';

export interface EngineStatus {
  phase: EnginePhase;
  activation: ActivationState;
  hint: string | null;
  error: string | null;
  errorKind: string | null;
  fps: number;
  handCount: number;
  trackingMode: TrackingMode | null;
  trackerReady: boolean;
  cameraReady: boolean;
  canFlipCamera: boolean;
  outputSize: { width: number; height: number };
}

export interface EngineOptions {
  glCanvas: HTMLCanvasElement;
  overlayCanvas: HTMLCanvasElement;
  video: HTMLVideoElement;
  onStatus: (status: EngineStatus) => void;
}

/** Consecutive valid frames before the filter switches on. */
const ARM_FRAMES = 5;
/** Keep the last good quad this long after tracking drops out. */
const HOLD_MS = 450;
/** Minimum separation between any two fingertips, as a fraction of the short edge. */
const MIN_SEPARATION_RATIO = 0.04;
/** Minimum quad area as a fraction of the canvas. */
const MIN_AREA_RATIO = 0.006;
const FADE_IN_HALFLIFE_MS = 70;
const FADE_OUT_HALFLIFE_MS = 110;
/** Cap the drawing buffer's long edge; keeps recordings at 1080p class. */
const MAX_OUTPUT_EDGE = 1920;

const HINT_NO_HAND = 'Show four fingertips to control the filter';
const HINT_SPREAD = 'Spread your four fingertips a little wider';
const HINT_HOLD = 'Hold steady…';
const HINT_LOADING = 'Loading hand tracking…';

type ValidationResult = 'ok' | 'too-close' | 'too-small' | 'self-intersecting';

export class FilterEngine {
  private glCanvas: HTMLCanvasElement;
  private overlayCanvas: HTMLCanvasElement;
  private video: HTMLVideoElement;
  private onStatus: (status: EngineStatus) => void;

  private renderer: WebGLRenderer | null = null;
  private overlay: OverlayPainter;
  private camera = new CameraManager();
  private tracker: HandTracker | null = null;

  private smoother = new PointSmoother(4);
  private prevOrdered: Vec2[] | null = null;
  private lastMode: TrackingMode | null = null;

  private rafId = 0;
  private running = false;
  private lastFrameTime = 0;
  private startTime = 0;
  private fps = 0;
  private framesSinceDetect = 0;

  private activation: ActivationState = 'idle';
  private pendingCandidate: Quad | null = null;
  private armCount = 0;
  private lostAt = 0;
  private opacity = 0;
  private quad: Quad | null = null;
  private lastValidation: ValidationResult = 'ok';
  private handCount = 0;
  private trackingMode: TrackingMode | null = null;

  private filter: FilterDef = getFilter(DEFAULT_FILTER_ID);
  private intensity = getFilter(DEFAULT_FILTER_ID).defaultIntensity ?? 0.5;
  private showMarkers = true;
  private mirror = true;

  private debugPoints: Vec2[] | null = null;

  private phase: EnginePhase = 'idle';
  private error: string | null = null;
  private errorKind: string | null = null;
  private canFlip = false;
  private lastStatusKey = '';
  private lastStatusAt = 0;

  private pendingCapture: ((blob: Blob | null) => void) | null = null;
  private pendingPixels: ((data: Uint8Array | null) => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private shaderFailures: { id: string; error: string }[] = [];

  constructor(options: EngineOptions) {
    this.glCanvas = options.glCanvas;
    this.overlayCanvas = options.overlayCanvas;
    this.video = options.video;
    this.onStatus = options.onStatus;
    this.overlay = new OverlayPainter(options.overlayCanvas);
  }

  // -------------------------------------------------------------- lifecycle

  async init(facing: FacingMode = 'user'): Promise<void> {
    this.phase = 'starting';
    this.emitStatus(true);

    try {
      this.renderer = new WebGLRenderer(this.glCanvas);
    } catch (err) {
      this.fail('gl', err instanceof RendererError ? err.message : String(err));
      return;
    }

    // Surface a broken shader immediately rather than when the user taps it.
    this.shaderFailures = this.renderer.precompile(FILTERS);
    if (this.shaderFailures.length > 0) {
      console.error('Filter shaders failed to compile:', this.shaderFailures);
    }

    try {
      const stream = await this.camera.start(facing);
      this.mirror = facing === 'user';
      this.video.srcObject = stream;
      this.video.playsInline = true;
      this.video.muted = true;
      await this.video.play();
      await waitForVideoDimensions(this.video);
    } catch (err) {
      this.fail(err instanceof CameraError ? err.kind : 'unknown', describeError(err));
      return;
    }

    this.canFlip = await this.camera.hasMultipleCameras();
    this.syncCanvasSize();
    this.phase = 'running';
    this.start();
    this.emitStatus(true);

    // Hand tracking loads in the background so the camera preview is instant.
    try {
      this.tracker = await HandTracker.create({ numHands: 2 });
    } catch (err) {
      const msg = err instanceof HandTrackerError ? err.message : describeError(err);
      console.error(msg);
      this.error = 'Hand tracking could not load. Check your connection and reload.';
      this.errorKind = 'tracker';
    }
    this.emitStatus(true);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = performance.now();
    this.startTime = this.lastFrameTime;
    this.observeResize();
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  dispose(): void {
    this.stop();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.tracker?.close();
    this.tracker = null;
    this.camera.stop();
    this.renderer?.dispose();
    this.renderer = null;
    if (this.video.srcObject) this.video.srcObject = null;
  }

  private fail(kind: string, message: string): void {
    this.phase = 'error';
    this.errorKind = kind;
    this.error = message;
    this.emitStatus(true);
  }

  // ----------------------------------------------------------------- inputs

  setFilter(id: string): void {
    const next = getFilter(id);
    if (next.id === this.filter.id) return;
    this.filter = next;
    this.intensity = next.defaultIntensity ?? 0.5;
    this.emitStatus(true);
  }

  setIntensity(value: number): void {
    this.intensity = Math.min(1, Math.max(0, value));
  }

  setShowMarkers(show: boolean): void {
    this.showMarkers = show;
    if (!show) this.overlay.clear();
  }

  get markersVisible(): boolean {
    return this.showMarkers;
  }

  get currentFilter(): FilterDef {
    return this.filter;
  }

  get currentIntensity(): number {
    return this.intensity;
  }

  get outputCanvas(): HTMLCanvasElement {
    return this.glCanvas;
  }

  get facingMode(): FacingMode {
    return this.camera.facingMode;
  }

  async flipCamera(): Promise<void> {
    const next: FacingMode = this.camera.facingMode === 'user' ? 'environment' : 'user';
    try {
      const stream = await this.camera.start(next);
      this.mirror = next === 'user';
      this.video.srcObject = stream;
      await this.video.play();
      await waitForVideoDimensions(this.video);
      this.resetTracking();
      this.syncCanvasSize();
      this.emitStatus(true);
    } catch (err) {
      this.fail(err instanceof CameraError ? err.kind : 'unknown', describeError(err));
    }
  }

  /**
   * Test/debug hook: feed fingertip positions directly, bypassing the camera.
   * Coordinates are normalised to the video frame, exactly like MediaPipe's.
   */
  setDebugPoints(points: Vec2[] | null): void {
    const had = this.debugPoints !== null;
    this.debugPoints = points && points.length === 4 ? points : null;
    // Clearing the override must look exactly like losing the hand, so the
    // hold-then-fade path runs for real instead of being short-circuited.
    if (!this.debugPoints && had) {
      this.smoother.reset();
      this.prevOrdered = null;
    }
  }

  /**
   * Swap the camera for a static, high-frequency test pattern so resampling
   * filters (blur, pixelate, mirror, RGB split) have detail to act on. The
   * fake webcam Chromium provides is mostly flat, which makes those filters
   * look like no-ops even when they are working correctly.
   */
  async debugUseTestPattern(width = 1280, height = 720): Promise<void> {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const ctx = c.getContext('2d');
    if (!ctx) return;

    let seed = 1234567;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };

    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, '#1b2fd0');
    grad.addColorStop(0.5, '#d0a01b');
    grad.addColorStop(1, '#d01b6f');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    const cell = 8;
    ctx.fillStyle = 'rgba(255,255,255,0.38)';
    for (let y = 0; y < height; y += cell) {
      for (let x = 0; x < width; x += cell) {
        if (((x / cell) | 0) % 2 === ((y / cell) | 0) % 2) ctx.fillRect(x, y, cell, cell);
      }
    }

    for (let i = 0; i < 320; i++) {
      ctx.fillStyle = `rgb(${(rnd() * 255) | 0},${(rnd() * 255) | 0},${(rnd() * 255) | 0})`;
      ctx.fillRect(rnd() * width, rnd() * height, 6 + rnd() * 44, 6 + rnd() * 44);
    }
    for (let i = 0; i < 40; i++) {
      ctx.beginPath();
      ctx.arc(rnd() * width, rnd() * height, 10 + rnd() * 60, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${(rnd() * 255) | 0},${(rnd() * 255) | 0},255,0.85)`;
      ctx.lineWidth = 1 + rnd() * 5;
      ctx.stroke();
    }

    this.camera.stop();
    const stream = c.captureStream(0);
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    this.video.srcObject = stream;
    await this.video.play();
    for (let i = 0; i < 6; i++) {
      track.requestFrame();
      await new Promise((r) => setTimeout(r, 70));
    }
    await waitForVideoDimensions(this.video);
  }

  /**
   * Introspection for automated tests: the quad in canvas device pixels, plus
   * enough state to assert on the activation machine and shader compilation.
   */
  debugState(): {
    quad: Quad | null;
    activation: ActivationState;
    opacity: number;
    outputSize: { width: number; height: number };
    shaderFailures: { id: string; error: string }[];
    filterId: string;
    mirror: boolean;
    phase: EnginePhase;
    error: string | null;
    errorKind: string | null;
    videoSize: { width: number; height: number };
    fps: number;
  } {
    return {
      quad: this.quad ? (this.quad.map((p) => ({ x: p.x, y: p.y })) as Quad) : null,
      activation: this.activation,
      opacity: this.opacity,
      outputSize: this.renderer?.drawingBufferSize ?? { width: 0, height: 0 },
      shaderFailures: this.shaderFailures,
      filterId: this.filter.id,
      mirror: this.mirror,
      phase: this.phase,
      error: this.error,
      errorKind: this.errorKind,
      videoSize: this.renderer?.videoSize ?? { width: 0, height: 0 },
      fps: Math.round(this.fps),
    };
  }

  /** Freeze the source frame so tests can compare renders deterministically. */
  freezeVideo(freeze: boolean): void {
    if (freeze) this.video.pause();
    else void this.video.play();
  }

  /** Read back the composited frame for pixel-level assertions. */
  debugCapturePixels(): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      this.pendingPixels = resolve;
    });
  }

  private resetTracking(): void {
    this.smoother.reset();
    this.prevOrdered = null;
    this.lastMode = null;
    this.activation = 'idle';
    this.armCount = 0;
    this.quad = null;
    this.opacity = 0;
  }

  // ------------------------------------------------------------------ frame

  private observeResize(): void {
    if (this.resizeObserver || typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver(() => this.syncCanvasSize());
    this.resizeObserver.observe(this.glCanvas);
  }

  /**
   * The drawing buffer matches the visible area's aspect ratio, so the file the
   * recorder produces is exactly the composition on screen. The camera image is
   * fitted with a cover mapping inside the shader — cropped if the aspect
   * ratios differ, never stretched. Dimensions are kept even because H.264
   * cannot encode odd ones.
   */
  private syncCanvasSize(): void {
    const renderer = this.renderer;
    if (!renderer) return;

    const cssW = this.glCanvas.clientWidth || window.innerWidth;
    const cssH = this.glCanvas.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);

    let w = cssW * dpr;
    let h = cssH * dpr;
    const longEdge = Math.max(w, h);
    if (longEdge > MAX_OUTPUT_EDGE) {
      const k = MAX_OUTPUT_EDGE / longEdge;
      w *= k;
      h *= k;
    }
    w = Math.max(2, Math.round(w / 2) * 2);
    h = Math.max(2, Math.round(h / 2) * 2);

    if (renderer.resize(w, h)) {
      this.prevOrdered = null;
    }
    if (this.overlayCanvas.width !== w || this.overlayCanvas.height !== h) {
      this.overlayCanvas.width = w;
      this.overlayCanvas.height = h;
    }
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);

    const renderer = this.renderer;
    if (!renderer || renderer.isContextLost) return;

    const dt = Math.min(now - this.lastFrameTime, 100);
    this.lastFrameTime = now;
    if (dt > 0) this.fps = this.fps === 0 ? 1000 / dt : this.fps * 0.92 + (1000 / dt) * 0.08;

    const gotNewFrame = renderer.updateVideoTexture(this.video);

    this.updateTracking(now, gotNewFrame);
    this.updateActivation(now, dt);

    renderer.render({
      quad: this.quad,
      filter: this.filter,
      intensity: this.intensity,
      opacity: this.opacity,
      timeSec: (now - this.startTime) / 1000,
      mirror: this.mirror,
    });

    this.paintOverlay();
    this.flushCapture();

    const readback = this.pendingPixels;
    if (readback) {
      this.pendingPixels = null;
      readback(renderer.readPixels());
    }

    this.emitStatus(false, now);
  };

  private updateTracking(now: number, gotNewFrame: boolean): void {
    const renderer = this.renderer;
    if (!renderer) return;

    let rawPoints: Vec2[] | null = null;

    if (this.debugPoints) {
      rawPoints = this.debugPoints;
      this.handCount = 1;
      this.trackingMode = 'one-hand';
    } else if (!this.tracker) {
      // Nothing is driving the quad — treat it as a loss so the state machine
      // can hold and then fade rather than freezing on a stale candidate.
      this.handCount = 0;
      this.trackingMode = null;
      this.pendingCandidate = null;
      return;
    } else if (gotNewFrame) {
      // Halve the detection rate when a device cannot keep up; the smoother
      // covers the gap and the render loop stays at full speed.
      const slow = this.tracker.averageDetectMs > 22;
      this.framesSinceDetect++;
      if (slow && this.framesSinceDetect < 2) return; // reuse the last candidate
      this.framesSinceDetect = 0;

      const result: HandLandmarkerResult | null = this.tracker.detect(this.video, now);
      this.handCount = result?.landmarks?.length ?? 0;
      const reading = selectFingertips(result);
      if (!reading) {
        this.trackingMode = null;
        this.pendingCandidate = null;
        return;
      }
      if (reading.mode !== this.lastMode) {
        // Point identities changed; restarting the filters avoids a lunge.
        this.smoother.reset();
        this.prevOrdered = null;
        this.lastMode = reading.mode;
      }
      this.trackingMode = reading.mode;
      rawPoints = reading.points;
    } else {
      return; // waiting on the next camera frame
    }

    const smoothed = this.smoother.smooth(rawPoints, now);
    const px = smoothed.map((p) => renderer.videoToCanvasPx(p.x, p.y, this.mirror));
    const sorted = sortClockwise(px);
    const aligned = alignCyclicOrder(sorted, this.prevOrdered);

    const verdict = this.validate(aligned);
    this.lastValidation = verdict;
    if (verdict === 'ok') {
      this.prevOrdered = aligned;
      this.pendingCandidate = aligned as Quad;
    } else {
      this.pendingCandidate = null;
    }
  }

  private validate(points: Vec2[]): ValidationResult {
    const renderer = this.renderer;
    if (!renderer) return 'too-small';
    const { width, height } = renderer.drawingBufferSize;
    const shortEdge = Math.min(width, height);

    if (minPairwiseDistance(points) < shortEdge * MIN_SEPARATION_RATIO) return 'too-close';
    if (polygonArea(points) < width * height * MIN_AREA_RATIO) return 'too-small';
    if (isSelfIntersecting(points)) return 'self-intersecting';
    return 'ok';
  }

  private updateActivation(now: number, dt: number): void {
    const candidate = this.pendingCandidate;

    switch (this.activation) {
      case 'idle':
        if (candidate) {
          this.activation = 'arming';
          this.armCount = 1;
        }
        break;

      case 'arming':
        if (candidate) {
          this.armCount++;
          if (this.armCount >= ARM_FRAMES) this.activation = 'active';
        } else {
          this.activation = 'idle';
          this.armCount = 0;
        }
        break;

      case 'active':
        if (!candidate) {
          this.activation = 'holding';
          this.lostAt = now;
        }
        break;

      case 'holding':
        if (candidate) this.activation = 'active';
        else if (now - this.lostAt > HOLD_MS) this.activation = 'fading';
        break;

      case 'fading':
        if (candidate) {
          this.activation = 'active';
        } else if (this.opacity < 0.01) {
          this.activation = 'idle';
          this.quad = null;
          this.smoother.reset();
          this.prevOrdered = null;
        }
        break;
    }

    if (candidate) this.quad = candidate;

    const target = this.activation === 'active' || this.activation === 'holding' ? 1 : 0;
    const halfLife = target > this.opacity ? FADE_IN_HALFLIFE_MS : FADE_OUT_HALFLIFE_MS;
    this.opacity = damp(this.opacity, target, halfLife, dt);
    if (Math.abs(this.opacity - target) < 0.002) this.opacity = target;
  }

  private paintOverlay(): void {
    if (!this.showMarkers) return;
    const confirming = this.activation === 'arming';
    const alpha =
      this.activation === 'active' || this.activation === 'holding'
        ? 1
        : confirming
          ? 0.6
          : this.opacity;

    this.overlay.draw({
      quad: this.quad,
      alpha,
      confirming,
      label: this.filter.name,
      accent: this.filter.accent,
      showLabel: true,
      dpr: this.overlayCanvas.width / Math.max(this.overlayCanvas.clientWidth || 1, 1),
    });
  }

  // ---------------------------------------------------------------- capture

  /**
   * Grab the composited frame. Called straight after render inside the same
   * animation frame, which is why the context does not need the (costly)
   * preserveDrawingBuffer flag.
   */
  captureStill(): Promise<Blob | null> {
    return new Promise((resolve) => {
      this.pendingCapture = resolve;
    });
  }

  private flushCapture(): void {
    const resolve = this.pendingCapture;
    if (!resolve) return;
    this.pendingCapture = null;
    try {
      this.glCanvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.94);
    } catch {
      resolve(null);
    }
  }

  // ----------------------------------------------------------------- status

  private hint(): string | null {
    if (this.phase !== 'running') return null;
    if (!this.tracker && !this.debugPoints) return HINT_LOADING;
    if (this.activation === 'active' || this.activation === 'holding') return null;
    if (this.activation === 'arming') return HINT_HOLD;
    if (this.handCount === 0) return HINT_NO_HAND;
    if (this.lastValidation === 'too-close' || this.lastValidation === 'too-small') {
      return HINT_SPREAD;
    }
    return HINT_NO_HAND;
  }

  private emitStatus(force: boolean, now = performance.now()): void {
    const status: EngineStatus = {
      phase: this.phase,
      activation: this.activation,
      hint: this.hint(),
      error: this.error,
      errorKind: this.errorKind,
      fps: Math.round(this.fps),
      handCount: this.handCount,
      trackingMode: this.trackingMode,
      trackerReady: this.tracker !== null,
      cameraReady: this.camera.currentStream !== null,
      canFlipCamera: this.canFlip,
      outputSize: this.renderer?.drawingBufferSize ?? { width: 0, height: 0 },
    };

    // Only wake React when something the UI actually shows has changed, and
    // rate-limit the FPS readout so it cannot drive a 60 Hz re-render.
    const key = [
      status.phase,
      status.activation,
      status.hint,
      status.error,
      status.trackerReady,
      status.cameraReady,
      status.canFlipCamera,
      status.trackingMode,
      this.filter.id,
    ].join('|');

    const fpsDue = now - this.lastStatusAt > 500;
    if (!force && key === this.lastStatusKey && !fpsDue) return;

    this.lastStatusKey = key;
    this.lastStatusAt = now;
    this.onStatus(status);
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function waitForVideoDimensions(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0 && video.videoHeight > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      video.removeEventListener('loadedmetadata', done);
      video.removeEventListener('resize', done);
      resolve();
    };
    video.addEventListener('loadedmetadata', done);
    video.addEventListener('resize', done);
    window.setTimeout(done, 4000);
  });
}
