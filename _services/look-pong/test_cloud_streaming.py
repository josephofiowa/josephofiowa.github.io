import asyncio
import json
import time
from contextlib import asynccontextmanager

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from cloud_streaming import CloudStreaming, Session, router


SPEC = {"version": "1.0", "inputs": [{"name": name} for name in
        ("image", "callback_url", "callback_token", "model_access_key")], "steps": [], "outputs": []}


@pytest.fixture
def rig():
    calls = []
    state = {"job": "running", "cancel_fails": False, "job_retries": 0}

    def upstream(request):
        calls.append(request)
        path = request.url.path
        if path.endswith("/temporary"):
            return httpx.Response(200, json={"sourceId": "tmp-test", "whipUrl": "https://relay.example/whip?key=secret-grant"})
        if path.endswith("/whip"):
            assert "Authorization" not in request.headers
            return httpx.Response(201, text="v=0\r\na=answer\r\n")
        if path.endswith("/jobs"):
            if state["job_retries"]:
                state["job_retries"] -= 1
                raise httpx.ReadTimeout("Response was lost", request=request)
            return httpx.Response(201, json={"job": {"id": "job-test", "state": "queued"}})
        if path.endswith("/cancel") and state["cancel_fails"]:
            return httpx.Response(403, json={"message": "secret-upstream-error"})
        if path.endswith("/stop-session") or path.endswith("/cancel"):
            return httpx.Response(200, json={"ok": True})
        if path.endswith("/hold-preview"):
            return httpx.Response(200, json={"held": True})
        return httpx.Response(200, json={"job": {"state": state["job"]}})

    @asynccontextmanager
    async def lifespan(app):
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as http:
            app.state.streaming = CloudStreaming(http, key="private-workspace-key", workspace="test",
                callback_origin="https://callback.example", specification=SPEC)
            yield
            await app.state.streaming.close()

    app = FastAPI(lifespan=lifespan)
    app.include_router(router)
    with TestClient(app) as client:
        yield client, app.state.streaming, calls, state


def connect(client, attempt="first-attempt"):
    created = client.post("/api/stream/sessions", json={"attempt": attempt})
    assert created.status_code == 200
    identifier = created.json()["id"]
    assert client.post(f"/api/stream/sessions/{identifier}/offer", json={"sdp": "v=0\r\na=offer\r\n"}).status_code == 200
    return identifier


def test_stream_endpoint_uses_temporary_source_streaming_gpu_and_private_parameters(rig):
    client, manager, calls, _ = rig
    identifier = connect(client)
    response = client.post(f"/api/stream/sessions/{identifier}/start")
    assert response.status_code == 200
    assert response.json()["state"] == "running"
    job = next(call for call in calls if call.url.path.endswith("/jobs"))
    body = json.loads(job.content)
    assert body["mode"] == "stream"
    assert body["purpose"] == "preview"
    assert body["captureBufferSize"] == 1
    assert body["processorSize"] == "gpu-s-v1"
    assert body["maxFps"] == 15
    assert body["recoveryPolicy"] == "none"
    assert body["workflowParameters"]["model_access_key"] == "private-workspace-key"
    assert body["workflowParameters"]["callback_url"].endswith(f"/gaze/{identifier}")
    for secret in ("private-workspace-key", "secret-grant", manager.sessions[identifier].callback_token):
        assert secret not in response.text


def test_start_retries_reuse_the_same_job_key_and_payload(rig):
    client, _, calls, state = rig
    identifier = connect(client)
    state["job_retries"] = 1
    assert client.post(f"/api/stream/sessions/{identifier}/start").status_code == 200
    assert client.post(f"/api/stream/sessions/{identifier}/start").status_code == 200
    jobs = [call for call in calls if call.url.path.endswith("/jobs")]
    assert len(jobs) == 2
    assert jobs[0].headers["Idempotency-Key"] == jobs[1].headers["Idempotency-Key"]
    assert jobs[0].content == jobs[1].content


def test_duplicate_create_is_idempotent_and_one_camera_is_allowed(rig):
    client, _, calls, _ = rig
    first = client.post("/api/stream/sessions", json={"attempt": "first-attempt"})
    second = client.post("/api/stream/sessions", json={"attempt": "first-attempt"})
    assert first.json() == second.json()
    assert len([call for call in calls if call.url.path.endswith("/temporary")]) == 1
    assert client.post("/api/stream/sessions", json={"attempt": "second-attempt"}).status_code == 409


def test_cross_origin_requests_and_other_session_owners_are_rejected(rig):
    client, _, _, _ = rig
    assert client.post("/api/stream/sessions", json={"attempt": "first-attempt"}, headers={"Origin": "https://untrusted.example"}).status_code == 403
    identifier = connect(client)
    client.cookies.clear()
    assert client.get(f"/api/stream/sessions/{identifier}").status_code == 404
    assert client.post(f"/api/stream/sessions/{identifier}/stop").status_code == 404


def test_stop_ends_the_source_even_if_job_cancellation_fails(rig):
    client, manager, calls, state = rig
    identifier = connect(client)
    client.post(f"/api/stream/sessions/{identifier}/start")
    state["cancel_fails"] = True
    response = client.post(f"/api/stream/sessions/{identifier}/stop")
    assert response.json()["state"] == "stopped"
    assert any(call.url.path.endswith("/stop-session") for call in calls)
    assert manager.sessions[identifier].closed
    assert manager.sessions[identifier].job_id is None
    assert "secret-upstream-error" not in response.text


def test_callback_is_authenticated_bounded_and_keeps_only_the_latest_result(rig):
    client, manager, _, _ = rig
    identifier = connect(client)
    session = manager.sessions[identifier]
    with TestClient(manager.callback_app) as callback:
        path = f"/gaze/{identifier}"
        prediction = {"frame_sequence": 1, "gazes": [{"yaw": .1, "pitch": .2}]}
        assert callback.post(path, json={"prediction": prediction}).status_code == 403
        headers = {"X-Pong-Webhook-Key": session.callback_token}
        assert callback.post(path, json={"prediction": prediction}, headers=headers).json()["accepted"]
        assert not callback.post(path, json={"prediction": prediction}, headers=headers).json()["accepted"]
        prediction["frame_sequence"] = 3
        assert callback.post(path, json={"prediction": prediction}, headers=headers).status_code == 200
        prediction["frame_sequence"] = 2
        assert not callback.post(path, json={"prediction": prediction}, headers=headers).json()["accepted"]
        assert session.queue.qsize() == 1
        assert session.queue.get_nowait()["prediction"]["frame_sequence"] == 3
        assert callback.post(path, content=b"x" * 32769, headers=headers).status_code == 413
        assert callback.get("/").status_code == 404
        assert callback.get("/api/config").status_code == 404
        assert callback.get("/docs").status_code == 404
        client.post(f"/api/stream/sessions/{identifier}/stop")
        assert callback.post(path, json={"prediction": prediction}, headers=headers).status_code == 403


@pytest.mark.parametrize("prediction", [
    {}, {"frame_sequence": True, "gazes": []}, {"frame_sequence": 0, "gazes": []},
    {"frame_sequence": 1, "gazes": [{"yaw": "bad", "pitch": .1}]},
    {"frame_sequence": 1, "gazes": [{"yaw": .1}]},
    {"frame_sequence": 1, "gazes": [None]},
])
def test_malformed_gaze_callbacks_are_rejected(rig, prediction):
    client, manager, _, _ = rig
    identifier = connect(client)
    with TestClient(manager.callback_app) as callback:
        assert callback.post(f"/gaze/{identifier}", json={"prediction": prediction},
            headers={"X-Pong-Webhook-Key": manager.sessions[identifier].callback_token}).status_code == 422


def test_result_socket_disconnect_stops_billable_processing(rig):
    client, manager, calls, _ = rig
    identifier = connect(client)
    client.post(f"/api/stream/sessions/{identifier}/start")
    with client.websocket_connect(f"/api/stream/sessions/{identifier}/results", headers={"Origin": "http://testserver"}) as websocket:
        websocket.send_text("ping")
    assert manager.sessions[identifier].closed
    assert any(call.url.path.endswith("/stop-session") for call in calls)


def test_saved_workflow_slug_is_used_in_production(rig, monkeypatch):
    client, manager, calls, _ = rig
    manager.specification = None
    monkeypatch.setenv('CLOUD_WORKFLOW_ID', 'look-pong-cloud-gaze-streaming')
    identifier = connect(client)
    assert client.post(f'/api/stream/sessions/{identifier}/start').status_code == 200
    body = json.loads(next(call for call in calls if call.url.path.endswith('/jobs')).content)
    assert body['workflowUrl'] == 'look-pong-cloud-gaze-streaming'
    assert 'workflowSpecification' not in body
    assert body['workflowParameters']['disable_callback'] is False


def test_concurrent_stop_calls_do_not_leave_a_false_cleanup_failure(rig):
    client, manager, calls, _ = rig
    identifier = connect(client)
    client.post(f'/api/stream/sessions/{identifier}/start')
    async def stop_twice():
        await asyncio.gather(manager.stop(manager.sessions[identifier]), manager.stop(manager.sessions[identifier]))
    asyncio.run(stop_twice())
    assert manager.sessions[identifier].state == 'stopped'
    assert len([call for call in calls if call.url.path.endswith('/stop-session')]) == 1
