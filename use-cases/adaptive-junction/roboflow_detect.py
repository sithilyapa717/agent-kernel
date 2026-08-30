"""Call the local Roboflow Inference Server (Images / Self-Hosted)."""
from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from models import TrackedVehicle

_DIR = Path(__file__).resolve().parent
_INFER_LOCK = threading.Lock()


def _load_dotenv() -> None:
    path = _DIR / ".env"
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = val


_load_dotenv()

DEFAULT_API_URL = "http://127.0.0.1:9001"
DEFAULT_WORKSPACE = "sithil-yapa"
DEFAULT_MODEL_ID = "tabletop-object-counter/1"
DEFAULT_WORKFLOW_ID = ""
DEFAULT_CONFIDENCE = 0.35


def _cfg() -> dict[str, Any]:
    return {
        "api_url": os.environ.get("ROBOFLOW_API_URL", DEFAULT_API_URL).rstrip("/"),
        "api_key": os.environ.get("ROBOFLOW_API_KEY", "").strip().strip('"').strip("'"),
        "workspace": os.environ.get("ROBOFLOW_WORKSPACE", DEFAULT_WORKSPACE).strip(),
        "model_id": os.environ.get("ROBOFLOW_MODEL_ID", DEFAULT_MODEL_ID).strip(),
        "workflow_id": os.environ.get("ROBOFLOW_WORKFLOW_ID", DEFAULT_WORKFLOW_ID).strip(),
        "confidence": float(os.environ.get("ROBOFLOW_CONFIDENCE", str(DEFAULT_CONFIDENCE))),
    }


def status() -> dict[str, Any]:
    cfg = _cfg()
    server_up, error = _probe(cfg["api_url"])
    ready = server_up and bool(cfg["api_key"]) and bool(cfg["model_id"] or cfg["workflow_id"])
    return {
        "ok": ready,
        "mode": "roboflow" if ready else "offline",
        "api_url": cfg["api_url"],
        "workspace": cfg["workspace"],
        "model_id": cfg["model_id"],
        "workflow_id": cfg["workflow_id"],
        "has_api_key": bool(cfg["api_key"]),
        "server_up": server_up,
        "error": error,
    }


def detect_jpeg(image_bytes: bytes) -> dict[str, Any]:
    """Run the workflow and return tracks + lane tallies."""
    cfg = _cfg()
    if not cfg["api_key"]:
        raise RuntimeError("ROBOFLOW_API_KEY is missing. Put it in use-cases/adaptive-junction/.env")
    if not cfg["model_id"] and not cfg["workflow_id"]:
        raise RuntimeError("Set ROBOFLOW_MODEL_ID (e.g. tabletop-object-counter/1)")

    import base64

    b64 = base64.b64encode(image_bytes).decode("ascii")
    with _INFER_LOCK:
        if cfg["model_id"]:
            url = f"{cfg['api_url']}/{cfg['model_id']}"
            raw = _post_bytes(
                url,
                b64.encode("ascii"),
                cfg["api_key"],
                content_type="application/x-www-form-urlencoded",
            )
        else:
            url = f"{cfg['api_url']}/infer/workflows/{cfg['workspace']}/{cfg['workflow_id']}"
            raw = _post_bytes(
                url,
                json.dumps({"inputs": {"image": {"type": "base64", "value": b64}}}).encode("utf-8"),
                cfg["api_key"],
                content_type="application/json",
            )
    preds, img_w, img_h = extract_predictions(raw)
    tracks = boxes_to_tracks(preds, img_w, img_h, cfg["confidence"])
    left = sum(1 for t in tracks if t.lane == "left")
    straight = sum(1 for t in tracks if t.lane == "straight")
    right = sum(1 for t in tracks if t.lane == "right")
    return {
        "tracks": [t.model_dump() for t in tracks],
        "left": left,
        "straight": straight,
        "right": right,
        "total": left + straight + right,
        "image_width": img_w,
        "image_height": img_h,
    }


def extract_predictions(raw: Any) -> tuple[list[dict[str, Any]], int, int]:
    preds: list[dict[str, Any]] = []
    size = {"w": 0, "h": 0}

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            image = node.get("image")
            if isinstance(image, dict):
                w = image.get("width") or image.get("w")
                h = image.get("height") or image.get("h")
                if isinstance(w, (int, float)) and isinstance(h, (int, float)) and w and h:
                    size["w"], size["h"] = int(w), int(h)
            items = node.get("predictions")
            if isinstance(items, list) and items and isinstance(items[0], dict) and _looks_like_box(items[0]):
                preds.extend(p for p in items if isinstance(p, dict) and _looks_like_box(p))
                return
            for val in node.values():
                walk(val)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(raw)
    return preds, size["w"], size["h"]


def boxes_to_tracks(
    preds: list[dict[str, Any]],
    img_w: int,
    img_h: int,
    confidence: float,
) -> list[TrackedVehicle]:
    tracks: list[TrackedVehicle] = []
    for i, p in enumerate(preds, start=1):
        conf = float(p.get("confidence", p.get("confidence_score", 1.0)) or 0.0)
        if conf < confidence:
            continue
        box = _box_xywh(p)
        if box is None:
            continue
        x, y, w, h = box
        cx = x + w / 2
        width = img_w if img_w > 0 else max(cx * 2, x + w, 1)
        height = img_h if img_h > 0 else max(y + h, 1)
        lane = _lane_of(cx, width)
        tracks.append(
            TrackedVehicle(
                track_id=str(p.get("detection_id") or p.get("class") or i),
                lane=lane,
                depth=min(1.0, max(0.0, (y + h / 2) / height)),
                moving=False,
                intent="straight",
                bbox={"x": x, "y": y, "w": w, "h": h},
            )
        )
        if len(tracks) >= 12:
            break
    return _stack_by_lane(tracks)


def _stack_by_lane(tracks: list[TrackedVehicle]) -> list[TrackedVehicle]:
    """Stable ids (l1, m1, r2, …) and queue depth so the junction can stack cars."""
    buckets: dict[str, list[TrackedVehicle]] = {"left": [], "straight": [], "right": []}
    for t in tracks:
        buckets[t.lane].append(t)
    stacked: list[TrackedVehicle] = []
    prefix = {"left": "l", "straight": "m", "right": "r"}
    for lane, group in buckets.items():
        group.sort(key=lambda t: (t.depth, t.bbox.x if t.bbox else 0), reverse=True)
        n = len(group)
        for i, t in enumerate(group):
            depth = 1.0 if n <= 1 else 1.0 - i / n
            stacked.append(
                t.model_copy(update={"track_id": f"{prefix[lane]}{i + 1}", "depth": depth})
            )
    return stacked


def _looks_like_box(item: dict[str, Any]) -> bool:
    return ("x" in item and "width" in item) or ("x" in item and "y" in item and "w" in item)


def _box_xywh(p: dict[str, Any]) -> tuple[float, float, float, float] | None:
    if "width" in p and "height" in p and "x" in p and "y" in p:
        w, h = float(p["width"]), float(p["height"])
        return float(p["x"]) - w / 2, float(p["y"]) - h / 2, w, h
    if all(k in p for k in ("x", "y", "w", "h")):
        return float(p["x"]), float(p["y"]), float(p["w"]), float(p["h"])
    return None


def _lane_of(cx: float, width: float) -> str:
    t = cx / width if width else 0.5
    if t < 1 / 3:
        return "left"
    if t < 2 / 3:
        return "straight"
    return "right"


def _probe(api_url: str) -> tuple[bool, str | None]:
    try:
        req = urllib.request.Request(api_url, method="GET")
        with urllib.request.urlopen(req, timeout=1.5) as resp:
            resp.read(64)
        return True, None
    except urllib.error.HTTPError as exc:
        # Any HTTP response means the process is up.
        return True, None if exc.code < 500 else f"inference server HTTP {exc.code}"
    except Exception as exc:
        return False, f"inference server not reachable at {api_url} ({exc})"


def _post_bytes(url: str, body: bytes, api_key: str, content_type: str) -> Any:
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": content_type,
            "Authorization": f"Bearer {api_key}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except TimeoutError as exc:
        raise RuntimeError(
            "Inference server timed out — first run downloads the model, wait ~1 min and retry"
        ) from exc
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:400]
        raise RuntimeError(f"Roboflow HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(
            "Inference server is not running on port 9001. Start the Roboflow Windows app."
        ) from exc
