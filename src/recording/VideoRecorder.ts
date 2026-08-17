/**
 * Records the final composited canvas.
 *
 *   camera -> hand tracking -> filter engine -> WebGL canvas
 *                                                 |
 *                              +------------------+------------------+
 *                              v                                     v
 *                           screen                         captureStream -> MediaRecorder
 *
 * There is exactly one render pass; the recorder taps the same canvas the user
 * is watching. The fingertip markers and polygon guides are painted on a
 * SEPARATE overlay canvas stacked above this one, which is why they show up
 * live but never appear in the exported file.
 */

import { pickMimeType, extensionFor, bitrateFor, isRecordingSupported } from './mimeSupport';

export type RecorderState = 'idle' | 'requesting' | 'recording' | 'stopping' | 'ready';

export interface RecordingResult {
  blob: Blob;
  url: string;
  mimeType: string;
  extension: string;
  durationMs: number;
  hasAudio: boolean;
}

export interface StartOptions {
  fps?: number;
  /** Try to include the microphone. Denial is not fatal. */
  withAudio?: boolean;
}

export class RecorderError extends Error {}

export class VideoRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private micStream: MediaStream | null = null;
  private captureStream: MediaStream | null = null;
  private combinedStream: MediaStream | null = null;
  private startedAt = 0;
  private stateValue: RecorderState = 'idle';
  private hasAudioTrack = false;
  private lastResult: RecordingResult | null = null;

  onStateChange: ((state: RecorderState) => void) | null = null;

  get state(): RecorderState {
    return this.stateValue;
  }

  get elapsedMs(): number {
    return this.stateValue === 'recording' ? performance.now() - this.startedAt : 0;
  }

  get recordingHasAudio(): boolean {
    return this.hasAudioTrack;
  }

  static get supported(): boolean {
    return isRecordingSupported();
  }

  private setState(next: RecorderState): void {
    if (this.stateValue === next) return;
    this.stateValue = next;
    this.onStateChange?.(next);
  }

  async start(canvas: HTMLCanvasElement, options: StartOptions = {}): Promise<void> {
    if (this.stateValue === 'recording' || this.stateValue === 'requesting') return;
    if (!isRecordingSupported()) {
      throw new RecorderError('Recording is not supported in this browser.');
    }

    this.setState('requesting');
    this.releaseResult();
    this.chunks = [];
    this.hasAudioTrack = false;

    const fps = clampFps(options.fps ?? 30);

    try {
      this.captureStream = canvas.captureStream(fps);
    } catch (err) {
      this.setState('idle');
      throw new RecorderError(
        `Could not capture the canvas: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const tracks: MediaStreamTrack[] = [...this.captureStream.getVideoTracks()];

    if (options.withAudio) {
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        const audioTracks = this.micStream.getAudioTracks();
        if (audioTracks.length > 0) {
          tracks.push(...audioTracks);
          this.hasAudioTrack = true;
        }
      } catch {
        // Microphone denied or unavailable — record silently rather than fail.
        this.micStream = null;
        this.hasAudioTrack = false;
      }
    }

    this.combinedStream = new MediaStream(tracks);

    const mimeType = pickMimeType(this.hasAudioTrack);
    if (mimeType === null) {
      this.cleanupStreams();
      this.setState('idle');
      throw new RecorderError('No supported recording format was found in this browser.');
    }

    const videoBitsPerSecond = bitrateFor(canvas.width, canvas.height, fps);
    const recorderOptions: MediaRecorderOptions = {
      videoBitsPerSecond,
      ...(this.hasAudioTrack ? { audioBitsPerSecond: 128_000 } : {}),
      ...(mimeType ? { mimeType } : {}),
    };

    try {
      this.recorder = new MediaRecorder(this.combinedStream, recorderOptions);
    } catch {
      // Some builds reject the bitrate hints; retry with the mime type alone.
      try {
        this.recorder = new MediaRecorder(
          this.combinedStream,
          mimeType ? { mimeType } : undefined,
        );
      } catch (err2) {
        this.cleanupStreams();
        this.setState('idle');
        throw new RecorderError(
          `MediaRecorder could not start: ${err2 instanceof Error ? err2.message : String(err2)}`,
        );
      }
    }

    this.recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };

    this.startedAt = performance.now();
    // Timeslice keeps data flowing so a crash mid-recording is still salvageable.
    this.recorder.start(1000);
    this.setState('recording');
  }

  /** Stop and resolve with the finished file. */
  async stop(): Promise<RecordingResult> {
    const recorder = this.recorder;
    if (!recorder || this.stateValue !== 'recording') {
      throw new RecorderError('Not recording.');
    }

    this.setState('stopping');
    const durationMs = performance.now() - this.startedAt;

    const blob = await new Promise<Blob>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new RecorderError('Timed out while finalising the recording.'));
      }, 10_000);

      recorder.onstop = () => {
        window.clearTimeout(timeout);
        const type = recorder.mimeType || 'video/webm';
        resolve(new Blob(this.chunks, { type }));
      };
      recorder.onerror = (event: Event) => {
        window.clearTimeout(timeout);
        reject(new RecorderError(`Recording failed: ${(event as ErrorEvent).message ?? 'unknown'}`));
      };

      try {
        recorder.requestData();
      } catch {
        /* not all implementations allow requestData before stop */
      }
      recorder.stop();
    }).finally(() => {
      this.cleanupStreams();
      this.recorder = null;
    });

    const mimeType = blob.type || 'video/webm';
    const result: RecordingResult = {
      blob,
      url: URL.createObjectURL(blob),
      mimeType,
      extension: extensionFor(mimeType),
      durationMs,
      hasAudio: this.hasAudioTrack,
    };
    this.lastResult = result;
    this.setState('ready');
    return result;
  }

  /** Abort without producing a file. */
  cancel(): void {
    if (this.recorder && this.stateValue === 'recording') {
      this.recorder.onstop = null;
      try {
        this.recorder.stop();
      } catch {
        /* already stopped */
      }
    }
    this.cleanupStreams();
    this.recorder = null;
    this.chunks = [];
    this.setState('idle');
  }

  /** Drop the finished file and return to idle. */
  discard(): void {
    this.releaseResult();
    this.setState('idle');
  }

  private releaseResult(): void {
    if (this.lastResult) {
      URL.revokeObjectURL(this.lastResult.url);
      this.lastResult = null;
    }
  }

  private cleanupStreams(): void {
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.captureStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.captureStream = null;
    this.combinedStream = null;
  }

  dispose(): void {
    this.cancel();
    this.releaseResult();
  }
}

function clampFps(fps: number): number {
  if (!Number.isFinite(fps)) return 30;
  return Math.min(60, Math.max(15, Math.round(fps)));
}

export { extensionFor, isRecordingSupported };
