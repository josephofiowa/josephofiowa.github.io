"""Run separately from local-mode regression tests: pytest production_checks.py."""
import json
import hashlib
import re
from pathlib import Path
import httpx
import pytest
from fastapi.testclient import TestClient

import production
import web_app
from test_web_app import calibration_payload

ORIGIN = 'https://josephofiowa.com'
BACKEND = 'https://pong-api.josephofiowa.com'


@pytest.fixture
def rig(monkeypatch):
    monkeypatch.setenv('ROBOFLOW_API_KEY', 'private-test-key')
    monkeypatch.setenv('ROBOFLOW_PUBLISHABLE_KEY', 'rf_test-publishable')
    monkeypatch.setenv('CLOUD_CALLBACK_ORIGIN', 'https://test-service.onrender.com')
    calls = []
    def upstream(request):
        calls.append(request)
        if request.url.path.endswith('/temporary'):
            return httpx.Response(200, json={'sourceId': f'tmp-{len(calls)}', 'whipUrl': 'https://relay.example/whip?secret-grant'})
        if request.url.path.endswith('/jobs'):
            return httpx.Response(200, json={'job': {'id': f'job-{len(calls)}', 'state': 'running'}})
        if request.method == 'GET' and '/video-jobs/' in request.url.path:
            return httpx.Response(200, json={'job': {'state': 'running'}})
        return httpx.Response(200, json={'ok': True})
    original = httpx.AsyncClient
    monkeypatch.setattr(web_app.httpx, 'AsyncClient', lambda **kw: original(transport=httpx.MockTransport(upstream), **kw))
    with TestClient(production.app, base_url=BACKEND, headers={'Origin': ORIGIN}) as client:
        yield client, client.app.state.streaming, calls


def visitor(client, attempt):
    client.cookies.clear()
    config = client.get('/api/config')
    assert config.status_code == 200
    cookie = client.cookies.get('pong-stream-owner')
    created = client.post('/api/stream/sessions', json={'attempt': attempt})
    return cookie, created


def test_public_frontend_cors_cookie_and_secret_handling(rig):
    client, manager, calls = rig
    response = client.get('/api/config')
    assert response.headers['access-control-allow-origin'] == ORIGIN
    assert response.headers['access-control-allow-credentials'] == 'true'
    assert response.headers['cache-control'] == 'no-store'
    assert 'HttpOnly' in response.headers['set-cookie'] and 'Secure' in response.headers['set-cookie']
    assert response.json()['api_origin'] == BACKEND
    assert 'private-test-key' not in response.text
    preflight = client.options('/api/calibration', headers={'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type'})
    assert preflight.status_code == 200
    assert client.get('/healthz').json() == {'status': 'ok'}
    assert client.get('/healthz').headers['x-robots-tag'] == 'noindex'
    assert client.get('/').json()['game_url'] == ORIGIN + '/look-pong/'


def test_multiple_players_have_independent_sessions_and_capacity_is_bounded(rig):
    client, manager, calls = rig
    owners, identifiers = [], []
    for index in range(3):
        owner, response = visitor(client, f'visitor-{index}')
        assert response.status_code == 200
        owners.append(owner); identifiers.append(response.json()['id'])
    assert len(set(owners)) == len(set(identifiers)) == 3
    assert client.post(f'/api/stream/sessions/{identifiers[0]}/stop').status_code == 404
    _, fourth = visitor(client, 'visitor-four')
    assert fourth.status_code == 429
    assert len(calls) == 3
    assert manager.session_seconds == 900


def test_untrusted_or_missing_origin_never_creates_a_paid_job(rig):
    client, _, calls = rig
    assert client.post('/api/stream/sessions', json={'attempt': 'evil-origin'}, headers={'Origin': 'https://evil.example'}).status_code == 403
    client.headers.pop('Origin')
    assert client.post('/api/stream/sessions', json={'attempt': 'no-origin'}).status_code == 403
    assert client.post('/api/calibration', json=calibration_payload()).status_code == 403
    assert client.post('/api/gaze', json={}).status_code == 404
    assert not calls


def test_calibrations_belong_to_their_browser_and_all_eighteen_points_contribute(rig):
    client, _, _ = rig
    visitor(client, 'calibrating-player')
    response = client.post('/api/calibration', json=calibration_payload(extended=True))
    assert response.status_code == 200
    identifier = response.json()['calibration_id']
    assert len(client.app.state.calibrations[identifier]['points']) == 18
    saved = dict(client.cookies)
    visitor(client, 'another-player')
    assert client.delete('/api/calibration/' + identifier).status_code == 404
    client.cookies.clear(); client.cookies.update(saved)
    assert client.delete('/api/calibration/' + identifier).status_code == 200


def test_callback_uses_public_port_and_retains_per_session_authentication(rig):
    client, manager, calls = rig
    _, created = visitor(client, 'callback-player')
    identifier = created.json()['id']
    session = manager.sessions[identifier]
    session.state = 'publishing'
    response = client.post(f'/api/stream/sessions/{identifier}/start')
    assert response.status_code == 200
    body = json.loads(next(c.content for c in calls if c.url.path.endswith('/jobs')))
    assert body['workflowUrl'] == 'look-pong-cloud-gaze-streaming'
    assert body['workflowParameters']['callback_url'] == f'https://test-service.onrender.com/gaze/{identifier}'
    payload = {'prediction': {'frame_sequence': 1, 'gazes': [{'yaw': .1, 'pitch': .2}]}}
    assert client.post(f'/gaze/{identifier}', json=payload).status_code == 403
    headers = {'X-Pong-Webhook-Key': session.callback_token}
    assert client.post(f'/gaze/{identifier}', json=payload, headers=headers).json()['accepted']
    assert manager.sessions[identifier].queue.qsize() == 1


def test_hourly_limit_cannot_be_bypassed_by_new_owner_cookies(rig):
    client, manager, calls = rig
    manager.starts_per_hour = 1
    _, response = visitor(client, 'first-player')
    client.post(f"/api/stream/sessions/{response.json()['id']}/stop")
    _, response = visitor(client, 'second-player')
    assert response.status_code == 429
    assert len([call for call in calls if call.url.path.endswith('/temporary')]) == 1


def test_socket_origin_and_cookie_isolation_and_disconnect_cleanup(rig):
    client, manager, calls = rig
    _, response = visitor(client, 'socket-player')
    identifier = response.json()['id']
    from starlette.websockets import WebSocketDisconnect
    path = BACKEND.replace('https:', 'wss:') + f'/api/stream/sessions/{identifier}/results'
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(path, headers={'Origin': 'https://evil.example'}):
            pass
    assert not manager.sessions[identifier].closed
    with client.websocket_connect(path, headers={'Origin': ORIGIN}) as socket:
        socket.send_text('ping')
    assert manager.sessions[identifier].closed
    assert any(call.url.path.endswith('/stop-session') for call in calls)


def test_pages_export_scopes_assets_and_versions_modules_without_private_files(tmp_path):
    from build_site import build, ROOT
    vendor = ROOT.parents[1] / 'look-pong/vendor/inference.es.js'
    build(tmp_path, vendor=vendor)
    page = (tmp_path / 'index.html').read_text()
    assert '<meta name="robots" content="noindex">' in page
    assert 'content="https://pong-api.josephofiowa.com"' in page
    assert 'href="/look-pong/"' in page
    assert 'Camera frames are sent to Roboflow.' in page
    assert 'href="/assets/' not in page and 'src="/assets/' not in page
    imports = json.loads(re.search(r'<script type="importmap">(.*?)</script>', page)[1])['imports']
    for path, url in imports.items():
        content = (tmp_path / path.removeprefix('/look-pong/')).read_bytes()
        assert url == path + '?v=' + hashlib.sha256(content).hexdigest()[:16]
    assert all(p.suffix in {'.html', '.js', '.css', '.txt'} for p in tmp_path.rglob('*') if p.is_file())
