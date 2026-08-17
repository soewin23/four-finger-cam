/**
 * getUserMedia wrapper with graceful constraint relaxation and typed errors
 * so the UI can say something specific instead of "something went wrong".
 */

export type CameraErrorKind =
  | 'unsupported'
  | 'denied'
  | 'not-found'
  | 'in-use'
  | 'insecure-context'
  | 'unknown';

export class CameraError extends Error {
  readonly kind: CameraErrorKind;
  constructor(kind: CameraErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = 'CameraError';
  }
}

export type FacingMode = 'user' | 'environment';

const MESSAGES: Record<CameraErrorKind, string> = {
  unsupported: 'This browser does not support camera access. Try Chrome, Edge, Firefox or Safari.',
  denied:
    'Camera permission was denied. Allow camera access in your browser’s site settings, then reload.',
  'not-found': 'No camera was found on this device.',
  'in-use': 'The camera is already in use by another app or tab. Close it and try again.',
  'insecure-context':
    'Camera access needs a secure context. Open this page over https:// or from http://localhost.',
  unknown: 'The camera could not be started.',
};

function classify(err: unknown): CameraError {
  const name = (err as { name?: string } | null)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CameraError('denied', MESSAGES.denied);
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new CameraError('not-found', MESSAGES['not-found']);
    case 'NotReadableError':
    case 'AbortError':
      return new CameraError('in-use', MESSAGES['in-use']);
    default:
      return new CameraError(
        'unknown',
        `${MESSAGES.unknown}${err instanceof Error ? ` (${err.message})` : ''}`,
      );
  }
}

/** Progressively looser constraints — first match wins. */
function constraintLadder(facingMode: FacingMode): MediaStreamConstraints[] {
  const base = { facingMode: { ideal: facingMode } };
  return [
    {
      video: { ...base, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
      audio: false,
    },
    {
      video: { ...base, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    },
    { video: base, audio: false },
    { video: true, audio: false },
  ];
}

export class CameraManager {
  private stream: MediaStream | null = null;
  private facing: FacingMode = 'user';

  get currentStream(): MediaStream | null {
    return this.stream;
  }

  get facingMode(): FacingMode {
    return this.facing;
  }

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  async start(facingMode: FacingMode = 'user'): Promise<MediaStream> {
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      throw new CameraError('insecure-context', MESSAGES['insecure-context']);
    }
    if (!CameraManager.isSupported()) {
      throw new CameraError('unsupported', MESSAGES.unsupported);
    }

    this.stop();
    let lastError: unknown = null;

    for (const constraints of constraintLadder(facingMode)) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        this.stream = stream;
        this.facing = facingMode;
        return stream;
      } catch (err) {
        lastError = err;
        const name = (err as { name?: string }).name;
        // A hard refusal will not be fixed by relaxing resolution.
        if (name === 'NotAllowedError' || name === 'SecurityError') break;
      }
    }

    throw classify(lastError);
  }

  /** Only meaningful after permission has been granted at least once. */
  async hasMultipleCameras(): Promise<boolean> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput').length > 1;
    } catch {
      return false;
    }
  }

  settings(): MediaTrackSettings | null {
    const track = this.stream?.getVideoTracks()[0];
    return track?.getSettings() ?? null;
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

/** Mobile default is the selfie camera, which is also what hand framing wants. */
export function defaultFacingMode(): FacingMode {
  return 'user';
}

export function isMirroredByDefault(facing: FacingMode): boolean {
  return facing === 'user';
}
