import { memo } from 'react';

export interface ControlsProps {
  canFlip: boolean;
  onFlip: () => void;
  audioEnabled: boolean;
  onToggleAudio: () => void;
  filterName: string;
  fps: number;
  showStats: boolean;
  onToggleStats: () => void;
  outputSize: { width: number; height: number };
  trackingMode: string | null;
}

const IconFlip = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7">
    <path d="M3 8.5A6.5 6.5 0 0 1 14.6 5M21 15.5A6.5 6.5 0 0 1 9.4 19" />
    <path d="M3 4.5v4h4M21 19.5v-4h-4" />
  </svg>
);

const IconMic = ({ off }: { off: boolean }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7">
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    {off && <path d="M4 20 20 4" strokeWidth="1.9" />}
  </svg>
);

export const Controls = memo(function Controls({
  canFlip,
  onFlip,
  audioEnabled,
  onToggleAudio,
  filterName,
  fps,
  showStats,
  onToggleStats,
  outputSize,
  trackingMode,
}: ControlsProps) {
  return (
    <>
      <div className="topbar">
        <button type="button" className="brand" onClick={onToggleStats} title="Toggle stats">
          <span className="brand__dot" />
          <span className="brand__name">{filterName}</span>
        </button>

        <div className="topbar__actions">
          <button
            type="button"
            className={`icon-btn${audioEnabled ? '' : ' icon-btn--off'}`}
            onClick={onToggleAudio}
            aria-pressed={audioEnabled}
            title={audioEnabled ? 'Record with microphone' : 'Record silently'}
          >
            <IconMic off={!audioEnabled} />
          </button>

          {canFlip && (
            <button type="button" className="icon-btn" onClick={onFlip} title="Switch camera">
              <IconFlip />
            </button>
          )}
        </div>
      </div>

      {showStats && (
        <div className="stats">
          <span>{fps} fps</span>
          <span>
            {outputSize.width}×{outputSize.height}
          </span>
          <span>{trackingMode ?? 'no hand'}</span>
        </div>
      )}
    </>
  );
});

/** Lives in the bottom stack, directly above the filter rail. */
export const IntensitySlider = memo(function IntensitySlider({
  intensity,
  onIntensity,
}: {
  intensity: number;
  onIntensity: (v: number) => void;
}) {
  return (
    <div className="intensity">
      <span className="intensity__label">Intensity</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={intensity}
        onChange={(e) => onIntensity(Number(e.target.value))}
        aria-label="Filter intensity"
      />
    </div>
  );
});
