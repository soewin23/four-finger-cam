import { forwardRef } from 'react';

/**
 * The fingertip markers / polygon guide layer.
 *
 * Deliberately a separate canvas from the WebGL output: `captureStream()` taps
 * the GL canvas only, so these guides are visible live but never end up in an
 * exported photo or video.
 */
export const FingerPoints = forwardRef<HTMLCanvasElement, { hidden: boolean }>(
  function FingerPoints({ hidden }, ref) {
    return (
      <canvas
        ref={ref}
        className="layer layer--overlay"
        aria-hidden="true"
        style={{ opacity: hidden ? 0 : 1 }}
      />
    );
  },
);
