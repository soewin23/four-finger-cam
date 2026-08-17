import { useCallback, useEffect, useRef, useState } from 'react';
import { CameraView } from './components/CameraView';
import { FilterSelector } from './components/FilterSelector';
import { Controls, IntensitySlider } from './components/Controls';
import { RecordButton } from './components/RecordButton';
import { RecordingPreview } from './components/RecordingPreview';
import { StatusOverlay } from './components/StatusOverlay';
import { FilterEngine, type EngineStatus } from './engine/FilterEngine';
import { FILTERS, DEFAULT_FILTER_ID, getFilter } from './filters';
import { VideoRecorder, type RecorderState, type RecordingResult } from './recording/VideoRecorder';
import { downloadBlob, shareBlob, timestampName } from './utils/share';
import type { Vec2 } from './utils/geometry';

const INITIAL_STATUS: EngineStatus = {
  phase: 'idle',
  activation: 'idle',
  hint: null,
  error: null,
  errorKind: null,
  fps: 0,
  handCount: 0,
  trackingMode: null,
  trackerReady: false,
  cameraReady: false,
  canFlipCamera: false,
  outputSize: { width: 0, height: 0 },
};

const IconShutter = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7">
    <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.7l1.1-1.7A1 1 0 0 1 10.1 4h3.8a1 1 0 0 1 .8.3L15.8 6h1.7A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5Z" />
    <circle cx="12" cy="12.4" r="3.4" />
  </svg>
);

const IconEye = ({ off }: { off: boolean }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7">
    <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
    <circle cx="12" cy="12" r="2.6" />
    {off && <path d="M4 20 20 4" strokeWidth="1.9" />}
  </svg>
);

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<FilterEngine | null>(null);
  const recorderRef = useRef<VideoRecorder | null>(null);

  const [status, setStatus] = useState<EngineStatus>(INITIAL_STATUS);
  const [filterId, setFilterId] = useState(DEFAULT_FILTER_ID);
  const [intensity, setIntensityState] = useState(getFilter(DEFAULT_FILTER_ID).defaultIntensity ?? 0.5);
  const [markersVisible, setMarkersVisible] = useState(true);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [showStats, setShowStats] = useState(false);
  const [recState, setRecState] = useState<RecorderState>('idle');
  const [result, setResult] = useState<RecordingResult | null>(null);
  const [flash, setFlash] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [bootKey, setBootKey] = useState(0);

  // --- engine lifecycle -------------------------------------------------
  useEffect(() => {
    const gl = glRef.current;
    const overlay = overlayRef.current;
    const video = videoRef.current;
    if (!gl || !overlay || !video) return;

    const engine = new FilterEngine({
      glCanvas: gl,
      overlayCanvas: overlay,
      video,
      onStatus: setStatus,
    });
    engineRef.current = engine;
    void engine.init();

    // Debug/automation hook — lets the four control points be driven without a
    // camera-visible hand, which is how the rendering path is tested.
    const api = {
      setPoints: (pts: Vec2[] | null) => engine.setDebugPoints(pts),
      setFilter: (id: string) => {
        engine.setFilter(id);
        setFilterId(id);
      },
      setIntensity: (v: number) => engine.setIntensity(v),
      setMarkers: (show: boolean) => {
        engine.setShowMarkers(show);
        setMarkersVisible(show);
      },
      freezeVideo: (freeze: boolean) => engine.freezeVideo(freeze),
      useTestPattern: () => engine.debugUseTestPattern(),
      capturePixels: () => engine.debugCapturePixels(),
      getState: () => engine.debugState(),
      engine,
    };
    (window as unknown as Record<string, unknown>).__fourFingerCam = api;

    return () => {
      engine.dispose();
      engineRef.current = null;
      delete (window as unknown as Record<string, unknown>).__fourFingerCam;
    };
  }, [bootKey]);

  // --- recorder lifecycle -----------------------------------------------
  useEffect(() => {
    const recorder = new VideoRecorder();
    recorder.onStateChange = setRecState;
    recorderRef.current = recorder;
    return () => {
      recorder.dispose();
      recorderRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(id);
  }, [toast]);

  // --- handlers ---------------------------------------------------------
  const handleSelectFilter = useCallback((id: string) => {
    setFilterId(id);
    engineRef.current?.setFilter(id);
    setIntensityState(getFilter(id).defaultIntensity ?? 0.5);
  }, []);

  const handleIntensity = useCallback((v: number) => {
    setIntensityState(v);
    engineRef.current?.setIntensity(v);
  }, []);

  const handleToggleMarkers = useCallback(() => {
    setMarkersVisible((prev) => {
      const next = !prev;
      engineRef.current?.setShowMarkers(next);
      return next;
    });
  }, []);

  const handleFlip = useCallback(() => {
    void engineRef.current?.flipCamera();
  }, []);

  const handleCapture = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    const blob = await engine.captureStill();
    if (!blob) {
      setToast('Could not capture the frame.');
      return;
    }
    setFlash(true);
    window.setTimeout(() => setFlash(false), 240);
    const name = timestampName('four-finger-cam', 'jpg');
    const shared = await shareBlob(blob, name, 'Four Finger Cam');
    if (!shared) downloadBlob(blob, name);
  }, []);

  const handleStartRecording = useCallback(async () => {
    const engine = engineRef.current;
    const recorder = recorderRef.current;
    if (!engine || !recorder) return;
    setResult(null);
    // 60 fps only when the render loop is genuinely keeping up.
    const fps = status.fps >= 50 ? 60 : 30;
    try {
      await recorder.start(engine.outputCanvas, { fps, withAudio: audioEnabled });
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Recording could not start.');
    }
  }, [audioEnabled, status.fps]);

  const handleStopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    try {
      setResult(await recorder.stop());
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Recording could not be saved.');
    }
  }, []);

  const handleDeleteRecording = useCallback(() => {
    setResult(null);
    recorderRef.current?.discard();
  }, []);

  const handleRecordAgain = useCallback(() => {
    setResult(null);
    recorderRef.current?.discard();
    void handleStartRecording();
  }, [handleStartRecording]);

  const getElapsedMs = useCallback(() => recorderRef.current?.elapsedMs ?? 0, []);

  const activeFilter = getFilter(filterId);
  const busy = status.phase !== 'running';

  return (
    <div className="app">
      <CameraView
        videoRef={videoRef}
        glRef={glRef}
        overlayRef={overlayRef}
        markersHidden={!markersVisible}
      />

      <div className={`flash${flash ? ' flash--on' : ''}`} aria-hidden="true" />

      <div className="hud">
        <Controls
          canFlip={status.canFlipCamera}
          onFlip={handleFlip}
          audioEnabled={audioEnabled}
          onToggleAudio={() => setAudioEnabled((v) => !v)}
          filterName={activeFilter.name}
          fps={status.fps}
          showStats={showStats}
          onToggleStats={() => setShowStats((v) => !v)}
          outputSize={status.outputSize}
          trackingMode={status.trackingMode}
        />

        <StatusOverlay
          phase={status.phase}
          hint={status.hint}
          error={status.error}
          onRetry={() => setBootKey((k) => k + 1)}
        />

        <div className="bottom">
          <IntensitySlider intensity={intensity} onIntensity={handleIntensity} />

          <FilterSelector filters={FILTERS} activeId={filterId} onSelect={handleSelectFilter} />

          <div className="actions">
            <button
              type="button"
              className="icon-btn icon-btn--lg"
              onClick={() => void handleCapture()}
              disabled={busy}
              title="Take a photo"
              aria-label="Take a photo"
            >
              <IconShutter />
            </button>

            <RecordButton
              state={recState}
              onStart={() => void handleStartRecording()}
              onStop={() => void handleStopRecording()}
              getElapsedMs={getElapsedMs}
              disabled={busy}
            />

            <button
              type="button"
              className={`icon-btn icon-btn--lg${markersVisible ? '' : ' icon-btn--off'}`}
              onClick={handleToggleMarkers}
              aria-pressed={markersVisible}
              title={markersVisible ? 'Hide fingertip markers' : 'Show fingertip markers'}
            >
              <IconEye off={!markersVisible} />
            </button>
          </div>
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}

      {result && (
        <RecordingPreview
          result={result}
          onDelete={handleDeleteRecording}
          onRecordAgain={handleRecordAgain}
        />
      )}
    </div>
  );
}
