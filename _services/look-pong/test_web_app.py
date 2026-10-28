import copy
import hashlib
import json
import re
import httpx
import pytest
from fastapi.testclient import TestClient

import web_app


def test_browser_modules_use_content_versions_and_revalidate_cached_assets():
    with TestClient(web_app.app) as client:
        page = client.get("/")
        assert page.headers.get("cache-control") == "no-cache"
        import_map = re.search(r'<script type="importmap">(.*?)</script>', page.text)
        assert import_map, "Imports must not combine a new app with an old cached detector"
        imports = json.loads(import_map.group(1))["imports"]
        for name in ("app.js", "engine.js", "face-detector.js", "cloud-stream.js"):
            path = f"/assets/{name}"
            expected = (web_app.ROOT / "web" / name).read_bytes()
            assert imports[path] == f"{path}?v={hashlib.sha256(expected).hexdigest()[:16]}"
            response = client.get(imports[path])
            assert response.content == expected
            assert response.headers.get("cache-control") == "no-cache"
            cached = client.get(imports[path], headers={"If-None-Match": response.headers["etag"]})
            assert cached.status_code == 304
            assert cached.headers.get("cache-control") == "no-cache"
        assert f'src="{imports["/assets/app.js"]}"' in page.text
        assert page.text.index('type="importmap"') < page.text.index('type="module"')


def test_detector_update_changes_its_browser_import_url(monkeypatch, tmp_path):
    web = tmp_path / "web"
    web.mkdir()
    for name in ("index.html", "app.js", "engine.js", "face-detector.js", "style.css"):
        (web / name).write_bytes((web_app.ROOT / "web" / name).read_bytes())
    monkeypatch.setattr(web_app, "ROOT", tmp_path)
    with TestClient(web_app.app) as client:
        def detector_url():
            page = client.get("/").text
            imports = re.search(r'<script type="importmap">(.*?)</script>', page)
            return json.loads(imports.group(1))["imports"]["/assets/face-detector.js"]

        before = detector_url()
        with (web / "face-detector.js").open("a") as detector:
            detector.write("\n// Updated detector interface\n")
        assert detector_url() != before


def install_upstream(monkeypatch, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(web_app.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    monkeypatch.setenv("ROBOFLOW_API_KEY", "test-server-key")


def test_proxy_calls_saved_workflow_without_exposing_credential(monkeypatch):
    def handler(request):
        assert request.url.path.endswith("/infer/workflows/april-public-yibrz/eye-gaze-l2cs-net")
        assert request.headers["Authorization"] == "Bearer test-server-key"
        assert b'"max_faces":1' in request.content
        return httpx.Response(200, json={"outputs": [{"gazes": [], "face_count": 0, "image_size": {"width": 640, "height": 480}}]})

    install_upstream(monkeypatch, handler)
    with TestClient(web_app.app) as client:
        response = client.post("/api/gaze", json={"image": "dGVzdC1pbWFnZQ==", "captured_at": 1234})
        assert response.status_code == 200
        assert response.json()["captured_at"] == 1234
        assert response.json()["face_count"] == 0
        timing = response.json()["timing"]
        assert 0 <= timing["workflow_ms"] <= timing["server_ms"]
        assert "test-server-key" not in response.text
        assert "test-server-key" not in client.get("/api/config").text
        assert "test-server-key" not in client.get("/").text


def test_upstream_errors_are_redacted(monkeypatch):
    install_upstream(monkeypatch, lambda request: httpx.Response(403, text="bad credential test-server-key"))
    with TestClient(web_app.app) as client:
        response = client.post("/api/gaze", json={"image": "dGVzdC1pbWFnZQ==", "captured_at": 1234})
        assert response.status_code == 502
        assert "test-server-key" not in response.text


def test_browser_metadata_proxy_is_limited_to_the_configured_model_and_publishable_key(monkeypatch):
    def handler(request):
        assert request.url.path == '/tfjs/model/april-public-yibrz/never-gonna-20-rfdetr-small-t1'
        assert request.url.params['publishable_key'] == 'rf_public-test'
        assert 'Authorization' not in request.headers
        assert 'test-server-key' not in str(request.url)
        return httpx.Response(200, json={'tfjs': {'model': 'https://weights.example/model.json'}})
    install_upstream(monkeypatch, handler)
    monkeypatch.setenv('ROBOFLOW_PUBLISHABLE_KEY', 'rf_public-test')
    with TestClient(web_app.app) as client:
        assert client.get('/api/config').json()['face_detector']['api_base'] == '/api/browser-model'
        assert client.get('/api/browser-model/tfjs/model/april-public-yibrz/never-gonna-20-rfdetr-small-t1').status_code == 200
        assert client.get('/api/browser-model/tfjs/model/unconfigured/model').status_code == 404


def test_cloud_configuration_discloses_cloud_processing_and_saved_workflow(monkeypatch):
    monkeypatch.setenv('GAZE_TRANSPORT', 'cloud-streaming')
    monkeypatch.setenv('CLOUD_WORKFLOW_ID', 'look-pong-cloud-gaze-streaming')
    with TestClient(web_app.app) as client:
        config = client.get('/api/config').json()
        assert config['processing'] == 'cloud'
        assert config['transport'] == 'cloud-streaming'
        assert config['workflow'] == 'look-pong-cloud-gaze-streaming'


@pytest.mark.parametrize("reverse", [True, False])
def test_extra_gaze_results_do_not_block_player_calibration_mapping(monkeypatch, reverse):
    x, y = .3, .7
    player = {"yaw": .5*x + .08*y - .2, "pitch": -.07*x + .4*y - .1,
              "face": {"x": 320, "y": 200, "width": 180, "height": 200}}
    extra = {"yaw": -.6, "pitch": -.7, "face": {"x": 100, "y": 300, "width": 40, "height": 40}}
    gazes = [extra, player] if reverse else [player, extra]
    install_upstream(monkeypatch, lambda request: httpx.Response(200, json={"outputs": [
        {"gazes": gazes, "face_count": 2, "image_size": {"width": 640, "height": 360}}]}))
    with TestClient(web_app.app) as client:
        profile_id = client.post("/api/calibration", json=calibration_payload()).json()["calibration_id"]
        result = client.post("/api/gaze", json={"image": "dGVzdC1pbWFnZQ==", "captured_at": 1234,
                                               "calibration_id": profile_id}).json()
        assert result["gazes"] == [player]
        assert result["screen_point"] == pytest.approx([x, y], abs=.01)


def test_unavailable_inference_server_returns_actionable_error(monkeypatch):
    def handler(request):
        raise httpx.ConnectError("offline", request=request)

    install_upstream(monkeypatch, handler)
    with TestClient(web_app.app) as client:
        response = client.post("/api/gaze", json={"image": "dGVzdC1pbWFnZQ==", "captured_at": 1234})
        assert response.status_code == 503
        assert "Start the local Inference server" in response.json()["detail"]


def calibration_payload(offset=0, extended=False):
    targets = [[.5, .5], [.12, .14], [.5, .14], [.88, .14], [.88, .5], [.88, .86], [.5, .86], [.12, .86], [.12, .5]]
    if extended:
        targets += [[.3, .36], [.5, .36], [.7, .36], [.7, .52], [.7, .68], [.5, .68], [.3, .68], [.3, .52], [.5, .52]]
    return {"viewport": [1280, 850], "points": [
        {"target": [x, y], "samples": [
            {"yaw": .5 * x + .08 * y - .2 + offset, "pitch": -.07 * x + .4 * y - .1,
             "captured_at": 1000 + index * 1500 + sample * 350} for sample in range(4)]}
        for index, (x, y) in enumerate(targets)]}


def test_all_eighteen_points_contribute_to_live_gaze_mapping(monkeypatch):
    x, y = .3, .7
    install_upstream(monkeypatch, lambda request: httpx.Response(200, json={"outputs": [
        {"gazes": [{"yaw": .5*x + .08*y - .2, "pitch": -.07*x + .4*y - .1}]}]}))
    payload = calibration_payload(extended=True)
    with TestClient(web_app.app) as client:
        saved = client.post("/api/calibration", json=payload)
        assert saved.status_code == 200
        profile_id = saved.json()["calibration_id"]
        assert web_app.app.state.calibrations[profile_id]["points"] == payload["points"]
        frame = {"image": "dGVzdC1pbWFnZQ==", "captured_at": 1234, "calibration_id": profile_id}
        baseline = client.post("/api/gaze", json=frame).json()["screen_point"]
        assert baseline == pytest.approx([x, y], abs=.01)
        # Perturb every target independently. Its readings must affect the live
        # screen coordinate used by the paddle, including all nine extra dots.
        for index in range(18):
            changed = copy.deepcopy(payload)
            for sample in changed["points"][index]["samples"]:
                sample["yaw"] += .08
            updated = client.post("/api/calibration", json=changed)
            assert updated.status_code == 200
            frame["calibration_id"] = updated.json()["calibration_id"]
            mapped = client.post("/api/gaze", json=frame).json()["screen_point"]
            assert max(abs(a-b) for a, b in zip(mapped, baseline)) > 1e-5, f"Target {index+1} was ignored"


@pytest.mark.parametrize("count", [8, 10, 17, 19])
def test_calibration_rejects_incomplete_point_collections(count):
    payload = calibration_payload(extended=True)
    payload["points"] = (payload["points"] * 2)[:count]
    with TestClient(web_app.app) as client:
        assert client.post("/api/calibration", json=payload).status_code == 422
        assert not web_app.app.state.calibrations


@pytest.mark.parametrize("face_metadata", [True, False])
def test_calibration_stores_pairs_and_maps_live_gaze_per_session(monkeypatch, face_metadata):
    x, y = .3, .7
    def handler(request):
        output = {"gazes": [{"yaw": .5*x + .08*y - .2, "pitch": -.07*x + .4*y - .1}]}
        if face_metadata:
            output.update(face_count=1, image_size={"width": 640, "height": 480})
        return httpx.Response(200, json={"outputs": [output]})

    install_upstream(monkeypatch, handler)
    with TestClient(web_app.app) as client:
        payload = calibration_payload()
        first = client.post("/api/calibration", json=payload)
        assert first.status_code == 200
        first_id = first.json()["calibration_id"]
        second_id = client.post("/api/calibration", json=calibration_payload(.1)).json()["calibration_id"]
        assert first_id != second_id
        profile = web_app.app.state.calibrations[first_id]
        assert profile["points"] == payload["points"]
        assert profile["viewport"] == (1280, 850)
        frame = {"image": "dGVzdC1pbWFnZQ==", "captured_at": 1234, "calibration_id": first_id}
        result = client.post("/api/gaze", json=frame).json()
        assert result["screen_point"] == pytest.approx([x, y], abs=.01)
        assert result["calibration_id"] == first_id
        frame["calibration_id"] = second_id
        other = client.post("/api/gaze", json=frame).json()
        assert abs(other["screen_point"][0] - x) > .1
        del frame["calibration_id"]
        assert client.post("/api/gaze", json=frame).json()["screen_point"] is None


def test_deleting_or_expiring_a_calibration_requires_a_fresh_mapping(monkeypatch):
    install_upstream(monkeypatch, lambda request: pytest.fail("Invalid calibration must not reach inference"))
    with TestClient(web_app.app) as client:
        first = client.post("/api/calibration", json=calibration_payload()).json()["calibration_id"]
        second = client.post("/api/calibration", json=calibration_payload()).json()["calibration_id"]
        client.delete(f"/api/calibration/{first}")
        assert first not in web_app.app.state.calibrations
        web_app.app.state.calibrations[second]["expires_at"] = 0
        for profile_id in (first, second):
            response = client.post("/api/gaze", json={"image": "dGVzdC1pbWFnZQ==", "captured_at": 1234, "calibration_id": profile_id})
            assert response.status_code == 409
            assert "recalibrate" in response.json()["detail"]
        assert not web_app.app.state.calibrations


@pytest.mark.parametrize("invalid", ["no-movement", "collinear", "out-of-bounds", "too-few-samples"])
def test_calibration_rejects_unusable_or_invalid_readings(monkeypatch, invalid):
    install_upstream(monkeypatch, lambda request: pytest.fail("Calibration does not need image inference"))
    payload = calibration_payload()
    for index, point in enumerate(payload["points"]):
        for sample in point["samples"]:
            if invalid == "no-movement":
                sample["yaw"], sample["pitch"] = .1, .2
            if invalid == "collinear":
                sample["pitch"] = sample["yaw"]
    if invalid == "out-of-bounds":
        payload["points"][0]["target"][0] = 1.1
    if invalid == "too-few-samples":
        payload["points"][0]["samples"] = payload["points"][0]["samples"][:2]
    with TestClient(web_app.app) as client:
        assert client.post("/api/calibration", json=payload).status_code == 422
        assert not web_app.app.state.calibrations


@pytest.mark.parametrize("noisy", [False, True])
def test_completed_calibration_saves_approximate_mapping_and_controls_live_gaze(monkeypatch, noisy):
    install_upstream(monkeypatch, lambda request: httpx.Response(200, json={"outputs": [
        {"gazes": [{"yaw": .1, "pitch": .2}]}]}))
    payload = calibration_payload()
    if noisy:
        # Each dot has stable samples, but the nine dots don't fit an affine
        # screen map closely. This triggered the recording's final 422 error.
        for index, point in enumerate(payload["points"]):
            for sample in point["samples"]:
                sample["yaw"], sample["pitch"] = index * .04, (index % 2) * .05
    with TestClient(web_app.app) as client:
        response = client.post("/api/calibration", json=payload)
        assert response.status_code == 200
        data = response.json()
        assert data["quality"]["approximate"] is noisy
        assert (data["quality"]["fit_rmse"] > .15) is noisy
        assert web_app.app.state.calibrations[data["calibration_id"]]["quality"] == data["quality"]
        frame = {"image": "dGVzdC1pbWFnZQ==", "captured_at": 1234, "calibration_id": data["calibration_id"]}
        gaze = client.post("/api/gaze", json=frame)
        assert gaze.status_code == 200
        assert all(0 <= value <= 1 for value in gaze.json()["screen_point"])


def test_browser_face_crop_bypasses_haar_and_restores_original_camera_coordinates(monkeypatch):
    import json
    crop = {"x": 370, "y": 170, "width": 180, "height": 200, "image_width": 640, "image_height": 360}
    def handler(request):
        assert json.loads(request.content)["inputs"]["input_is_face_crop"] is True
        return httpx.Response(200, json={"outputs": [{"gazes": [{"yaw": .1, "pitch": .2,
            "face": {"x": 90, "y": 100, "width": 180, "height": 200}}],
            "image_size": {"width": 180, "height": 200}, "face_count": 1}]})
    install_upstream(monkeypatch, handler)
    with TestClient(web_app.app) as client:
        response = client.post("/api/gaze", json={"image": "dGVzdC1pbWFnZQ==", "captured_at": 1234, "face_crop": crop})
        assert response.status_code == 200
        assert response.json()["gazes"][0]["face"] == {key: crop[key] for key in ("x", "y", "width", "height")}
        assert response.json()["image_size"] == {"width": 640, "height": 360}


def test_invalid_browser_crop_never_reaches_the_workflow(monkeypatch):
    install_upstream(monkeypatch, lambda request: pytest.fail("Out-of-frame crop must be rejected"))
    with TestClient(web_app.app) as client:
        response = client.post("/api/gaze", json={"image": "dGVzdC1pbWFnZQ==", "captured_at": 1234,
            "face_crop": {"x": 0, "y": 0, "width": 180, "height": 200, "image_width": 640, "image_height": 360}})
        assert response.status_code == 422


def test_browser_config_exposes_only_the_publishable_key_and_exact_model_id(monkeypatch):
    monkeypatch.setenv("ROBOFLOW_API_KEY", "private-server-secret")
    monkeypatch.setenv("ROBOFLOW_PUBLISHABLE_KEY", "rf_browser-safe")
    with TestClient(web_app.app) as client:
        config = client.get("/api/config")
        assert "private-server-secret" not in config.text
        assert config.json()["face_detector"]["model_id"] == "april-public-yibrz/never-gonna-20-rfdetr-small-t1"
        assert config.json()["face_detector"]["publishable_key"] == "rf_browser-safe"
        monkeypatch.setenv("ROBOFLOW_PUBLISHABLE_KEY", "private-server-secret")
        assert client.get("/api/config").json()["face_detector"] is None
