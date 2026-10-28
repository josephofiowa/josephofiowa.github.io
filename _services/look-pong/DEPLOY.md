# Look Pong deployment

GitHub Pages serves `https://josephofiowa.com/look-pong/`. Render serves the
Python API and authenticated gaze callbacks. The browser sends cropped webcam
video directly to Roboflow over H.264 WebRTC; Render receives only gaze JSON,
calibration points, and session-control requests. Browser face detection stays
local. No app video or frame storage is enabled.

## Render form

| Field | Value |
| --- | --- |
| Repository | `josephofiowa/josephofiowa.github.io` |
| Name | `look-pong-api` |
| Language | Python 3 |
| Branch for initial backend test | `codex/deploy-look-pong` |
| Root Directory | `_services/look-pong` |
| Region | Oregon |
| Instance | Free |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `uvicorn production:app --host 0.0.0.0 --port $PORT --workers 1 --proxy-headers` |
| Health Check Path | `/healthz` |
| Auto Deploy | Off during setup |

Add two environment variables in Render's secret/environment UI:

- `ROBOFLOW_API_KEY`: the existing private workspace key.
- `ROBOFLOW_PUBLISHABLE_KEY`: the existing browser publishable key (`rf_…`).

Use the values already configured for the local demo. Never commit `.env` or
paste secrets into a PR. The publishable key is deliberately returned by the
configuration endpoint; the private key stays in Render and the trusted
Roboflow Workflow runtime.

The `.python-version` file selects Python 3.12. No local Inference server,
OpenCV, ONNX, GPU, npm install, or temporary tunnel is required on Render.
`production.py` supplies the existing workspace, face model and saved Workflow
defaults. `RENDER_EXTERNAL_URL`, supplied by Render, becomes the permanent
callback origin; callbacks and browser APIs share the service's public port.
Keep the Render-provided hostname enabled for callbacks.

Deploy the backend branch first and check `https://<assigned-host>/healthz`.
This does not publish the game on GitHub Pages. After backend checks and DNS,
merge the PR to publish `/look-pong/`, switch Render to `main`, and optionally
enable automatic deployment. The Blueprint is an alternative to the manual
form; use one route to avoid creating duplicate services.

## Namecheap and HTTPS

1. In Render Settings → Custom Domains, add `pong-api.josephofiowa.com`.
2. Namecheap Domain List → Manage → Advanced DNS → Add New Record:
   Type `CNAME`, Host `pong-api`, Value the exact Render `…onrender.com`
   hostname (without `https://` or a path), TTL Automatic.
3. Verify the domain in Render and wait for the HTTPS certificate.
4. Check `https://pong-api.josephofiowa.com/healthz`.

Only add the `pong-api` record. Existing homepage, `www`, and email records
continue to serve their existing destinations. If the domain uses external
nameservers, add the record at that authoritative DNS provider instead.

The frontend uses this custom API subdomain so session cookies are same-site.
HTTP requests include credentials, CORS permits only the configured site
origins, and WebSockets validate the same origin allowlist and owner cookie.
Do not point the public frontend directly at `onrender.com`; cross-site cookie
blocking can break session ownership. An unindexed backend root is available
for initial same-host testing only after adding its origin explicitly if needed.

## Initial beta limits

Defaults are three active players, one stream per browser cookie, at most 30
new streams per service hour, and a 15-minute maximum streaming session.
`CLOUD_MAX_SESSIONS`, `CLOUD_STARTS_PER_HOUR`, and `CLOUD_SESSION_SECONDS` can
override them. These are app limits, not a dollar spending guarantee; Roboflow's
workspace quotas also apply. Restarting the process resets the hourly counter.
An absent browser heartbeat expires after 45 seconds. Unused landing-page
preparation stops after two minutes; closing the page or turning off the camera
stops its processing. Preview/source leases bound cleanup after abrupt server
termination. A new camera session requires recalibration.

GPU billing begins with page-load prewarming. Render Free sleeps after idle
periods and may restart; startup configuration retries for up to about 139
seconds and explains the wait. Active sessions and mappings live in memory;
use exactly one worker/instance. A restart loses them and players must restart
the camera and recalibrate. Horizontal scaling would require shared state and
cross-worker result routing.

The game has a `noindex` meta tag, the backend sets `X-Robots-Tag: noindex`,
and the page is omitted from navigation. Do not block `/look-pong/` in
robots.txt, because crawlers must read its noindex tag. Anyone with the URL
can use it, and this repository's code is public.

## Editing, building, and testing

Canonical frontend sources are `web/` in this directory. The checked-in
`/look-pong/` directory is generated for Pages. To refresh it:

```sh
cd _services/look-pong
npm ci
python build_site.py
```

Export includes only JS, CSS, HTML and the pinned inferencejs browser bundle,
with content-versioned module imports. Credentials and test recordings are
never included. CI rebuilds the export and checks for differences.

```sh
pip install -r requirements-test.txt
npm test
pytest test_web_app.py test_cloud_streaming.py -q
pytest production_checks.py -q
```

Production checks run in their own Python process because importing
`production` sets the production environment. Tests use mocked Roboflow calls;
they do not start paid inference or access a webcam.

Before sharing: validate Chrome permission allow/deny, initial nine dots,
eighteen-point recalibration, replay, independent browsers playing concurrently,
the busy state, real capture-to-result latency, camera-off/page-close cleanup,
and service restart recovery on the actual HTTPS deployment.
