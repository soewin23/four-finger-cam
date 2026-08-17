import { memo, useEffect, useState } from 'react';
import type { RecorderState } from '../recording/VideoRecorder';
import { formatDuration } from '../utils/share';

export interface RecordButtonProps {
  state: RecorderState;
  onStart: () => void;
  onStop: () => void;
  getElapsedMs: () => number;
  disabled?: boolean;
}

/** Live timer. Isolated so ticking it never re-renders the rest of the HUD. */
const Timer = memo(function Timer({ getElapsedMs }: { getElapsedMs: () => number }) {
  const [text, setText] = useState('00:00');
  useEffect(() => {
    const id = window.setInterval(() => setText(formatDuration(getElapsedMs())), 200);
    return () => window.clearInterval(id);
  }, [getElapsedMs]);

  return (
    <div className="rec-timer" role="timer" aria-live="off">
      <span className="rec-timer__dot" aria-hidden="true" />
      {text}
    </div>
  );
});

export const RecordButton = memo(function RecordButton({
  state,
  onStart,
  onStop,
  getElapsedMs,
  disabled,
}: RecordButtonProps) {
  const recording = state === 'recording';
  const stopping = state === 'stopping';
  const busy = state === 'requesting' || stopping;
  const label = recording ? 'Stop recording' : 'Start recording';

  return (
    <div className="rec-wrap">
      {recording && <Timer getElapsedMs={getElapsedMs} />}
      {stopping && <div className="rec-timer rec-timer--processing">Processing…</div>}

      <button
        type="button"
        className={`rec${recording ? ' rec--on' : ''}${busy ? ' rec--busy' : ''}`}
        aria-label={label}
        title={label}
        disabled={disabled || busy}
        onClick={() => {
          if (recording) onStop();
          else onStart();
        }}
      >
        <span className="rec__ring" aria-hidden="true" />
        <span className="rec__core" aria-hidden="true" />
      </button>
    </div>
  );
});
