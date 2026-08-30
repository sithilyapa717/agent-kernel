/** Open a camera stream with fallbacks. Phones need a secure context (HTTPS or localhost). */

export function cameraErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  const text = err instanceof Error ? err.message : String(err);
  if (!window.isSecureContext) {
    return "Camera blocked off localhost. On this PC open http://localhost:5173 (not the LAN IP). Phones need a USB tunnel or localhost.";
  }
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Camera permission denied — allow the camera for this site, then tap Retry camera.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No camera found on this device.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Camera is already in use by another app. Close it, then tap Retry camera.";
  }
  if (name === "OverconstrainedError") {
    return "This camera rejected the requested mode — retrying with defaults.";
  }
  if (name === "AbortError") {
    return "";
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return "This browser cannot open a camera (needs HTTPS or a recent Chrome/Safari).";
  }
  return text ? `Camera failed: ${text}` : "Camera unavailable — use manual count";
}

export async function openCameraStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("getUserMedia is not available");
  }
  const attempts: MediaStreamConstraints[] = [
    {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    },
    {
      audio: false,
      video: { facingMode: "user" },
    },
    { audio: false, video: true },
  ];
  let last: unknown;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      last = err;
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        throw err;
      }
    }
  }
  throw last instanceof Error ? last : new Error("Camera unavailable");
}

export async function attachAndPlay(video: HTMLVideoElement, stream: MediaStream): Promise<void> {
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        video.removeEventListener("loadeddata", onReady);
        video.removeEventListener("error", onErr);
        resolve();
      };
      const onErr = () => {
        video.removeEventListener("loadeddata", onReady);
        video.removeEventListener("error", onErr);
        reject(new Error("Video element failed to load the stream"));
      };
      video.addEventListener("loadeddata", onReady);
      video.addEventListener("error", onErr);
    });
  }
  try {
    await video.play();
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return;
    }
    throw err;
  }
}
