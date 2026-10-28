"""Local game host and credential-protecting proxy to the saved gaze Workflow."""

import asyncio
import hashlib
import json
import math
import os
import secrets
import time
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from urllib.parse import urlparse
from typing import Annotated

import httpx
import numpy as np
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

from cloud_streaming import CloudStreaming, router as streaming_router, same_origin

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
INFERENCE_URL = os.getenv("INFERENCE_API_URL", "http://127.0.0.1:9001").rstrip("/")
WORKSPACE = os.getenv("ROBOFLOW_WORKSPACE", "april-public-yibrz")
WORKFLOW = os.getenv("ROBOFLOW_WORKFLOW_ID", "eye-gaze-l2cs-net")
LOCAL = urlparse(INFERENCE_URL).hostname in {"localhost", "127.0.0.1", "::1"}


def select_player_gaze(gazes):
    def finite(value):
        return isinstance(value, (int, float)) and math.isfinite(value)

    def face_area(gaze):
        face = gaze.get("face") or {}
        return face["width"] * face["height"] if all(finite(face.get(key)) for key in ("x", "y", "width", "height")) and face["width"] > 0 and face["height"] > 0 else 0

    candidates = [gaze for gaze in gazes if isinstance(gaze, dict) and finite(gaze.get("yaw")) and finite(gaze.get("pitch"))]
    return max(candidates, key=face_area, default=None)


@asynccontextmanager
async def lifespan(app):
    if os.getenv("APP_ENV") == "production":
        required = ("ROBOFLOW_API_KEY", "ROBOFLOW_PUBLISHABLE_KEY", "CLOUD_CALLBACK_ORIGIN")
        if any(not os.getenv(name) for name in required):
            raise RuntimeError("Set the Roboflow keys and HTTPS callback origin before starting the service.")
        if not os.environ["CLOUD_CALLBACK_ORIGIN"].startswith("https://"):
            raise RuntimeError("The callback origin must use HTTPS.")
    app.state.client = httpx.AsyncClient(timeout=60)
    app.state.lock = asyncio.Lock()
    app.state.calibrations = {}
    app.state.streaming = CloudStreaming(app.state.client)
    maintenance = asyncio.create_task(app.state.streaming.maintain())
    callback_server = callback_task = None
    if app.state.streaming.enabled and os.getenv("CLOUD_CALLBACK_INLINE") != "1":
        import uvicorn

        class CallbackServer(uvicorn.Server):
            @contextmanager
            def capture_signals(self):
                # The main game server owns shutdown and must cancel cloud jobs
                # before closing this callback listener. A nested signal handler
                # would otherwise intercept SIGTERM and leave the parent alive.
                yield

        callback_server = CallbackServer(uvicorn.Config(app.state.streaming.callback_app,
            host="127.0.0.1", port=int(os.getenv("CLOUD_CALLBACK_PORT", "3001")), log_config=None, log_level=None, access_log=False))
        callback_task = asyncio.create_task(callback_server.serve())
    try:
        yield
    finally:
        maintenance.cancel()
        await asyncio.gather(maintenance, return_exceptions=True)
        await app.state.streaming.close()
        if callback_server:
            callback_server.should_exit = True
            await callback_task
        await app.state.client.aclose()


class RevalidatedStaticFiles(StaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


app = FastAPI(title="Look / Pong", lifespan=lifespan,
    docs_url=None if os.getenv("APP_ENV") == "production" else "/docs",
    redoc_url=None if os.getenv("APP_ENV") == "production" else "/redoc")
app.mount("/assets", RevalidatedStaticFiles(directory=ROOT / "web"), name="assets")
app.include_router(streaming_router)
origins = [value.strip() for value in os.getenv("PUBLIC_APP_ORIGINS", "").split(",") if value.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE"], allow_headers=["Content-Type"])


@app.middleware("http")
async def public_api_policy(request: Request, call_next):
    if os.getenv("APP_ENV") == "production":
        if request.url.path == "/api/gaze":
            return JSONResponse({"detail": "Use the streaming connection."}, status_code=404)
        if request.url.path.startswith("/api/") and request.method not in {"GET", "OPTIONS", "HEAD"}:
            try:
                same_origin(request)
            except HTTPException as error:
                return JSONResponse({"detail": error.detail}, status_code=error.status_code)
    response = await call_next(request)
    response.headers["X-Robots-Tag"] = "noindex"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/healthz")
async def health():
    return {"status": "ok"}


@app.post("/gaze/{session_id}")
async def cloud_callback(session_id: str, request: Request):
    if os.getenv("CLOUD_CALLBACK_INLINE") != "1":
        raise HTTPException(404)
    return await request.app.state.streaming.callback(session_id, request)



class FaceCrop(BaseModel):
    x: float = Field(ge=0, allow_inf_nan=False)
    y: float = Field(ge=0, allow_inf_nan=False)
    width: int = Field(ge=40, le=4096)
    height: int = Field(ge=40, le=4096)
    image_width: int = Field(gt=0, le=4096)
    image_height: int = Field(gt=0, le=4096)

    @model_validator(mode="after")
    def within_frame(self):
        if not (self.width / 2 <= self.x <= self.image_width - self.width / 2
                and self.height / 2 <= self.y <= self.image_height - self.height / 2):
            raise ValueError("Face crop must be inside its original camera frame")
        return self


class Frame(BaseModel):
    image: str = Field(min_length=10, max_length=2_000_000)
    captured_at: float = Field(allow_inf_nan=False)
    calibration_id: str | None = Field(default=None, max_length=64)
    face_crop: FaceCrop | None = None


UnitCoordinate = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]


class GazeSample(BaseModel):
    yaw: float = Field(allow_inf_nan=False)
    pitch: float = Field(allow_inf_nan=False)
    captured_at: float = Field(ge=0, allow_inf_nan=False)


class CalibrationPoint(BaseModel):
    target: tuple[UnitCoordinate, UnitCoordinate]
    samples: list[GazeSample] = Field(min_length=3, max_length=60)


class CalibrationRequest(BaseModel):
    points: list[CalibrationPoint] = Field(min_length=9, max_length=18)
    viewport: tuple[Annotated[int, Field(gt=0, le=32768)], Annotated[int, Field(gt=0, le=32768)]]

    @model_validator(mode="after")
    def complete_collection(self):
        if len(self.points) not in (9, 18):
            raise ValueError("Complete all 9 initial calibration points or all 18 recalibration points.")
        return self


def expire_calibrations():
    now = time.monotonic()
    for key, profile in list(app.state.calibrations.items()):
        if profile["expires_at"] <= now:
            del app.state.calibrations[key]


@app.post("/api/calibration")
async def calibrate(request: CalibrationRequest, http_request: Request):
    owner = http_request.cookies.get("pong-stream-owner")
    if os.getenv("APP_ENV") == "production" and not owner:
        raise HTTPException(401, "Start eye tracking before calibrating.")
    # Learn a session-specific screen mapping alongside L2CS-Net, without
    # changing shared model weights or retaining camera images.
    angles = []
    for point in request.points:
        samples = np.array([[s.yaw, s.pitch] for s in point.samples])
        center = np.median(samples, axis=0)
        distances = np.linalg.norm(samples - center, axis=1)
        clean = samples[distances <= max(.012, float(np.median(distances)) * 2.8)]
        angles.append(np.median(clean, axis=0))
    angles = np.array(angles)
    targets = np.array([p.target for p in request.points])
    mean, scale = angles.mean(axis=0), angles.std(axis=0)
    if np.any(scale < .006):
        raise HTTPException(422, "We couldn’t distinguish enough eye movement. Try again with your face well lit and the camera closer.")
    rows = np.column_stack((np.ones(len(angles)), (angles - mean) / scale))
    if np.linalg.matrix_rank(rows) < 3:
        raise HTTPException(422, "Eye movement was too similar across targets. Please recalibrate.")
    weights = np.linalg.solve(rows.T @ rows + np.diag([0, .03, .03]), rows.T @ targets)
    fit_rmse = float(np.sqrt(np.mean(np.sum((rows @ weights - targets) ** 2, axis=1))))
    if not np.all(np.isfinite(weights)) or not math.isfinite(fit_rmse):
        raise HTTPException(422, "Eye tracking couldn’t produce a usable screen map. Please try again.")
    # A completed collection can be noisy or nonlinear. Keep the
    # best-fit mapping and report its accuracy instead of forcing another round.
    # These are residuals on the collected targets, not independent validation.
    quality = {"fit_rmse": fit_rmse, "approximate": fit_rmse > .15}
    model = {"mean": mean.tolist(), "scale": scale.tolist(), "x": weights[:, 0].tolist(), "y": weights[:, 1].tolist()}
    expire_calibrations()
    if len(app.state.calibrations) >= 128:
        raise HTTPException(503, "Too many active calibrations. Please try again shortly.")
    profile_id = secrets.token_urlsafe(24)
    app.state.calibrations[profile_id] = {
        "owner": owner, "model": model, "quality": quality, "points": request.model_dump(mode="json")["points"],
        "viewport": request.viewport, "expires_at": time.monotonic() + 7200,
    }
    return {"calibration_id": profile_id, "model": model, "quality": quality}


@app.delete("/api/calibration/{profile_id}")
async def forget_calibration(profile_id: str, request: Request):
    profile = app.state.calibrations.get(profile_id)
    if os.getenv("APP_ENV") == "production" and profile and profile.get("owner") != request.cookies.get("pong-stream-owner"):
        raise HTTPException(404, "Calibration not found.")
    app.state.calibrations.pop(profile_id, None)
    return {"deleted": True}


@app.get("/")
async def home():
    if os.getenv("APP_ENV") == "production":
        return JSONResponse({"game_url": "https://josephofiowa.com/look-pong/"})
    # Version the entire module graph, including the lazily loaded detector.
    # Otherwise Chrome can combine a fresh app with a cached older interface.
    assets = {f"/assets/{path.name}": f"/assets/{path.name}?v={hashlib.sha256(path.read_bytes()).hexdigest()[:16]}"
              for path in (ROOT / "web").iterdir() if path.suffix in (".js", ".css")}
    html = (ROOT / "web/index.html").read_text()
    for path, versioned in assets.items():
        html = html.replace(f'"{path}"', f'"{versioned}"')
    imports = json.dumps({"imports": {path: url for path, url in assets.items() if path.endswith(".js")}})
    html = html.replace('<script type="module"', f'<script type="importmap">{imports}</script>\n  <script type="module"', 1)
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


@app.get("/api/config")
async def config(request: Request, response: Response):
    if os.getenv("APP_ENV") == "production" and not request.cookies.get("pong-stream-owner"):
        response.set_cookie("pong-stream-owner", secrets.token_urlsafe(32), httponly=True, secure=True, samesite="strict")
    publishable_key = os.getenv("ROBOFLOW_PUBLISHABLE_KEY", "")
    face_detector = None
    if publishable_key.startswith("rf_"):
        face_detector = {"model_id": os.getenv("ROBOFLOW_FACE_MODEL", "april-public-yibrz/never-gonna-20-rfdetr-small-t1"),
                         "publishable_key": publishable_key, "face_class": os.getenv("ROBOFLOW_FACE_CLASS", "face"),
                         "api_base": "/api/browser-model"}
    transport = os.getenv("GAZE_TRANSPORT", "http")
    return {"api_origin": str(request.base_url).rstrip("/"), "processing": "cloud" if transport == "cloud-streaming" or not LOCAL else "local",
            "transport": transport,
            "workflow": os.getenv("CLOUD_WORKFLOW_ID", "look-pong-cloud-gaze-streaming") if transport == "cloud-streaming" else WORKFLOW,
            "face_detector": face_detector}


@app.get("/api/browser-model/tfjs/model/{model_id:path}")
async def browser_model_metadata(model_id: str):
    # Only the configured model's metadata is proxied. Model execution and
    # weights stay in the browser; this is not a general-purpose API proxy.
    configured = os.getenv("ROBOFLOW_FACE_MODEL", "april-public-yibrz/never-gonna-20-rfdetr-small-t1")
    if model_id != configured:
        raise HTTPException(404, "Face model not configured.")
    key = os.getenv("ROBOFLOW_PUBLISHABLE_KEY", "")
    if not key.startswith("rf_"):
        raise HTTPException(503, "Browser face detection is not configured.")
    try:
        response = await app.state.client.get(f"https://api.roboflow.com/tfjs/model/{configured}",
            params={"publishable_key": key}, timeout=15)
        response.raise_for_status()
        return response.json()
    except (httpx.HTTPError, ValueError):
        raise HTTPException(502, "The browser face model could not load. Restart the camera to retry.") from None


@app.get("/vendor/inference.es.js")
async def browser_inference_library():
    library = ROOT / "node_modules/inferencejs/dist/inference.es.js"
    if not library.is_file():
        raise HTTPException(503, "Install browser dependencies with npm ci")
    return FileResponse(library, media_type="text/javascript")


@app.post("/api/gaze")
async def gaze(frame: Frame):
    started = time.perf_counter()
    expire_calibrations()
    profile = app.state.calibrations.get(frame.calibration_id) if frame.calibration_id else None
    if frame.calibration_id and profile is None:
        raise HTTPException(409, "Your calibration expired. Please recalibrate.")
    key = os.getenv("ROBOFLOW_API_KEY")
    if not key:
        raise HTTPException(503, "The game server needs its Roboflow API key configured.")
    if app.state.lock.locked():
        raise HTTPException(429, "A frame is already being processed. Send the newest frame next.")
    async with app.state.lock:
        try:
            workflow_started = time.perf_counter()
            response = await app.state.client.post(
                f"{INFERENCE_URL}/infer/workflows/{WORKSPACE}/{WORKFLOW}",
                headers={"Authorization": f"Bearer {key}"},
                json={"inputs": {"image": {"type": "base64", "value": frame.image},
                                 "max_faces": 1, "input_is_face_crop": frame.face_crop is not None},
                      "use_cache": True},
            )
            response.raise_for_status()
            workflow_ms = (time.perf_counter() - workflow_started) * 1000
            data = response.json()["outputs"][0]
            # Request the largest face from the Workflow and defensively select
            # one player if an upstream version still returns extra detections.
            result = select_player_gaze(data["gazes"])
            if frame.face_crop:
                crop = frame.face_crop
                # L2CS sees a crop, but overlays use the original unmirrored
                # camera coordinates. Never cache one player's crop globally.
                data["image_size"] = {"width": crop.image_width, "height": crop.image_height}
                if result is not None:
                    result["face"] = crop.model_dump(include={"x", "y", "width", "height"})
            screen_point = None
            if profile and result is not None:
                model = profile["model"]
                angles = np.array([result["yaw"], result["pitch"]])
                if np.all(np.isfinite(angles)):
                    features = np.r_[1, (angles - model["mean"]) / model["scale"]]
                    screen_point = np.clip([features @ model["x"], features @ model["y"]], 0, 1).tolist()
                    profile["expires_at"] = time.monotonic() + 7200
            return {"captured_at": frame.captured_at, "gazes": [result] if result is not None else [],
                    "calibration_id": frame.calibration_id, "screen_point": screen_point,
                    "face_count": data.get("face_count", 0), "image_size": data.get("image_size"),
                    "timing": {"workflow_ms": round(workflow_ms, 1), "server_ms": round((time.perf_counter() - started) * 1000, 1)}}
        except httpx.ConnectError:
            raise HTTPException(503, "Eye tracking is offline. Start the local Inference server and try again.") from None
        except httpx.TimeoutException:
            raise HTTPException(504, "Eye tracking is taking too long. Check the Inference server and try again.") from None
        except httpx.RequestError:
            raise HTTPException(502, "The connection to eye tracking was interrupted. Please try again.") from None
        except (httpx.HTTPStatusError, KeyError, ValueError):
            # Upstream errors may contain credentials or signed model URLs.
            raise HTTPException(502, "The gaze Workflow could not process this frame. Check the Inference server.") from None


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=3000)
