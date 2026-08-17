import { useEffect, useState } from 'react';
import type { RecordingResult } from '../recording/VideoRecorder';
import { canShareFile, downloadBlob, shareBlob, timestampName, formatDuration } from '../utils/share';

export interface RecordingPreviewProps {
  result: RecordingResult;
  onDelete: () => void;
  onRecordAgain: () => void;
}

export function RecordingPreview({ result, onDelete, onRecordAgain }: RecordingPreviewProps) {
  const filename = timestampName('four-finger-cam', result.extension);
  const [shareable, setShareable] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setShareable(canShareFile(result.blob, filename));
  }, [result.blob, filename]);

  const sizeMb = (result.blob.size / (1024 * 1024)).toFixed(1);

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Recording preview">
      <div className="sheet__panel">
        <div className="sheet__head">
          <h2 className="sheet__title">Recording ready</h2>
          <p className="sheet__meta">
            {formatDuration(result.durationMs)} · {sizeMb} MB · {result.extension.toUpperCase()}
            {result.hasAudio ? ' · audio' : ' · silent'}
          </p>
        </div>

        <video
          className="sheet__video"
          src={result.url}
          controls
          playsInline
          autoPlay
          loop
          muted
        />

        <div className="sheet__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              downloadBlob(result.blob, filename);
              setSaved(true);
            }}
          >
            {saved ? 'Saved' : 'Save video'}
          </button>

          {shareable && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                void shareBlob(result.blob, filename, 'Four Finger Cam');
              }}
            >
              Share
            </button>
          )}

          <button type="button" className="btn" onClick={onRecordAgain}>
            Record again
          </button>

          <button type="button" className="btn btn--ghost" onClick={onDelete}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
