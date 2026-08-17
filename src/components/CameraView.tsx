import { forwardRef } from 'react';
import { FingerPoints } from './FingerPoints';

export interface CameraViewProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  glRef: React.RefObject<HTMLCanvasElement | null>;
  overlayRef: React.RefObject<HTMLCanvasElement | null>;
  markersHidden: boolean;
}

/**
 * The stage: an off-screen <video> feeding the GL canvas, and the marker
 * overlay on top. The video element itself is never displayed — every visible
 * pixel comes through the shader.
 */
export const CameraView = forwardRef<HTMLDivElement, CameraViewProps>(function CameraView(
  { videoRef, glRef, overlayRef, markersHidden },
  ref,
) {
  return (
    <div className="stage" ref={ref}>
      <video ref={videoRef} className="source-video" playsInline muted autoPlay />
      <canvas ref={glRef} className="layer layer--gl" />
      <FingerPoints ref={overlayRef} hidden={markersHidden} />
    </div>
  );
});
