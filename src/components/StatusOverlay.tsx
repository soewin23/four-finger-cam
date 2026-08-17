import { memo } from 'react';

export interface StatusOverlayProps {
  phase: 'idle' | 'starting' | 'running' | 'error';
  hint: string | null;
  error: string | null;
  onRetry: () => void;
}

export const StatusOverlay = memo(function StatusOverlay({
  phase,
  hint,
  error,
  onRetry,
}: StatusOverlayProps) {
  if (phase === 'error') {
    return (
      <div className="blocker">
        <div className="blocker__card">
          <div className="blocker__icon" aria-hidden="true">
            ⚠
          </div>
          <h1 className="blocker__title">Camera unavailable</h1>
          <p className="blocker__body">{error}</p>
          <button type="button" className="btn btn--primary" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'starting') {
    return (
      <div className="blocker">
        <div className="blocker__card">
          <div className="spinner" aria-hidden="true" />
          <h1 className="blocker__title">Starting camera</h1>
          <p className="blocker__body">Allow camera access to continue.</p>
        </div>
      </div>
    );
  }

  if (!hint) return null;

  return (
    <div className="hint" role="status">
      {hint}
    </div>
  );
});
