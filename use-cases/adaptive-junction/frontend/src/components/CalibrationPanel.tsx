import type { CalibStep, CamIdentity, CamProfile, FrameQuality } from "../lib/cameraCalibration";
import { sensitivityLabel } from "../lib/cameraCalibration";

type Props = {
  step: CalibStep;
  profile: CamProfile;
  quality: FrameQuality | null;
  trackCount: number;
  laneOk: boolean;
  previewReady: boolean;
  warming: boolean;
  side: string;
  camIdentity: CamIdentity | null;
  mismatched: boolean;
  tapeCm: number;
  onTapeCm: (v: number) => void;
  onStart: () => void;
  onSkip: () => void;
  onNextBackground: () => void;
  onNextLighting: () => void;
  onCaptureSize: () => void;
  onCaptureLanes: () => void;
  onFinish: () => void;
  onSensitivity: (v: number) => void;
  onObjectSize: (lengthCm: number, widthCm: number) => void;
  onHfov: (deg: number) => void;
};

const STEPS: CalibStep[] = ["background", "lighting", "size", "lanes", "done"];

export function CalibrationPanel({
  step,
  profile,
  quality,
  trackCount,
  laneOk,
  previewReady,
  warming,
  side,
  camIdentity,
  mismatched,
  tapeCm,
  onTapeCm,
  onStart,
  onSkip,
  onNextBackground,
  onNextLighting,
  onCaptureSize,
  onCaptureLanes,
  onFinish,
  onSensitivity,
  onObjectSize,
  onHfov,
}: Props) {
  const camName = camIdentity?.label || "this phone camera";

  if (step === "idle") {
    return (
      <div className="calib-panel">
        <div className="calib-head">
          <strong>{side.toUpperCase()} camera profile</strong>
          {profile.calibratedAt ? (
            <span className="ok">Saved · score {profile.qualityScore}</span>
          ) : (
            <span className="warn">Not calibrated</span>
          )}
        </div>
        <p className="calib-copy">
          Each approach uses its <b>own</b> phone/camera — calibration is stored per side + device
          ({camName}
          {camIdentity?.width ? ` · ${camIdentity.width}×${camIdentity.height}` : ""}). Do not reuse
          another side’s settings.
        </p>
        {mismatched && (
          <p className="calib-meta warn">
            Different camera than last save on {side} — recalibrate this phone.
          </p>
        )}
        <div className="btn-row">
          <button type="button" className="btn primary" disabled={!previewReady} onClick={onStart}>
            {profile.calibratedAt && !mismatched ? "Recalibrate this camera" : "Calibrate this camera"}
          </button>
        </div>
      </div>
    );
  }

  const idx = Math.max(0, STEPS.indexOf(step));

  return (
    <div className="calib-panel active">
      <div className="calib-head">
        <strong>Calibrating {side.toUpperCase()}</strong>
        <span>
          Step {Math.min(idx + 1, STEPS.length)}/{STEPS.length}
        </span>
      </div>
      <p className="calib-meta">{camName}</p>
      <div className="calib-steps" aria-hidden>
        {STEPS.map((s, i) => (
          <i key={s} className={i <= idx ? "on" : ""} />
        ))}
      </div>

      {step === "background" && (
        <>
          <p className="calib-copy">
            <b>1 · Empty approach</b> — clear toys for <em>this</em> camera only. Learn its
            background (wood/glare differ per phone).
          </p>
          <p className="calib-meta">{warming ? "Learning background…" : "Background locked"}</p>
          <div className="btn-row">
            <button type="button" className="btn ghost" onClick={onSkip}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={warming || !previewReady}
              onClick={onNextBackground}
            >
              Next · lighting
            </button>
          </div>
        </>
      )}

      {step === "lighting" && (
        <>
          <p className="calib-copy">
            <b>2 · Lighting</b> — score for this lens/exposure. Ultrawide phones often need different
            sensitivity than main cams.
          </p>
          {quality && (
            <div className="calib-score">
              <div className={`score-num ${quality.score >= 65 ? "ok" : "warn"}`}>{quality.score}</div>
              <ul>
                {quality.tips.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          )}
          <label className="calib-slider">
            Detection sensitivity ({sensitivityLabel(profile.sensitivity)})
            <input
              type="range"
              min={0.6}
              max={1.4}
              step={0.05}
              value={profile.sensitivity}
              onChange={(e) => onSensitivity(Number(e.target.value))}
            />
          </label>
          <div className="btn-row">
            <button type="button" className="btn ghost" onClick={onSkip}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={onNextLighting}>
              Next · size / FOV
            </button>
          </div>
        </>
      )}

      {step === "size" && (
        <>
          <p className="calib-copy">
            <b>3 · Size + lens FOV</b> — one toy in the middle. Optional tape measure of camera→mid
            teaches <em>this phone’s</em> field of view (needed when sides use different cameras).
          </p>
          <div className="size-model">
            <label>
              Object L (cm)
              <input
                type="number"
                min={1}
                max={40}
                step={0.5}
                value={profile.size.objectLengthCm}
                onChange={(e) =>
                  onObjectSize(Number(e.target.value) || 7, profile.size.objectWidthCm)
                }
              />
            </label>
            <label>
              Object W (cm)
              <input
                type="number"
                min={1}
                max={30}
                step={0.5}
                value={profile.size.objectWidthCm}
                onChange={(e) =>
                  onObjectSize(profile.size.objectLengthCm, Number(e.target.value) || 3.5)
                }
              />
            </label>
            <label>
              Tape mid (cm)
              <input
                type="number"
                min={0}
                max={300}
                step={1}
                value={tapeCm || ""}
                placeholder="optional"
                onChange={(e) => onTapeCm(Number(e.target.value) || 0)}
              />
            </label>
            <label>
              HFOV °
              <input
                type="number"
                min={40}
                max={100}
                step={1}
                value={profile.size.hfovDeg}
                onChange={(e) => onHfov(Number(e.target.value) || 70)}
              />
            </label>
          </div>
          <p className="calib-meta">
            {trackCount} object{trackCount === 1 ? "" : "s"} · mid {profile.size.distanceMidCm} cm ·
            FOV {profile.size.hfovDeg}°
            {tapeCm > 0 ? " · tape will set FOV" : ""}
          </p>
          <div className="btn-row">
            <button type="button" className="btn ghost" onClick={onSkip}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={trackCount < 1}
              onClick={onCaptureSize}
            >
              Capture size → lanes
            </button>
          </div>
        </>
      )}

      {step === "lanes" && (
        <>
          <p className="calib-copy">
            <b>4 · Lanes</b> — three toys L·S·R for this framing. Saved only for {side}.
          </p>
          <p className={`calib-meta ${laneOk ? "ok" : "warn"}`}>
            {laneOk
              ? "Three objects seen — ready to lock lanes"
              : `Need 3 side-by-side (now ${trackCount})`}
          </p>
          <div className="btn-row">
            <button type="button" className="btn ghost" onClick={onSkip}>
              Cancel
            </button>
            <button type="button" className="btn primary" disabled={!laneOk} onClick={onCaptureLanes}>
              Lock lanes → finish
            </button>
          </div>
        </>
      )}

      {step === "done" && (
        <>
          <p className="calib-copy">
            <b>Saved for {side.toUpperCase()}</b> — {camName}. Mid {profile.size.distanceMidCm} cm ·
            FOV {profile.size.hfovDeg}° · lanes {(profile.laneSplitLeft * 100).toFixed(0)}%/
            {(profile.laneSplitRight * 100).toFixed(0)}% · score {profile.qualityScore}. Other sides
            keep their own profiles.
          </p>
          <div className="btn-row">
            <button type="button" className="btn primary" onClick={onFinish}>
              Start tracking
            </button>
          </div>
        </>
      )}
    </div>
  );
}
