/**
 * Container/codec negotiation for MediaRecorder.
 *
 * Support varies a lot: Safari only does MP4, older Chrome only WebM, current
 * Chrome does both. MP4/H.264 is listed first because the resulting file drops
 * straight into Photos, iMessage and every editor — a .webm often will not.
 */

const WITH_AUDIO = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=h264,aac',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=h264,opus',
  'video/webm',
];

const VIDEO_ONLY = [
  'video/mp4;codecs=avc1.640028',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm;codecs=h264',
  'video/webm',
];

export function isRecordingSupported(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function'
  );
}

/** Best supported type, or null if MediaRecorder cannot record anything here. */
export function pickMimeType(withAudio: boolean): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const list = withAudio ? WITH_AUDIO : VIDEO_ONLY;
  for (const type of list) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      /* isTypeSupported can throw on malformed strings in some browsers */
    }
  }
  // Let the browser choose its own default as a last resort.
  return '';
}

export function extensionFor(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('ogg')) return 'ogv';
  return 'webm';
}

/**
 * Roughly 0.12 bits per pixel per frame — visually clean for camera content
 * with a lot of shader-generated high-frequency detail, clamped to sane bounds.
 */
export function bitrateFor(width: number, height: number, fps: number): number {
  const raw = width * height * fps * 0.12;
  return Math.round(Math.min(24_000_000, Math.max(6_000_000, raw)));
}
