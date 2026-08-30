import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { postCount } from "../api";
import { CalibrationPanel } from "../components/CalibrationPanel";
import {
  analyzeFrameQuality,
  cameraMismatch,
  type CalibStep,
  type CamIdentity,
  type CamProfile,
  type FrameQuality,
  hfovFromTapeAndWidth,
  laneSplitsFromThree,
  loadCamProfile,
  readCamIdentity,
  refineDistanceFromBlob,
  saveCamProfile,
  suggestRoiFromTracks,
} from "../lib/cameraCalibration";
import {
  createTrackerState,
  expectedSizePx,
  frameLooksAlive,
  laneTallies,
  looksLikeLoadingSpinner,
  trackFrame,
  type TrackerState,
  type TrackedVehicle,
} from "../lib/vehicleTracker";
import type { Side } from "../types";

const VALID: Side[] = ["north", "east", "south", "west"];
const DET_W = 320;
const DET_H = 240;
const ALIVE_FRAMES_NEEDED = 8;

type FocusCaps = MediaTrackCapabilities & {
  focusDistance?: { min: number; max: number; step?: number };
  focusMode?: string[];
};
type FocusSettings = MediaTrackSettings & {
  focusDistance?: number;
  focusMode?: string;
};

function readFocusDistanceCm(track: MediaStreamTrack | null): number | null {
  if (!track) return null;
  try {
    const settings = track.getSettings() as FocusSettings;
    const m = settings.focusDistance;
    if (typeof m === "number" && Number.isFinite(m) && m > 0.05 && m < 20) {
      return Math.round(m * 100);
    }
  } catch {
    /* unsupported */
  }
  return null;
}

async function enableContinuousFocus(track: MediaStreamTrack): Promise<"sensor" | "unavailable"> {
  const caps = track.getCapabilities?.() as FocusCaps | undefined;
  if (!caps?.focusDistance) return "unavailable";
  try {
    const modes = caps.focusMode ?? [];
    if (modes.includes("continuous")) {
      await track.applyConstraints({
        advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
      });
    }
  } catch {
    /* ignore */
  }
  return readFocusDistanceCm(track) != null || caps.focusDistance ? "sensor" : "unavailable";
}

export function CapturePage() {
  const params = useParams();
  const side = (params.side || "").toLowerCase() as Side;
  const valid = VALID.includes(side);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const trackerRef = useRef<TrackerState>(createTrackerState());
  const resetBgRef = useRef(false);
  const lastSig = useRef("");
  const aliveStreakRef = useRef(0);
  const profileRef = useRef<CamProfile>(loadCamProfile(side));
  const calibStepRef = useRef<CalibStep>("idle");
  const latestFrameRef = useRef<Uint8ClampedArray | null>(null);
  const vehiclesRef = useRef<TrackedVehicle[]>([]);

  const [manual, setManual] = useState(3);
  const [rightCount, setRightCount] = useState(1);
  const [vehicles, setVehicles] = useState<TrackedVehicle[]>([]);
  const [camOn, setCamOn] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [status, setStatus] = useState("");
  const [autoSend, setAutoSend] = useState(true);
  const [warming, setWarming] = useState(true);
  const [profile, setProfile] = useState<CamProfile>(() => loadCamProfile(side));
  const [calibStep, setCalibStep] = useState<CalibStep>("idle");
  const [quality, setQuality] = useState<FrameQuality | null>(null);
  const [useFocusSensor, setUseFocusSensor] = useState(true);
  const [focusStatus, setFocusStatus] = useState<"checking" | "sensor" | "unavailable">("checking");
  const [focusCm, setFocusCm] = useState<number | null>(null);
  const [promptedCalib, setPromptedCalib] = useState(false);
  const [camIdentity, setCamIdentity] = useState<CamIdentity | null>(null);
  const [tapeCm, setTapeCm] = useState(0);

  const autoSendRef = useRef(autoSend);
  const useFocusRef = useRef(useFocusSensor);
  const videoTrackRef = useRef<MediaStreamTrack | null>(null);
  autoSendRef.current = autoSend;
  useFocusRef.current = useFocusSensor;
  profileRef.current = profile;
  calibStepRef.current = calibStep;
  vehiclesRef.current = vehicles;

  // Reload profile when switching capture side
  useEffect(() => {
    if (!valid) return;
    const p = loadCamProfile(side);
    setProfile(p);
    profileRef.current = p;
    setCalibStep("idle");
    setPromptedCalib(false);
    trackerRef.current = createTrackerState();
    aliveStreakRef.current = 0;
  }, [side, valid]);

  const tallies = laneTallies(vehicles);
  const expectMid = expectedSizePx(DET_H * 0.5, DET_W, DET_H, profile.size);
  const laneOk =
    vehicles.length >= 3 &&
    new Set(vehicles.map((v) => v.lane)).size >= 2;
  const mismatched = cameraMismatch(profile, camIdentity);

  const commitProfile = useCallback(
    (next: CamProfile, persist = true) => {
      setProfile(next);
      profileRef.current = next;
      if (persist) saveCamProfile(side, next);
    },
    [side]
  );

  const send = useCallback(
    async (
      total: number,
      source: string,
      lanes?: { left: number; straight: number; right: number },
      tracks?: TrackedVehicle[]
    ) => {
      if (!valid) return;
      try {
        await postCount({
          side,
          vehicle_count: total,
          left_count: lanes?.left,
          straight_count: lanes?.straight,
          right_count: lanes?.right ?? (source === "manual" ? rightCount : undefined),
          source,
          tracks: source === "camera" ? tracks : undefined,
        });
        setStatus(
          `Sent ${total} (L${lanes?.left ?? "–"} S${lanes?.straight ?? "–"} R${lanes?.right ?? "–"}) → junction`
        );
      } catch {
        setStatus("Failed to send — is the backend running?");
      }
    },
    [side, valid, rightCount]
  );

  const sendLatest = useRef(send);
  sendLatest.current = send;

  useEffect(() => {
    if (!valid) return;
    let stream: MediaStream | null = null;
    let timer: number | undefined;

    async function startCam() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        const track = stream.getVideoTracks()[0] ?? null;
        videoTrackRef.current = track;
        const identity = readCamIdentity(track);
        setCamIdentity(identity);
        const loaded = loadCamProfile(side, identity?.deviceId);
        setProfile(loaded);
        profileRef.current = loaded;
        if (track) {
          const kind = await enableContinuousFocus(track);
          setFocusStatus(kind);
          const cm = readFocusDistanceCm(track);
          setFocusCm(cm);
          if (kind === "sensor" && cm != null && useFocusRef.current && !loaded.calibratedAt) {
            commitProfile(
              {
                ...loaded,
                size: { ...loaded.size, distanceMidCm: cm },
                focusCm: cm,
                camera: identity,
              },
              true
            );
          }
        } else {
          setFocusStatus("unavailable");
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setCamOn(true);
          const tip = loaded.calibratedAt
            ? cameraMismatch(loaded, identity)
              ? "Different camera on this side — recalibrate."
              : `Loaded ${side} profile for this camera.`
            : "Calibrate this phone — each side keeps its own camera profile.";
          setStatus(tip);
        }
      } catch {
        setStatus("Camera unavailable — use manual count");
        setCamOn(false);
        setFocusStatus("unavailable");
      }
    }

    startCam();

    timer = window.setInterval(() => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;

      const clearTracking = (sendEmpty: boolean) => {
        aliveStreakRef.current = 0;
        setPreviewReady(false);
        trackerRef.current.tracks = [];
        trackerRef.current.bg = null;
        trackerRef.current.frames = 0;
        setVehicles([]);
        setWarming(true);
        const overlay = overlayRef.current;
        if (overlay) {
          overlay.width = DET_W;
          overlay.height = DET_H;
          overlay.getContext("2d")?.clearRect(0, 0, DET_W, DET_H);
        }
        if (sendEmpty && autoSendRef.current && lastSig.current !== "empty") {
          lastSig.current = "empty";
          void sendLatest.current(0, "camera", { left: 0, straight: 0, right: 0 }, []);
        }
      };

      const streamLive =
        Boolean(video.srcObject) &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.videoWidth > 16 &&
        video.videoHeight > 16;

      if (!streamLive) {
        clearTracking(false);
        return;
      }

      const cm = readFocusDistanceCm(videoTrackRef.current);
      if (cm != null) {
        setFocusCm((prev) => (prev === cm ? prev : cm));
        if (useFocusRef.current) {
          const cur = profileRef.current;
          if (Math.abs(cur.size.distanceMidCm - cm) >= 2) {
            commitProfile(
              { ...cur, size: { ...cur.size, distanceMidCm: cm }, focusCm: cm },
              true
            );
          }
        }
      }

      const prof = profileRef.current;
      const roi = prof.roi;
      canvas.width = DET_W;
      canvas.height = DET_H;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const sx = vw * roi.left;
      const sy = vh * roi.top;
      const sw = vw * Math.max(0.4, 1 - roi.left - roi.right);
      const sh = vh * Math.max(0.4, 1 - roi.top - roi.bottom);
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, DET_W, DET_H);
      const imageData = ctx.getImageData(0, 0, DET_W, DET_H);
      latestFrameRef.current = imageData.data;

      const pictureOk =
        frameLooksAlive(imageData.data) &&
        !looksLikeLoadingSpinner(imageData.data, DET_W, DET_H);

      if (!pictureOk) {
        clearTracking(true);
        return;
      }

      aliveStreakRef.current += 1;
      if (aliveStreakRef.current < ALIVE_FRAMES_NEEDED) {
        setPreviewReady(false);
        setVehicles([]);
        setWarming(true);
        const overlay = overlayRef.current;
        if (overlay) {
          overlay.width = DET_W;
          overlay.height = DET_H;
          overlay.getContext("2d")?.clearRect(0, 0, DET_W, DET_H);
        }
        return;
      }

      setPreviewReady(true);

      const force = resetBgRef.current;
      resetBgRef.current = false;
      const tuning = {
        laneSplitLeft: prof.laneSplitLeft,
        laneSplitRight: prof.laneSplitRight,
        sensitivity: prof.sensitivity,
        satMin: prof.satMin,
      };
      const { vehicles: tracked, warming: warm } = trackFrame(
        imageData.data,
        DET_W,
        DET_H,
        trackerRef.current,
        force,
        prof.size,
        tuning
      );
      setVehicles(tracked);
      setWarming(warm);

      if (calibStepRef.current === "lighting" || calibStepRef.current === "background") {
        setQuality(analyzeFrameQuality(imageData.data));
      }

      const overlay = overlayRef.current;
      if (overlay) {
        overlay.width = DET_W;
        overlay.height = DET_H;
        const o = overlay.getContext("2d");
        if (o) {
          o.clearRect(0, 0, DET_W, DET_H);
          o.strokeStyle = "rgba(255,176,32,0.55)";
          o.lineWidth = 1;
          o.beginPath();
          o.moveTo(DET_W * prof.laneSplitLeft, 0);
          o.lineTo(DET_W * prof.laneSplitLeft, DET_H);
          o.moveTo(DET_W * prof.laneSplitRight, 0);
          o.lineTo(DET_W * prof.laneSplitRight, DET_H);
          o.stroke();

          o.font = "bold 12px sans-serif";
          for (const v of tracked) {
            const box = v.bbox;
            if (!box) continue;
            o.strokeStyle = v.moving ? "#2ee66b" : "#ffb020";
            o.lineWidth = 2;
            o.strokeRect(box.x, box.y, box.w, box.h);
            o.fillStyle = "#fff";
            o.fillText(
              `${v.track_id} ${v.lane[0].toUpperCase()}${v.moving ? "→" : ""}`,
              box.x,
              Math.max(12, box.y - 3)
            );
          }
        }
      }

      // During calibration, don't spam the junction with partial setups
      if (calibStepRef.current !== "idle" && calibStepRef.current !== "done") return;
      if (warm || !autoSendRef.current) return;

      const t = laneTallies(tracked);
      const sig = tracked
        .map((v) => `${v.track_id}:${v.lane}:${v.moving ? 1 : 0}:${v.depth.toFixed(2)}`)
        .join("|");
      if (sig === lastSig.current) return;
      lastSig.current = sig;
      void sendLatest.current(t.total, "camera", t, tracked);
    }, 350);

    return () => {
      if (timer) window.clearInterval(timer);
      videoTrackRef.current = null;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [valid, commitProfile, side]);

  // Offer calibration once the picture is ready if never calibrated or camera changed
  useEffect(() => {
    if (!previewReady || promptedCalib || calibStep !== "idle") return;
    if (profile.calibratedAt && !mismatched) return;
    setPromptedCalib(true);
    setStatus(
      mismatched
        ? "This side’s camera changed — tap Calibrate this camera."
        : "Live feed ready — calibrate this phone (each side is separate)."
    );
  }, [previewReady, promptedCalib, profile.calibratedAt, calibStep, mismatched]);

  function resetBackground() {
    resetBgRef.current = true;
    aliveStreakRef.current = ALIVE_FRAMES_NEEDED;
    lastSig.current = "";
    setWarming(true);
    setStatus("Background reset — clear the approach, wait for learning, then place cars.");
  }

  function startCalib() {
    resetBgRef.current = true;
    setCalibStep("background");
    setQuality(null);
    setStatus("Calibration: clear the table and hold steady.");
  }

  function skipCalib() {
    setCalibStep("idle");
    setStatus("Calibration cancelled.");
  }

  function nextBackground() {
    const frame = latestFrameRef.current;
    if (frame) setQuality(analyzeFrameQuality(frame));
    setCalibStep("lighting");
  }

  function nextLighting() {
    const frame = latestFrameRef.current;
    const q = frame ? analyzeFrameQuality(frame) : quality;
    if (q) {
      commitProfile({ ...profileRef.current, qualityScore: q.score }, false);
      setQuality(q);
    }
    // Auto-tune sensitivity from glare
    if (q && q.glareFrac > 0.08) {
      commitProfile(
        { ...profileRef.current, sensitivity: Math.max(0.65, profileRef.current.sensitivity - 0.15) },
        false
      );
    }
    setCalibStep("size");
    setStatus("Place one toy in the center of the frame.");
  }

  function captureSize() {
    const list = vehiclesRef.current;
    if (!list.length) return;
    const mid = list.reduce((best, v) => {
      const bx = (v.bbox?.x ?? 0) + (v.bbox?.w ?? 0) / 2;
      const by = (v.bbox?.y ?? 0) + (v.bbox?.h ?? 0) / 2;
      const d = Math.hypot(bx - DET_W / 2, by - DET_H / 2);
      const bestD = Math.hypot(
        (best.bbox?.x ?? 0) + (best.bbox?.w ?? 0) / 2 - DET_W / 2,
        (best.bbox?.y ?? 0) + (best.bbox?.h ?? 0) / 2 - DET_H / 2
      );
      return d < bestD ? v : best;
    }, list[0]);
    if (!mid.bbox) return;
    const cur = profileRef.current;
    let size = { ...cur.size };
    let dist = refineDistanceFromBlob(
      { w: mid.bbox.w, h: mid.bbox.h },
      size,
      DET_W,
      DET_H
    );

    // Tape + pixel width → this phone's HFOV (different lenses per side)
    if (tapeCm > 8) {
      size = {
        ...size,
        hfovDeg: hfovFromTapeAndWidth(
          mid.bbox.w,
          size.objectWidthCm,
          tapeCm,
          DET_W
        ),
        distanceMidCm: Math.round(tapeCm),
      };
      dist = Math.round(tapeCm);
    } else {
      size = { ...size, distanceMidCm: dist };
    }

    commitProfile(
      {
        ...cur,
        size,
        camera: camIdentity,
      },
      false
    );
    setStatus(
      tapeCm > 8
        ? `This camera: mid ${dist} cm, FOV ~${size.hfovDeg}° (from tape).`
        : `Distance ~${dist} cm from measured ${Math.round(mid.bbox.w)}×${Math.round(mid.bbox.h)}px.`
    );
    setCalibStep("lanes");
  }

  function captureLanes() {
    const list = [...vehiclesRef.current].sort(
      (a, b) => (a.bbox?.x ?? 0) + (a.bbox?.w ?? 0) / 2 - ((b.bbox?.x ?? 0) + (b.bbox?.w ?? 0) / 2)
    );
    if (list.length < 3) return;
    const xs = list.slice(0, 3).map((v) => (v.bbox?.x ?? 0) + (v.bbox?.w ?? 0) / 2);
    const splits = laneSplitsFromThree(xs, DET_W);
    const roi = suggestRoiFromTracks(list, DET_W, DET_H);
    const frame = latestFrameRef.current;
    const q = frame ? analyzeFrameQuality(frame) : quality;
    const next: CamProfile = {
      ...profileRef.current,
      ...splits,
      roi,
      qualityScore: q?.score ?? profileRef.current.qualityScore,
      calibratedAt: new Date().toISOString(),
      focusCm: focusCm,
      camera: camIdentity,
    };
    commitProfile(next, true);
    setCalibStep("done");
    setStatus(`Calibration saved for ${side} · ${camIdentity?.label || "this camera"}.`);
  }

  function finishCalib() {
    setCalibStep("idle");
    resetBgRef.current = true;
    setStatus("Tracking with calibrated profile. Auto-send resumes.");
  }

  if (!valid) {
    return (
      <div className="page capture-page">
        <h1>Invalid side</h1>
        <p>Use /capture/north, /capture/east, /capture/south, or /capture/west</p>
        <Link to="/">Back to junction</Link>
      </div>
    );
  }

  return (
    <div className="page capture-page">
      <header className="capture-header">
        <Link to="/">← Junction</Link>
        <h1>{side.toUpperCase()} camera</h1>
        <p>
          Different phones per side are fine — calibrate <b>each</b> capture URL on that phone.
          Profiles are saved per side + camera device.
        </p>
      </header>

      <div className="capture-grid">
        <div className="cam-panel">
          <div className="cam-stage">
            <video ref={videoRef} playsInline muted className="cam-video" />
            <canvas
              ref={overlayRef}
              className={`cam-overlay${previewReady ? " is-ready" : ""}`}
              aria-hidden
            />
            {camOn && !previewReady && (
              <div className="cam-waiting">Waiting for camera picture…</div>
            )}
          </div>
          <canvas ref={canvasRef} className="cam-canvas-hidden" />
          <div className="cam-meta">
            <span className={previewReady ? "ok" : "warn"}>
              {previewReady ? "Camera live" : camOn ? "Connecting…" : "No camera"}
            </span>
            <span>
              {!previewReady
                ? "not tracking yet"
                : warming
                  ? "learning bg…"
                  : calibStep !== "idle" && calibStep !== "done"
                    ? "calibrating"
                    : "tracking"}{" "}
              · total <strong>{previewReady ? tallies.total : 0}</strong>
            </span>
          </div>
          <div className="focus-meta">
            {focusStatus === "sensor" && (
              <span className="ok">
                Focus sensor{focusCm != null ? `: ${focusCm} cm` : " (waiting)"}
              </span>
            )}
            {focusStatus === "unavailable" && (
              <span className="warn">No web focus distance — size step sets cm</span>
            )}
            {profile.calibratedAt && calibStep === "idle" && (
              <span className="ok"> · calibrated</span>
            )}
          </div>

          <CalibrationPanel
            step={calibStep}
            profile={profile}
            quality={quality}
            trackCount={vehicles.length}
            laneOk={laneOk}
            previewReady={previewReady}
            warming={warming}
            side={side}
            camIdentity={camIdentity}
            mismatched={mismatched}
            tapeCm={tapeCm}
            onTapeCm={setTapeCm}
            onStart={startCalib}
            onSkip={skipCalib}
            onNextBackground={nextBackground}
            onNextLighting={nextLighting}
            onCaptureSize={captureSize}
            onCaptureLanes={captureLanes}
            onFinish={finishCalib}
            onSensitivity={(v) => commitProfile({ ...profile, sensitivity: v }, false)}
            onObjectSize={(lengthCm, widthCm) =>
              commitProfile(
                {
                  ...profile,
                  size: { ...profile.size, objectLengthCm: lengthCm, objectWidthCm: widthCm },
                },
                false
              )
            }
            onHfov={(deg) =>
              commitProfile(
                { ...profile, size: { ...profile.size, hfovDeg: deg } },
                false
              )
            }
          />

          <div className="lane-tally">
            <span>
              L <b>{tallies.left}</b>
            </span>
            <span>
              S <b>{tallies.straight}</b>
            </span>
            <span>
              R <b>{tallies.right}</b>
            </span>
          </div>
          <ul className="track-list">
            {vehicles.length === 0 && <li className="muted">No objects tracked</li>}
            {vehicles.map((v) => (
              <li key={v.track_id}>
                {v.track_id} · {v.lane}
                {v.bbox ? ` · ${Math.round(v.bbox.w)}×${Math.round(v.bbox.h)}px` : ""}
                {v.moving ? " · moving → " + v.intent : " · waiting"}
              </li>
            ))}
          </ul>

          <label className="check">
            <input
              type="checkbox"
              checked={useFocusSensor}
              disabled={focusStatus === "unavailable"}
              onChange={(e) => setUseFocusSensor(e.target.checked)}
            />
            Prefer camera focus distance when available
          </label>

          <p className="size-hint">
            Mid {profile.size.distanceMidCm} cm · expect ≈ {Math.round(expectMid.w)}×
            {Math.round(expectMid.h)}px · lanes{" "}
            {(profile.laneSplitLeft * 100).toFixed(0)}/
            {(profile.laneSplitRight * 100).toFixed(0)}%
          </p>

          <label className="check">
            <input
              type="checkbox"
              checked={autoSend}
              onChange={(e) => setAutoSend(e.target.checked)}
            />
            Auto-send tracks to junction
          </label>
          <div className="btn-row">
            <button type="button" className="btn" onClick={resetBackground}>
              Reset background
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => send(tallies.total, "camera", tallies, vehicles)}
            >
              Send now
            </button>
          </div>
        </div>

        <div className="manual-panel">
          <h2>Manual count (demo-safe)</h2>
          <label>
            Vehicles on {side}
            <input
              type="number"
              min={0}
              max={50}
              value={manual}
              onChange={(e) => setManual(Number(e.target.value))}
            />
          </label>
          <label>
            Of which turning right
            <input
              type="number"
              min={0}
              max={50}
              value={rightCount}
              onChange={(e) => setRightCount(Number(e.target.value))}
            />
          </label>
          <div className="btn-row">
            <button type="button" className="btn ghost" onClick={() => setManual((m) => Math.max(0, m - 1))}>
              −
            </button>
            <button type="button" className="btn ghost" onClick={() => setManual((m) => m + 1)}>
              +
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() =>
                send(manual, "manual", {
                  left: 0,
                  straight: Math.max(0, manual - rightCount),
                  right: rightCount,
                })
              }
            >
              Send manual count
            </button>
          </div>
          <div className="quick-sides">
            {VALID.map((s) => (
              <Link key={s} to={`/capture/${s}`} className={s === side ? "active" : ""}>
                {s}
              </Link>
            ))}
          </div>
        </div>
      </div>
      {status && <p className="status-line">{status}</p>}
    </div>
  );
}
