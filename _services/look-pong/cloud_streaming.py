"""Roboflow Cloud Streaming sessions and an authenticated callback-only app.

Video travels over WebRTC. Only signaling, job control and small JSON results
pass through this server; private Roboflow credentials never reach the browser.
"""
import asyncio
from collections import deque
import contextlib
import json
import math
import os
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

import httpx
import anyio
from fastapi import APIRouter, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

TERMINAL = {"stopped", "completed", "cancelled", "error"}
ROOT = Path(__file__).resolve().parent


@dataclass
class Session:
    id: str
    owner: str
    attempt: str
    callback_token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    created: float = field(default_factory=time.monotonic)
    touched: float = field(default_factory=time.monotonic)
    source_id: str | None = None
    job_id: str | None = None
    whip_url: str | None = None
    state: str = "connecting"
    latest_sequence: int = -1
    last_result_at: float | None = None
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=1))
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    cleanup_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    closed: bool = False
    socket_open: bool = False
    last_job_check: float = 0
    last_hold: float = 0


class CloudStreaming:
    def __init__(self, client, *, key=None, workspace=None, callback_origin=None, specification=None):
        self.http = client
        self.key = key if key is not None else os.getenv("ROBOFLOW_API_KEY", "")
        self.workspace = workspace or os.getenv("ROBOFLOW_WORKSPACE", "april-public-yibrz")
        self.callback_origin = (callback_origin or os.getenv("CLOUD_CALLBACK_ORIGIN", "")).rstrip("/")
        self.specification = specification
        self.sessions = {}
        self.lock = asyncio.Lock()
        self.max_sessions = max(1, int(os.getenv("CLOUD_MAX_SESSIONS", "1")))
        self.session_seconds = max(60, int(os.getenv("CLOUD_SESSION_SECONDS", "3300")))
        self.starts_per_hour = max(1, int(os.getenv("CLOUD_STARTS_PER_HOUR", "30")))
        self.starts = deque()
        self.callback_app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
        self.callback_app.add_api_route("/gaze/{session_id}", self.callback, methods=["POST"])

    @property
    def enabled(self):
        return bool(self.key and self.callback_origin.startswith("https://"))

    async def api(self, method, path, *, body=None, idempotency=None):
        headers = {"Authorization": f"Bearer {self.key}"}
        if idempotency:
            headers["Idempotency-Key"] = idempotency
        # A retry reuses the exact request/key so uncertain responses cannot
        # create a second source or billable job.
        for attempt in range(3):
            try:
                response = await self.http.request(method, f"https://api.roboflow.com/{self.workspace}{path}",
                                                   headers=headers, json=body, timeout=20)
                if response.status_code in (429, 502, 503, 504) and attempt < 2:
                    await asyncio.sleep(.5 * (attempt + 1))
                    continue
                if response.is_error:
                    raise HTTPException(502, f"Eye tracking is unavailable (HTTP {response.status_code}). Please retry.")
                return response.json()
            except httpx.RequestError:
                if attempt == 2:
                    raise HTTPException(504, "Eye tracking did not respond. Please retry.") from None
                await asyncio.sleep(.5 * (attempt + 1))

    def get(self, session_id, owner):
        session = self.sessions.get(session_id)
        if not session or not owner or not secrets.compare_digest(session.owner, owner):
            raise HTTPException(404, "Streaming session not found.")
        return session

    def workflow(self):
        if self.specification is not None:
            return self.specification
        path = ROOT / "cloud_workflow.json"
        if not path.is_file():
            raise HTTPException(503, "Eye tracking has not been configured yet.")
        return json.loads(path.read_text())

    async def create(self, owner, attempt):
        if not self.enabled:
            raise HTTPException(503, "Eye tracking is unavailable. Restart the game server.")
        self.workflow()
        async with self.lock:
            for existing in self.sessions.values():
                if existing.owner == owner and existing.attempt == attempt:
                    if existing.closed:
                        raise HTTPException(409, "This connection attempt ended. Start a new session.")
                    return existing
                if existing.owner == owner and (not existing.closed or existing.state == "cleanup_pending"):
                    raise HTTPException(409, "A camera stream is already active. Turn it off before starting another.")
            active = sum(not s.closed or s.state == "cleanup_pending" for s in self.sessions.values())
            if active >= self.max_sessions:
                raise HTTPException(429, "All game spots are busy. Please try again in a few minutes.")
            now = time.monotonic()
            while self.starts and now - self.starts[0] >= 3600:
                self.starts.popleft()
            if len(self.starts) >= self.starts_per_hour:
                raise HTTPException(429, "The demo has reached its hourly limit. Please try again later.")
            self.starts.append(now)
            session = Session(secrets.token_urlsafe(24), owner, attempt)
            self.sessions[session.id] = session
            try:
                body = {"name": "Look Pong camera"}
                if os.getenv("CLOUD_STREAM_CELL"):
                    body["cell"] = os.environ["CLOUD_STREAM_CELL"]
                grant = await self.api("POST", "/video-sources/v1/temporary", body=body,
                                       idempotency=f"pong-source-{session.id}")
                session.source_id = grant["sourceId"]
                session.whip_url = grant["whipUrl"]
                if session.closed:
                    await self.stop(session)
                    raise HTTPException(409, "The camera disconnected while the source was starting.")
                if urlparse(session.whip_url).scheme != "https":
                    raise HTTPException(502, "Roboflow returned an invalid publishing grant.")
                return session
            except BaseException:
                await self.stop(session)
                raise

    async def offer(self, session, sdp):
        async with session.lock:
            if session.closed or session.state != "connecting":
                raise HTTPException(409, "Start a new camera connection.")
            try:
                # Preserve the returned WHIP URL exactly; it carries the
                # one-publisher grant. Never log it or forward the private key.
                response = await self.http.post(session.whip_url, content=sdp,
                                                 headers={"Content-Type": "application/sdp"}, timeout=30)
                if response.status_code not in (200, 201) or not response.text.startswith("v=0"):
                    raise HTTPException(502, "The eye-tracking connection could not be established.")
                if session.closed:
                    raise HTTPException(409, "This camera connection ended.")
                session.state = "publishing"
                return response.text
            except httpx.RequestError:
                raise HTTPException(504, "The eye-tracking connection timed out. Restart the camera.") from None

    async def start(self, session):
        async with session.lock:
            if session.closed:
                raise HTTPException(409, "This stream has ended.")
            if session.job_id:
                return
            if session.state != "publishing":
                raise HTTPException(409, "Connect the camera before starting inference.")
            spec = self.workflow()
            parameters = {"callback_url": f"{self.callback_origin}/gaze/{session.id}",
                          "callback_token": session.callback_token, "model_access_key": self.key, "disable_callback": False}
            inputs = {item["name"] for item in spec["inputs"]}
            body = {"workflowSpecification": spec,
                    "workflowParameters": {key: value for key, value in parameters.items() if key in inputs},
                    "mode": "stream", "purpose": "preview", "recoveryPolicy": "none",
                    "tier": "gpu", "processorSize": os.getenv("CLOUD_STREAM_PROCESSOR", "gpu-s-v1"),
                    "captureBufferSize": 1, "maxFps": 15}
            if self.specification is None and os.getenv("CLOUD_WORKFLOW_ID"):
                body.pop("workflowSpecification")
                body["workflowUrl"] = os.environ["CLOUD_WORKFLOW_ID"]
            result = await self.api("POST", f"/video-sources/v1/{session.source_id}/jobs", body=body,
                                    idempotency=f"pong-job-{session.id}")
            session.job_id = result["job"]["id"]
            session.state = result["job"]["state"]
            if session.closed:
                await self.stop(session)
                raise HTTPException(409, "The camera disconnected while inference was starting.")

    async def status(self, session):
        now = time.monotonic()
        if session.job_id and not session.closed and now - session.last_job_check >= 2:
            data = await self.api("GET", f"/video-jobs/v1/{session.job_id}")
            job = data.get("job", data)
            session.last_job_check = now
            session.state = job["state"]
            if session.state in TERMINAL:
                await self.stop(session)
        return {"id": session.id, "state": session.state, "closed": session.closed,
                "receiving": session.last_result_at is not None and now - session.last_result_at < 2}

    async def callback(self, session_id: str, request: Request):
        session = self.sessions.get(session_id)
        token = request.headers.get("X-Pong-Webhook-Key", "")
        if not session or session.closed or not secrets.compare_digest(session.callback_token, token):
            raise HTTPException(403, "Invalid callback.")
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 32768:
                raise HTTPException(413, "Result too large.")
        try:
            payload = json.loads(body)
            prediction = payload["prediction"]
            sequence = prediction["frame_sequence"]
            if isinstance(sequence, bool) or not isinstance(sequence, int) or not 0 < sequence < 2**32:
                raise ValueError()
            if not isinstance(prediction.get("gazes"), list) or len(prediction["gazes"]) > 1:
                raise ValueError()
            for gaze in prediction["gazes"]:
                if not isinstance(gaze, dict) or not all(isinstance(gaze.get(key), (int, float))
                    and not isinstance(gaze[key], bool) and math.isfinite(gaze[key]) for key in ("yaw", "pitch")):
                    raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise HTTPException(422, "Invalid gaze result.") from None
        if sequence <= session.latest_sequence:
            return {"accepted": False}
        session.latest_sequence = sequence
        session.last_result_at = time.monotonic()
        if session.queue.full():
            session.queue.get_nowait()
        session.queue.put_nowait({"type": "prediction", "prediction": prediction})
        return {"accepted": True}

    async def stop(self, session):
        session.closed = True
        async with session.cleanup_lock:
            await self._stop(session)

    async def _stop(self, session):
        # Stop the source even if job cancellation fails: ending a temporary
        # publishing session also ends every job attached to it.
        failed = False
        if session.job_id:
            try:
                await self.api("POST", f"/video-jobs/v1/{session.job_id}/cancel")
                session.job_id = None
            except HTTPException:
                failed = True
        if session.source_id:
            try:
                await self.api("POST", f"/video-sources/v1/{session.source_id}/stop-session")
                session.source_id = session.whip_url = None
                session.job_id = None
                failed = False
            except HTTPException:
                failed = True
        session.state = "cleanup_pending" if failed else "stopped"

    async def maintain(self):
        while True:
            await asyncio.sleep(5)
            for session in list(self.sessions.values()):
                now = time.monotonic()
                if session.closed or now - session.touched > 45 or now - session.created > self.session_seconds:
                    if session.source_id or session.job_id:
                        await self.stop(session)
                    elif now - session.created > 120:
                        self.sessions.pop(session.id, None)
                    continue
                if session.job_id and now - session.last_hold > 30:
                    try:
                        result = await self.api("POST", f"/video-jobs/v1/{session.job_id}/hold-preview")
                        if not result.get("held"):
                            await self.stop(session)
                        session.last_hold = now
                    except HTTPException:
                        await self.stop(session)

    async def close(self):
        for session in list(self.sessions.values()):
            await self.stop(session)


router = APIRouter(prefix="/api/stream")


def same_origin(request):
    origin = request.headers.get("origin")
    expected = f"{request.url.scheme}://{request.headers.get('host')}".replace("ws://", "http://").replace("wss://", "https://")
    configured = {value.strip() for value in os.getenv("PUBLIC_APP_ORIGINS", "").split(",") if value.strip()}
    allowed = configured or {expected}
    if (os.getenv("APP_ENV") == "production" and not origin) or (origin and origin not in allowed):
        raise HTTPException(403, "Use the game page to control streaming.")


class StartRequest(BaseModel):
    attempt: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")


class OfferRequest(BaseModel):
    sdp: str = Field(min_length=10, max_length=65536)


@router.post("/sessions")
async def create_session(data: StartRequest, request: Request, response: Response):
    same_origin(request)
    owner = request.cookies.get("pong-stream-owner") or secrets.token_urlsafe(32)
    session = await request.app.state.streaming.create(owner, data.attempt)
    response.set_cookie("pong-stream-owner", owner, httponly=True, samesite="strict", secure=request.url.scheme == "https")
    response.headers["Cache-Control"] = "no-store"
    return {"id": session.id}


def owned(request, session_id):
    same_origin(request)
    return request.app.state.streaming.get(session_id, request.cookies.get("pong-stream-owner"))


@router.post("/sessions/{session_id}/offer")
async def offer(session_id: str, data: OfferRequest, request: Request):
    session = owned(request, session_id)
    try:
        return {"sdp": await request.app.state.streaming.offer(session, data.sdp), "type": "answer"}
    except HTTPException:
        await request.app.state.streaming.stop(session)
        raise


@router.post("/sessions/{session_id}/start")
async def start(session_id: str, request: Request):
    session = owned(request, session_id)
    try:
        await request.app.state.streaming.start(session)
        return await request.app.state.streaming.status(session)
    except HTTPException:
        await request.app.state.streaming.stop(session)
        raise


@router.get("/sessions/{session_id}")
async def status(session_id: str, request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return await request.app.state.streaming.status(owned(request, session_id))


@router.post("/sessions/{session_id}/stop")
async def stop(session_id: str, request: Request):
    session = owned(request, session_id)
    await request.app.state.streaming.stop(session)
    return {"state": session.state}


@router.websocket("/sessions/{session_id}/results")
async def results(session_id: str, websocket: WebSocket):
    try:
        session = owned(websocket, session_id)
    except HTTPException:
        await websocket.close(code=1008)
        return
    if session.closed or session.socket_open:
        await websocket.close(code=1008)
        return
    session.socket_open = True
    await websocket.accept()
    session.touched = time.monotonic()

    async def receive():
        while not session.closed:
            message = await asyncio.wait_for(websocket.receive_text(), 30)
            if message != "ping":
                break
            session.touched = time.monotonic()

    async def send():
        while not session.closed:
            try:
                item = await asyncio.wait_for(session.queue.get(), 5)
                await asyncio.wait_for(websocket.send_json(item), 2)
            except asyncio.TimeoutError:
                if session.closed:
                    break

    tasks = [asyncio.create_task(receive()), asyncio.create_task(send())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except asyncio.CancelledError:
        pass
    finally:
        # ASGI can cancel a disconnected request. Cleanup must still stop
        # paid cloud processing, even inside that cancelled request scope.
        with anyio.CancelScope(shield=True):
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            session.socket_open = False
            await websocket.app.state.streaming.stop(session)
            with contextlib.suppress(RuntimeError, WebSocketDisconnect):
                await websocket.close()
