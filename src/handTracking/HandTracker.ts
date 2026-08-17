/**
 * MediaPipe Tasks Vision hand landmarker.
 *
 * Asset loading is deliberately forgiving: the runtime and model are tried
 * from a local copy first (so `npm run dev` works offline once vendored) and
 * fall back to the CDN, which is the only option for the single-file build.
 * GPU delegation is attempted first and falls back to CPU.
 */

import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';

const TASKS_VISION_VERSION = '1.0.1';

const CDN_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
const CDN_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

function localBase(): string {
  try {
    const base = import.meta.env?.BASE_URL ?? './';
    return base.endsWith('/') ? base : `${base}/`;
  } catch {
    return './';
  }
}

/** Local copies first when we are served over http(s); CDN always as backup. */
function wasmCandidates(): string[] {
  const local = `${localBase()}mediapipe/wasm`;
  const isFile = typeof location !== 'undefined' && location.protocol === 'file:';
  return isFile ? [CDN_WASM] : [local, CDN_WASM];
}

function modelCandidates(): string[] {
  const local = `${localBase()}models/hand_landmarker.task`;
  const isFile = typeof location !== 'undefined' && location.protocol === 'file:';
  return isFile ? [CDN_MODEL] : [local, CDN_MODEL];
}

export class HandTrackerError extends Error {}

export interface HandTrackerOptions {
  numHands?: number;
  minHandDetectionConfidence?: number;
  minHandPresenceConfidence?: number;
  minTrackingConfidence?: number;
}

export class HandTracker {
  private landmarker: HandLandmarker;
  private lastTimestamp = -1;
  private closed = false;

  /** Rolling average of detect() cost, used to throttle when a device struggles. */
  private detectMsAvg = 0;

  private constructor(landmarker: HandLandmarker) {
    this.landmarker = landmarker;
  }

  static async create(options: HandTrackerOptions = {}): Promise<HandTracker> {
    const errors: string[] = [];

    for (const wasmPath of wasmCandidates()) {
      let fileset;
      try {
        fileset = await FilesetResolver.forVisionTasks(wasmPath);
      } catch (err) {
        errors.push(`runtime @ ${wasmPath}: ${describe(err)}`);
        continue;
      }

      for (const modelPath of modelCandidates()) {
        for (const delegate of ['GPU', 'CPU'] as const) {
          try {
            const landmarker = await HandLandmarker.createFromOptions(fileset, {
              baseOptions: { modelAssetPath: modelPath, delegate },
              runningMode: 'VIDEO',
              numHands: options.numHands ?? 2,
              minHandDetectionConfidence: options.minHandDetectionConfidence ?? 0.5,
              minHandPresenceConfidence: options.minHandPresenceConfidence ?? 0.5,
              minTrackingConfidence: options.minTrackingConfidence ?? 0.5,
            });
            return new HandTracker(landmarker);
          } catch (err) {
            errors.push(`${delegate} @ ${modelPath}: ${describe(err)}`);
          }
        }
      }
    }

    throw new HandTrackerError(
      `Could not start hand tracking. Tried:\n${errors.map((e) => `  • ${e}`).join('\n')}`,
    );
  }

  get averageDetectMs(): number {
    return this.detectMsAvg;
  }

  /**
   * Run detection on the current video frame.
   * MediaPipe requires strictly increasing timestamps in VIDEO mode.
   */
  detect(video: HTMLVideoElement, timestampMs: number): HandLandmarkerResult | null {
    if (this.closed) return null;
    const ts = timestampMs <= this.lastTimestamp ? this.lastTimestamp + 1 : timestampMs;
    this.lastTimestamp = ts;

    const t0 = performance.now();
    try {
      const result = this.landmarker.detectForVideo(video, ts);
      this.detectMsAvg = this.detectMsAvg * 0.9 + (performance.now() - t0) * 0.1;
      return result;
    } catch {
      // A transient failure (e.g. the video element hiccuping) should not kill
      // the loop; the next frame usually succeeds.
      return null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.landmarker.close();
    } catch {
      /* already torn down */
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export type { HandLandmarkerResult };
