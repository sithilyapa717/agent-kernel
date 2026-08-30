import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { detectFrame, fetchDetectStatus, postCount } from "../api";
import { PhoneCamHint } from "../components/PhoneCamHint";
import { attachAndPlay, cameraErrorMessage, openCameraStream } from "../lib/openCamera";
import {
  createTrackerState,
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
const RF_W = 640;
const RF_H = 480;

/** Same crop CSS `object-fit: cover` uses in a 4:3 preview box. */
function coverCrop(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): { sx: number; sy: number; sw: number; sh: number } {
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;
  if (srcAspect > dstAspect) {
    const sw = srcH * dstAspect;
    return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH };
  }
  const sh = srcW / dstAspect;
  return { sx: 0, sy: (srcH - sh) / 2, sw: srcW, sh };
}

function drawOverlay(
  overlay: HTMLCanvasElement | null,
  w: number,
  h: number,
  tracked: TrackedVehicle[]
) {
  if (!overlay) return;
  overlay.width = w;
  overlay.height = h;
  const o = overlay.getContext("2d");
  if (!o) return;
  o.clearRect(0, 0, w, h);
  o.strokeStyle = "rgba(255,176,32,0.7)";
  o.lineWidth = 1;
  o.beginPath();
  o.moveTo(w / 3, 0);
  o.lineTo(w / 3, h);
  o.moveTo((w * 2) / 3, 0);
  o.lineTo((w * 2) / 3, h);
  o.stroke();
  o.font = "bold 13px sans-serif";
  for (const v of tracked) {
    const box = v.bbox;
    if (!box) continue;
    o.strokeStyle = "#ffb020";
    o.lineWidth = 2;
    o.strokeRect(box.x, box.y, box.w, box.h);
    o.fillStyle = "#fff";
    const tag = v.lane === "straight" ? "M" : v.lane[0].toUpperCase();
    o.fillText(tag, box.x + 3, Math.max(14, box.y - 3));
  }
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
  const videoTrackRef = useRef<MediaStreamTrack | null>(null);

  const [manual, setManual] = useState(3);
  const [rightCount, setRightCount] = useState(1);
  const [vehicles, setVehicles] = useState<TrackedVehicle[]>([]);
  const [camOn, setCamOn] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [status, setStatus] = useState("");
  const [autoSend, setAutoSend] = useState(true);
  const [warming, setWarming] = useState(true);
  const [camEpoch, setCamEpoch] = useState(0);
  const [camError, setCamError] = useState<string | null>(null);
  const [permission, setPermission] = useState<PermissionState | "unknown">("unknown");
  const [detectMode, setDetectMode] = useState<"unknown" | "roboflow" | "local">("unknown");
  const detectBusy = useRef(false);

  const autoSendRef = useRef(autoSend);
  autoSendRef.current = autoSend;
  const detectModeRef = useRef(detectMode);
  detectModeRef.current = detectMode;

  useEffect(() => {
    if (!valid) return;
    trackerRef.current = createTrackerState();
    resetBgRef.current = true;
  }, [side, valid]);

  useEffect(() => {
    let dead = false;
    const perms = navigator.permissions;
    if (!perms?.query) return;
    perms
      .query({ name: "camera" as PermissionName })
      .then((st) => {
        if (dead) return;
        setPermission(st.state);
        st.onchange = () => setPermission(st.state);
      })
      .catch(() => setPermission("unknown"));
    return () => {
      dead = true;
    };
  }, [camEpoch]);

  useEffect(() => {
    let dead = false;
    async function ping() {
      try {
        const st = await fetchDetectStatus();
        if (dead) return;
        setDetectMode(st.ok ? "roboflow" : "local");
      } catch {
        if (!dead) setDetectMode("local");
      }
    }
    void ping();
    const id = window.setInterval(ping, 8000);
    return () => {
      dead = true;
      window.clearInterval(id);
    };
  }, []);

  const tallies = laneTallies(vehicles);

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
          `Sent ${total} (L${lanes?.left ?? "–"} M${lanes?.straight ?? "–"} R${lanes?.right ?? "–"})`
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
    let cancelled = false;
    let stream: MediaStream | null = null;
    let timer: number | undefined;

    async function startCam() {
      setCamOn(false);
      setPreviewReady(false);
      setCamError(null);
      try {
        if (!window.isSecureContext) {
          const msg = cameraErrorMessage(new Error("insecure"));
          setCamError(msg);
          setStatus(msg);
          return;
        }
        stream = await openCameraStream();
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        videoTrackRef.current = stream.getVideoTracks()[0] ?? null;
        const el = videoRef.current;
        if (!el) return;
        await attachAndPlay(el, stream);
        if (cancelled) return;
        setCamOn(true);
        setStatus(
          detectModeRef.current === "roboflow"
            ? "Point at the table. Boxes come from your Roboflow model."
            : "Point at the table. Empty it, tap Learn empty table, then put toys back."
        );
      } catch (err) {
        if (cancelled) return;
        const msg = cameraErrorMessage(err);
        if (msg) {
          setStatus(msg);
          setCamError(msg);
        }
        setCamOn(false);
      }
    }

    void startCam();

    timer = window.setInterval(() => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;

      const streamLive =
        Boolean(video.srcObject) &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.videoWidth > 16 &&
        video.videoHeight > 16;

      if (!streamLive) {
        setPreviewReady(false);
        return;
      }

      const useRf = detectModeRef.current === "roboflow";
      const w = useRf ? RF_W : DET_W;
      const h = useRf ? RF_H : DET_H;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      const crop = coverCrop(video.videoWidth, video.videoHeight, w, h);
      ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h);

      if (useRf) {
        setPreviewReady(true);
        setWarming(false);
        if (detectBusy.current) return;
        detectBusy.current = true;
        const jpeg = canvas.toDataURL("image/jpeg", 0.72);
        void detectFrame(jpeg)
          .then((out) => {
            let tracked = out.tracks;
            const rw = out.image_width ?? 0;
            const rh = out.image_height ?? 0;
            if (rw > 0 && rh > 0 && (rw !== w || rh !== h)) {
              const sx = w / rw;
              const sy = h / rh;
              tracked = tracked.map((t) =>
                t.bbox
                  ? {
                      ...t,
                      bbox: {
                        x: t.bbox.x * sx,
                        y: t.bbox.y * sy,
                        w: t.bbox.w * sx,
                        h: t.bbox.h * sy,
                      },
                    }
                  : t
              );
            }
            setVehicles(tracked);
            drawOverlay(overlayRef.current, w, h, tracked);
            if (!autoSendRef.current) return;
            const t = { left: out.left, straight: out.straight, right: out.right, total: out.total };
            const sig = tracked.map((v) => `${v.track_id}:${v.lane}`).join("|");
            if (sig === lastSig.current) return;
            lastSig.current = sig;
            void sendLatest.current(t.total, "camera", t, tracked);
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : "detect failed";
            setStatus(msg.includes("inference server") ? msg : "Roboflow detect failed — is the Windows app on?");
          })
          .finally(() => {
            detectBusy.current = false;
          });
        return;
      }

      const imageData = ctx.getImageData(0, 0, w, h);
      if (
        !frameLooksAlive(imageData.data) ||
        looksLikeLoadingSpinner(imageData.data, w, h)
      ) {
        setPreviewReady(false);
        return;
      }

      setPreviewReady(true);
      const force = resetBgRef.current;
      resetBgRef.current = false;
      const { vehicles: tracked, warming: warm } = trackFrame(
        imageData.data,
        w,
        h,
        trackerRef.current,
        force
      );
      setVehicles(tracked);
      setWarming(warm);
      drawOverlay(overlayRef.current, w, h, tracked);

      if (warm || !autoSendRef.current) return;
      const t = laneTallies(tracked);
      const sig = tracked.map((v) => `${v.track_id}:${v.lane}`).join("|");
      if (sig === lastSig.current) return;
      lastSig.current = sig;
      void sendLatest.current(t.total, "camera", t, tracked);
    }, detectModeRef.current === "roboflow" ? 800 : 200);

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
      videoTrackRef.current = null;
      const el = videoRef.current;
      if (el) el.srcObject = null;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [valid, side, camEpoch]);

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
          Simple count: each box is <b>left</b>, <b>middle</b>, or <b>right</b> by where it sits.
          {detectMode === "roboflow"
            ? " Using your Roboflow model on this PC."
            : " Learn the empty table first, then put toys down."}
        </p>
        <PhoneCamHint side={side} />
      </header>

      <div className="capture-grid">
        <div className="cam-panel">
          <div className="cam-stage">
            <video ref={videoRef} className="cam-video" playsInline muted autoPlay />
            <canvas
              ref={overlayRef}
              className={`cam-overlay${previewReady ? " is-ready" : ""}`}
              aria-hidden
            />
            {camOn && !previewReady && (
              <div className="cam-waiting">Waiting for camera picture…</div>
            )}
            {!camOn && (
              <div className="cam-blocked">
                <p className="cam-blocked-msg">
                  {camError || "Tap Start camera to allow the camera for this page."}
                </p>
                {permission === "denied" && (
                  <p className="hint">
                    This site is set to Block. Tap the padlock, set Camera to Allow, then Start
                    camera again.
                  </p>
                )}
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => setCamEpoch((n) => n + 1)}
                >
                  Start camera
                </button>
              </div>
            )}
          </div>
          <canvas ref={canvasRef} className="cam-canvas-hidden" />
          <div className="cam-meta">
            <span className={previewReady ? "ok" : "warn"}>
              {previewReady ? "Camera live" : camOn ? "Connecting…" : "No camera"}
            </span>
            <button type="button" className="chip tiny" onClick={() => setCamEpoch((n) => n + 1)}>
              Retry camera
            </button>
            <span>
              {detectMode === "roboflow"
                ? "Roboflow"
                : warming
                  ? "learning empty table…"
                  : "JS tracker"}{" "}
              · total <strong>{previewReady ? tallies.total : 0}</strong>
            </span>
          </div>

          <div className="lane-tally">
            <span>
              L <b>{tallies.left}</b>
            </span>
            <span>
              M <b>{tallies.straight}</b>
            </span>
            <span>
              R <b>{tallies.right}</b>
            </span>
          </div>
          <ul className="track-list">
            {vehicles.length === 0 && (
              <li className="muted">
                {detectMode === "roboflow"
                  ? "No objects yet — put items on the table"
                  : warming
                    ? "Hold still on an empty table…"
                    : "No objects — tap Learn empty table if toys were already down"}
              </li>
            )}
            {vehicles.map((v) => (
              <li key={v.track_id}>
                {v.track_id} · {v.lane === "straight" ? "middle" : v.lane}
              </li>
            ))}
          </ul>

          <label className="check">
            <input
              type="checkbox"
              checked={autoSend}
              onChange={(e) => setAutoSend(e.target.checked)}
            />
            Auto-send counts to junction
          </label>
          <div className="btn-row">
            {detectMode !== "roboflow" && (
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  resetBgRef.current = true;
                  lastSig.current = "";
                  setWarming(true);
                  setVehicles([]);
                  setStatus("Learning empty table — keep toys off for a second.");
                }}
              >
                Learn empty table
              </button>
            )}
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
          <h2>Manual count</h2>
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
