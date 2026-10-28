import { PongGame, CourtRenderer, clamp, aggregateAngles, mapGaze, postureChanged, selectPlayerGaze } from './engine.js';

import { apiFetch, apiUrl, loadConfig } from './api-client.js';

const $ = id => document.getElementById(id);
const screens = ['welcome', 'setup', 'calibration', 'game-view'];
const video = $('video');
const webcam = $('webcam');
const capture = document.createElement('canvas');
capture.width = 640; capture.height = 480;
const captureContext = capture.getContext('2d', { alpha: false });
const court = new CourtRenderer($('game-court'), { fillViewport: true });
const hero = new CourtRenderer($('hero-court'));
const demo = new PongGame();
let state = 'welcome', stream = null, cameraEpoch = 0, cameraReady = false;
let cameraAccessConfirmed = false, cameraPermissionStatus = null, cameraStartup = null;
let videoFrameCallback = null, videoFrameAt = -Infinity, videoFrameTime = -1;
let videoFrameSequence = 0, capturedFrameSequence = 0;
let calibration = null, calibrationId = null, baseline = null, lastFace = null, lastGood = 0;
let latestFaceGuide = null, lastFaceGuideCapture = null;
let inferenceActive = false, activeRequest = null, stopped = false, processing = 'local';
let browserFaceDetector = null, detectorEpoch = -1, detectorFailed = false;
let transport = apiUrl('/api/config').startsWith('https://') ? 'cloud-streaming' : 'http';
let cloudGazeStream = null, cloudGazeReady = false, cloudConnectionError = '';
let trackingPreparation = null, preparationEpoch = 0, pageClosed = false;
let latency = 0, gaze = null, lastGazeAt = 0, postureBad = false;
let latencyBreakdown = null, lastInferenceStarted = -Infinity;
let calibrationRun = 0, targetIndex = 0, targetShown = 0, targetSamples = [], calibrationPoints = [];
let targetSequence = 0, dwellStarted = null, targetLastGood = 0, calibrationViewport = null;
let targetReadyAt = 0, lastTargetCapture = null;
let targetAdvanceAt = null;
let calibrationReadyStarted = null;
let targetToken = '', countdownEnd = 0, lastTick = performance.now(), toastTimer;
let startButtonPulseTimer = null;
let primaryAction = null, secondaryAction = null, modalKind = '', previousFocus = null;
const initialTargets = [[.5, .22], [.12, .14], [.5, .14], [.88, .14], [.88, .5], [.88, .86], [.5, .86], [.12, .86], [.12, .5]];
const additionalTargets = [[.3, .36], [.5, .36], [.7, .36], [.7, .52], [.7, .68], [.5, .68], [.3, .68], [.3, .52], [.5, .52]];
let extendedCalibration = false;
let targets = initialTargets.map(point => [...point]);
const CALIBRATION_GAP_MS = 800;
const CALIBRATION_PREVIEW_MS = 3000;
const CALIBRATION_GUIDANCE = "Look at the dot. It's ok to turn your head naturally";
const CAMERA_FRAME_GAP_MS = 350;
const FACE_MODEL_LOAD_MS = 60000;
const GAZE_INTERVAL_MS = 125;
const game = new PongGame(endGame);

function stopStartButtonPulse() {
  clearTimeout(startButtonPulseTimer);
  startButtonPulseTimer = null;
  $('enable-camera').classList.remove('is-idle');
}

function scheduleStartButtonPulse() {
  stopStartButtonPulse();
  if (state !== 'welcome' || document.hidden) return;
  startButtonPulseTimer = setTimeout(() => {
    startButtonPulseTimer = null;
    if (state === 'welcome' && !document.hidden) $('enable-camera').classList.add('is-idle');
  }, 5000);
}

scheduleStartButtonPulse();

const startupNotice = setTimeout(() => {
  if ($('startup-status')) $('startup-status').textContent = 'Preparing eye tracking. The first visit may take about a minute.';
}, 1500);
const appConfig = loadConfig().then(config => {
  clearTimeout(startupNotice);
  if ($('startup-status')) $('startup-status').textContent = '';
  if (config.face_detector?.api_base?.startsWith('/')) {
    config.face_detector.api_base = new URL(config.face_detector.api_base, config.api_origin || location.origin).href;
  }
  processing = config.processing;
  transport = config.transport || 'http';
  $('privacy-copy').textContent = processing === 'local'
    ? 'Camera frames stay on this computer. No video is saved.'
    : 'Camera frames are sent to Roboflow. No video is saved by this app.';
  if (!pageClosed && config.face_detector) prepareTracking(config);
  return config;
}).catch(error => {
  clearTimeout(startupNotice); transport = 'cloud-streaming';
  if ($('startup-status')) $('startup-status').textContent = '';
  return { error: error.message };
});

function prepareTracking(config) {
  if (trackingPreparation) return trackingPreparation;
  const generation = preparationEpoch;
  trackingPreparation = import('./tracking-preparation.js').then(({ TrackingPreparation }) => {
    if (pageClosed || generation !== preparationEpoch) return null;
    return new TrackingPreparation({
      loadFace: () => import('./face-detector.js').then(m => m.loadBrowserFaceDetector(config.face_detector)),
      createStream: transport === 'cloud-streaming'
        ? () => import('./cloud-stream.js').then(m => new m.CloudGazeStream()) : null,
    });
  }).catch(() => null);
  return trackingPreparation;
}

function cancelTrackingPreparation() {
  preparationEpoch++;
  const previous = trackingPreparation; trackingPreparation = null;
  previous?.then(prepared => prepared?.dispose());
}

async function takePreparedTracking(config) {
  let prepared = await prepareTracking(config);
  if (prepared?.disposed) {
    trackingPreparation = null;
    prepared = await prepareTracking(config);
  }
  return prepared ? prepared.take() : { face: null, stream: null };
}

function setScreen(id) {
  if (id === 'welcome') scheduleStartButtonPulse();
  else stopStartButtonPulse();
  screens.forEach(name => $(name).classList.toggle('hidden', name !== id));
  $('site-header').classList.toggle('hidden', id === 'game-view');
  $('camera-stop').classList.toggle('hidden', !stream && id === 'welcome');
  $('chrome-pill').classList.toggle('hidden', id !== 'welcome' && id !== 'setup');
  webcam.classList.remove('in-calibration');
  if (id === 'game-view' && stream) {
    document.querySelector('main').append(webcam);
    webcam.classList.remove('hidden', 'in-setup'); webcam.classList.add('floating');
  } else if (id === 'calibration' && stream) {
    $('calibration').append(webcam);
    webcam.classList.remove('hidden', 'floating', 'in-setup', 'collapsed');
    webcam.classList.add('in-calibration');
    $('toggle-preview').textContent = '−';
    $('toggle-preview').setAttribute('aria-label', 'Hide camera preview');
  } else if (id === 'setup') {
    $('camera-slot').append(webcam);
    webcam.classList.remove('hidden', 'floating', 'collapsed'); webcam.classList.add('in-setup');
    $('toggle-preview').textContent = '−';
  } else webcam.classList.add('hidden');
}

function toast(message) {
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').classList.remove('hidden');
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 4500);
}

function showModal({ kind, label, title, description, primary, secondary, action, secondaryAction: other, stats }) {
  if ($('modal').classList.contains('hidden')) previousFocus = document.activeElement;
  modalKind = kind;
  $('modal-eyebrow').textContent = label;
  $('modal-title').textContent = title;
  $('modal-description').textContent = description;
  $('modal-primary').classList.toggle('hidden', !primary);
  $('modal-primary').disabled = false;
  $('modal-secondary').classList.toggle('hidden', !secondary);
  $('modal-primary').textContent = primary || '';
  if (kind === 'gameover') $('modal-primary').innerHTML = 'Replay<svg class="replay-icon" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M10 6 25 16 10 26Z"/></svg>';
  $('modal-secondary').textContent = secondary || '';
  $('modal-stats').classList.toggle('hidden', !stats);
  $('modal-stats').replaceChildren();
  if (stats) for (const [number, caption] of stats) {
    const item = document.createElement('div'), strong = document.createElement('strong'), span = document.createElement('span');
    strong.textContent = number; span.textContent = caption; item.append(strong, span); $('modal-stats').append(item);
  }
  $('countdown-number').classList.toggle('hidden', kind !== 'countdown');
  primaryAction = action; secondaryAction = other;
  $('modal').classList.remove('hidden');
  if (primary) $('modal-primary').focus({ preventScroll: true });
}

function hideModal() {
  $('modal').classList.add('hidden'); modalKind = ''; primaryAction = secondaryAction = null;
  if (previousFocus?.isConnected && previousFocus.getClientRects().length) previousFocus.focus({ preventScroll: true });
}

$('modal-primary').addEventListener('click', () => primaryAction?.());
$('modal-secondary').addEventListener('click', () => secondaryAction?.());
$('enable-camera').addEventListener('click', enableCamera);
$('enable-camera').addEventListener('pointerdown', stopStartButtonPulse);
$('retry-camera').addEventListener('click', enableCamera);
$('start-calibration').addEventListener('click', beginCalibration);
$('cancel-calibration').addEventListener('click', stopCamera);
$('restart-calibration').addEventListener('click', returnToSetup);
$('camera-stop').addEventListener('click', stopCamera);
$('game-camera-stop').addEventListener('click', stopCamera);
$('pause-button').addEventListener('click', () => pauseGame('manual'));
$('toggle-preview').addEventListener('click', () => {
  if (state === 'setup') return;
  webcam.classList.toggle('collapsed');
  const collapsed = webcam.classList.contains('collapsed');
  $('toggle-preview').textContent = collapsed ? '+' : '−';
  $('toggle-preview').setAttribute('aria-label', collapsed ? 'Show camera preview' : 'Hide camera preview');
});

function positionPermissionArrow() {
  if ($('permission-guide').classList.contains('hidden')) return;
  const anchor = $('permission-camera-anchor');
  if (!anchor) return;
  const word = anchor.getBoundingClientRect();
  // Start at the actual word, not a percentage of the screen. The tip follows
  // the popup's right edge in the reference screenshot (about 33% across).
  // Keep the curl above the heading so it never crosses the guidance text.
  const startX = word.left + Math.min(12, word.width * .15), startY = word.top - 8;
  const endX = Math.max(16, Math.min(window.innerWidth * .335, startX - 96));
  const endY = startY - 8;
  const middle = (startX + endX) / 2;
  const loop = clamp((startX - endX) * .09, 10, 19);
  const top = Math.max(20, startY - loop * 2);
  $('permission-arrow').setAttribute('viewBox', `0 0 ${window.innerWidth} ${window.innerHeight}`);
  $('permission-arrow-path').setAttribute('d',
    `M ${startX} ${startY} ` +
    `C ${startX - 20} ${top - 4}, ${middle - loop} ${top - loop}, ${middle - loop} ${top} ` +
    `C ${middle - loop} ${top + loop}, ${middle + loop} ${top + loop}, ${middle + loop} ${top} ` +
    `C ${middle + loop} ${top - loop}, ${middle - loop} ${top - loop}, ${middle - loop * 1.7} ${top + loop / 2} ` +
    `C ${middle - loop * 2} ${endY}, ${endX + 28} ${endY}, ${endX} ${endY} ` +
    `M ${endX + 12} ${endY - 8} L ${endX} ${endY} L ${endX + 12} ${endY + 8}`);
}

async function enableCamera() {
  if (cameraStartup && !cameraStartup.signal.aborted) return;
  if (stream) { returnToSetup(); return; }
  const epoch = ++cameraEpoch;
  const startup = new AbortController(); cameraStartup = startup;
  cameraAccessConfirmed = false; cameraPermissionStatus = null;
  stopped = false; state = 'setup'; cameraReady = false;
  calibration = null; resetFaceGuide(); gaze = null;
  setScreen('setup'); hideModal();
  $('retry-camera').classList.add('hidden');
  $('setup').classList.add('awaiting-permission');
  $('setup-title').innerHTML = 'Your <span id="permission-camera-anchor">camera</span> preview';
  $('setup-description').textContent = 'Chrome works best. Your preview will appear after you allow camera access.';
  setupStatus('Waiting for camera access…', true);
  $('camera-loading').classList.remove('hidden');
  $('permission-guide').classList.remove('hidden');
  positionPermissionArrow();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error(), { name: 'Unavailable' });
    const media = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
    if (epoch !== cameraEpoch) { media.getTracks().forEach(t => t.stop()); return; }
    stream = media; video.srcObject = media;
    const track = media.getVideoTracks()[0];
    if (!track) throw Object.assign(new Error(), { name: 'NotFoundError' });
    track.addEventListener('ended', () => { if (!stopped && epoch === cameraEpoch) cameraInterrupted(); });
    track.addEventListener('mute', () => { if (epoch === cameraEpoch) loseTracking('Camera paused. Waiting for a live view of your eyes.'); });
    cameraPermissionStatus = await waitForGrantedCameraPermission(startup.signal);
    if (epoch !== cameraEpoch) return;
    $('permission-guide').classList.add('hidden');
    $('setup').classList.remove('awaiting-permission');
    $('setup-description').textContent = 'Camera access allowed. Starting your preview…';
    setupStatus('Waiting for a live camera frame…', true);
    await video.play();
    if (epoch !== cameraEpoch) return;
    await waitForLiveCameraFrame(startup.signal);
    if (epoch !== cameraEpoch || !hasLiveCameraFeed()) return;
    startFrameMonitor();
    cameraAccessConfirmed = true;
    video.parentElement.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    $('permission-guide').classList.add('hidden');
    $('setup').classList.remove('awaiting-permission');
    $('setup-description').innerHTML = `Sit comfortably with your whole face visible.<br>${CALIBRATION_GUIDANCE}`;
    $('camera-loading').classList.add('hidden');
    $('camera-stop').classList.remove('hidden');
    prepareCalibration();
    startInference();
  } catch (error) {
    if (epoch !== cameraEpoch) return;
    cameraAccessConfirmed = false; cameraPermissionStatus = null;
    stream?.getTracks().forEach(t => t.stop()); stream = null; video.srcObject = null;
    $('permission-guide').classList.add('hidden');
    $('setup').classList.remove('awaiting-permission');
    $('camera-loading').classList.add('hidden');
    const messages = {
      NotAllowedError: 'Camera access is blocked. In Chrome, open site controls beside the address bar, allow Camera, then try again. Your computer may also need to allow Chrome to use its camera.',
      NotFoundError: 'No webcam was found. Connect a camera, then try again.',
      NotReadableError: 'The webcam is busy or unavailable. Close other camera apps and try again.',
      Unavailable: 'Camera access needs desktop Chrome on localhost or an HTTPS address.'
    };
    $('setup-title').textContent = 'Let’s get connected.';
    $('setup-description').textContent = messages[error.name] || 'The camera could not start. Check your camera settings and try again.';
    setupStatus('Your camera is not active.');
    $('retry-camera').classList.remove('hidden');
  } finally {
    if (cameraStartup === startup) cameraStartup = null;
  }
}

async function waitForGrantedCameraPermission(signal) {
  let status;
  try { status = await navigator.permissions?.query({ name: 'camera' }); }
  catch { return null; } // Some browsers do not support querying camera permission.
  if (!status) return null;
  await new Promise((resolve, reject) => {
    const cleanup = () => { status.removeEventListener('change', check); signal.removeEventListener('abort', abort); };
    const finish = error => { cleanup(); error ? reject(error) : resolve(); };
    const abort = () => finish(Object.assign(new Error(), { name: 'AbortError' }));
    const check = () => {
      if (signal.aborted) abort();
      else if (status.state === 'granted') finish();
      else if (status.state === 'denied') finish(Object.assign(new Error(), { name: 'NotAllowedError' }));
    };
    status.addEventListener('change', check);
    signal.addEventListener('abort', abort, { once: true });
    check();
  });
  return status;
}

function hasLiveCameraFeed() {
  const track = stream?.getVideoTracks()[0];
  return Boolean(track && stream.active && track.readyState === 'live' && track.enabled && !track.muted &&
    (!cameraPermissionStatus || cameraPermissionStatus.state === 'granted') &&
    video.srcObject === stream && !video.paused && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0);
}

function recordVideoFrame(mediaTime) {
  if (!hasLiveCameraFeed() || !Number.isFinite(mediaTime) || mediaTime === videoFrameTime) return;
  videoFrameTime = mediaTime; videoFrameAt = performance.now(); videoFrameSequence++;
}

function startFrameMonitor() {
  const epoch = cameraEpoch;
  videoFrameTime = -1; videoFrameAt = -Infinity;
  videoFrameSequence = capturedFrameSequence = 0;
  recordVideoFrame(video.currentTime);
  if (!video.requestVideoFrameCallback) return;
  const next = () => {
    videoFrameCallback = video.requestVideoFrameCallback((_, metadata) => {
      videoFrameCallback = null;
      if (epoch !== cameraEpoch || stopped) return;
      recordVideoFrame(metadata.mediaTime);
      next();
    });
  };
  next();
}

function hasFreshCameraFrame(now = performance.now()) {
  // Without frame callbacks, playback time must still advance. Repeatedly
  // drawing an unchanged video element is not a new observation.
  if (!video.requestVideoFrameCallback) recordVideoFrame(video.currentTime);
  return hasLiveCameraFeed() && now - videoFrameAt <= CAMERA_FRAME_GAP_MS;
}

function loseTracking(message) {
  cameraReady = false;
  webcam.classList.add('tracking-warning'); $('webcam-note').textContent = message;
  $('tracking-label').textContent = message;
  if (state === 'calibration') {
    resetTargetDwell();
    $('calibration-hint').textContent = message;
  }
  if (state === 'calibration-ready' && !hasFreshCameraFrame()) restartCalibrationReadyTimer();
  if (state === 'playing' || state === 'countdown') pauseGame('tracking', message);
  if (state === 'paused' && ['tracking', 'offline'].includes(modalKind)) $('modal-primary').disabled = true;
}

function waitForLiveCameraFrame(signal) {
  const track = stream.getVideoTracks()[0];
  return new Promise((resolve, reject) => {
    let frameId = null;
    const events = [[video, 'loadeddata'], [video, 'playing'], [track, 'unmute'], [track, 'ended']];
    const cleanup = () => {
      events.forEach(([target, event]) => target.removeEventListener(event, check));
      signal.removeEventListener('abort', abort);
      if (frameId !== null) video.cancelVideoFrameCallback?.(frameId);
    };
    const finish = error => { cleanup(); error ? reject(error) : resolve(); };
    const abort = () => finish(Object.assign(new Error(), { name: 'AbortError' }));
    const check = () => {
      if (signal.aborted) { abort(); return; }
      if (track.readyState === 'ended') { finish(Object.assign(new Error(), { name: 'NotReadableError' })); return; }
      if (!hasLiveCameraFeed()) return;
      if (!video.requestVideoFrameCallback) { finish(); return; }
      if (frameId !== null) return;
      frameId = video.requestVideoFrameCallback(() => {
        frameId = null;
        if (hasLiveCameraFeed()) finish();
        else check();
      });
    };
    events.forEach(([target, event]) => target.addEventListener(event, check));
    signal.addEventListener('abort', abort, { once: true });
    check();
  });
}

function setupStatus(text, loading = false, good = false) {
  const node = $('setup-status'); node.replaceChildren(); node.classList.toggle('good', good);
  if (loading) { const spinner = document.createElement('span'); spinner.className = 'spinner'; node.append(spinner); }
  node.append(document.createTextNode(text));
}

function stopCamera() {
  stopped = true; cameraEpoch++; calibrationRun++; targetToken = '';
  extendedCalibration = false;
  cameraAccessConfirmed = false; cameraPermissionStatus = null;
  cameraStartup?.abort(); cameraStartup = null;
  cancelTrackingPreparation();
  cloudGazeStream?.stop(); cloudGazeStream = null; cloudGazeReady = false; cloudConnectionError = '';
  browserFaceDetector?.stop().catch(() => {}); browserFaceDetector = null;
  if (videoFrameCallback !== null) video.cancelVideoFrameCallback?.(videoFrameCallback);
  videoFrameCallback = null; videoFrameAt = -Infinity;
  game.running = false; activeRequest?.abort();
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  clearCalibration();
  video.srcObject = null; resetFaceGuide(); gaze = null; lastFace = null; cameraReady = false;
  state = 'welcome'; $('permission-guide').classList.add('hidden');
  $('setup').classList.remove('awaiting-permission');
  hideModal(); setScreen('welcome');
}

function clearCalibration() {
  const oldId = calibrationId;
  calibration = null; calibrationId = null;
  if (oldId) apiFetch(`/api/calibration/${encodeURIComponent(oldId)}`, { method: 'DELETE', keepalive: true }).catch(() => {});
}

function cameraInterrupted() {
  stopCamera(); toast('The camera disconnected. Enable it again to continue.');
}

function faceGeometry(data, result) {
  const f = result?.face, size = data.image_size;
  if (!f || !size || ![f.x, f.y, f.width, f.height, size.width, size.height].every(Number.isFinite)
    || f.width <= 0 || f.height <= 0 || size.width <= 0 || size.height <= 0) return null;
  return { x: f.x / size.width, y: f.y / size.height, width: f.width / size.width, height: f.height / size.height };
}

function resetFaceGuide() {
  baseline = null; latestFaceGuide = null; lastFaceGuideCapture = null;
}

function updateFaceGuideCandidate(face, capturedAt) {
  if (!face || (lastFaceGuideCapture !== null && capturedAt <= lastFaceGuideCapture)) return;
  lastFaceGuideCapture = capturedAt;
  latestFaceGuide = { ...face };
}

async function startInference() {
  if (inferenceActive) return;
  inferenceActive = true;
  while (stream && !stopped) {
    if (detectorEpoch !== cameraEpoch) {
      const epoch = cameraEpoch; detectorEpoch = epoch; detectorFailed = false;
      $('webcam-note').textContent = 'Starting eye tracking. Sit comfortably.';
      const config = await appConfig;
      if (epoch !== cameraEpoch || stopped) continue;
      if (config.error) {
        cloudConnectionError = config.error; detectorFailed = true;
        loseTracking(config.error); $('webcam-note').textContent = config.error;
        continue;
      }
      let preparedStream = null;
      if (config.face_detector) {
        // Keep one detector throughout calibration and play. Switching crop
        // models midway would invalidate the learned screen mapping.
        let expired = false, timer;
        const loading = takePreparedTracking(config).then(prepared => {
          if (expired || epoch !== cameraEpoch || stopped) {
            prepared.face?.stop().catch(() => {}); prepared.stream?.stop(); return null;
          }
          preparedStream = prepared.stream;
          return prepared.face;
        }).catch(() => null);
        browserFaceDetector = await Promise.race([loading, new Promise(resolve => {
          timer = setTimeout(() => { expired = true; resolve(null); cancelTrackingPreparation(); },
            transport === 'cloud-streaming' ? 120000 : FACE_MODEL_LOAD_MS);
        })]);
        clearTimeout(timer);
        if (epoch !== cameraEpoch || stopped) continue;
        webcam.dataset.detector = browserFaceDetector?.modelId || 'opencv-haar-fallback';
      }
      if (transport === 'cloud-streaming') {
        cloudGazeReady = false;
        cloudConnectionError = '';
        const showCloudError = error => {
          if (epoch !== cameraEpoch || stopped) return;
          cloudGazeReady = false;
          cloudConnectionError = error.message;
          loseTracking(error.message);
          webcam.classList.add('tracking-warning'); $('webcam-note').textContent = error.message;
          if (state === 'calibration') $('calibration-hint').textContent = error.message;
          if (state === 'calibration-ready') $('calibration-ready-caption').textContent = error.message;
        };
        try {
          const { CloudGazeStream } = await import('./cloud-stream.js');
          if (epoch !== cameraEpoch || stopped) continue;
          const options = { video, detector: browserFaceDetector,
            context: () => ({ fresh: !document.hidden && hasFreshCameraFrame(), captured_at: videoFrameAt,
              epoch: cameraEpoch, run: calibrationRun, token: targetToken, profile_id: calibrationId }),
            onStatus: message => { if (epoch === cameraEpoch && !stopped) $('webcam-note').textContent = message; },
            onError: showCloudError,
            onPrediction: (data, frame, timing) => {
              if (epoch !== cameraEpoch || stopped || frame.run !== calibrationRun || frame.profile_id !== calibrationId) return;
              latency = timing.frame_ms;
              latencyBreakdown = { frame_ms: latency, capture_ms: null, face_ms: browserFaceDetector?.detectionMs,
                request_ms: null, server_ms: null, workflow_ms: timing.model_ms };
              onPrediction(data, frame.token);
            },
          };
          const cloud = preparedStream || new CloudGazeStream(options);
          cloudGazeStream = cloud;
          if (preparedStream) await cloud.attachCamera(options);
          else await cloud.start();
          if (epoch === cameraEpoch && !stopped) { cloudGazeReady = true; restartCalibrationReadyTimer(); }
          await cloud.closed;
        } catch (error) { cloudGazeStream?.stop(); showCloudError(error); }
        if (epoch === cameraEpoch && !stopped) detectorFailed = true;
        continue;
      }
    }
    if (detectorFailed) { await new Promise(r => setTimeout(r, 150)); continue; }
    if (document.hidden || state === 'gameover' || (state === 'paused' && modalKind === 'manual')) {
      await new Promise(r => setTimeout(r, 150)); continue;
    }
    if (!hasFreshCameraFrame()) {
      loseTracking('Camera paused. Waiting for a live view of your eyes.');
      await new Promise(r => setTimeout(r, 100)); continue;
    }
    if (videoFrameSequence === capturedFrameSequence) { await new Promise(r => setTimeout(r, 20)); continue; }
    const untilNextFrame = GAZE_INTERVAL_MS - (performance.now() - lastInferenceStarted);
    if (untilNextFrame > 0) { await new Promise(r => setTimeout(r, untilNextFrame)); continue; }
    lastInferenceStarted = performance.now();
    capturedFrameSequence = videoFrameSequence;
    const epoch = cameraEpoch, run = calibrationRun, token = targetToken, profileId = calibrationId, capturedAt = videoFrameAt;
    const aspect = video.videoHeight / video.videoWidth;
    const height = Math.round(640 * aspect);
    if (capture.height !== height) capture.height = height;
    captureContext.drawImage(video, 0, 0, 640, height);
    activeRequest = new AbortController();
    const request = activeRequest;
    const timeout = setTimeout(() => request.abort(), 65000);
    const loadingNotice = setTimeout(() => {
      if (epoch === cameraEpoch && run === calibrationRun && !cameraReady && ['calibration-ready', 'calibration'].includes(state)) {
        $('webcam-note').textContent = 'Eye tracking is warming up. Keep your face in view.';
      }
    }, 2000);
    try {
      let frame;
      if (browserFaceDetector) {
        const detector = browserFaceDetector, signal = activeRequest.signal;
        let abort;
        try {
          frame = await Promise.race([detector.capture(capture, capturedAt), new Promise((_, reject) => {
            abort = () => {
              if (epoch === cameraEpoch && !stopped) { detectorFailed = true; detector.stop().catch(() => {}); }
              reject(new Error('Face tracking timed out. Restart your camera to try again.'));
            };
            signal.addEventListener('abort', abort, { once: true });
          })]);
        } finally { signal.removeEventListener('abort', abort); }
      } else frame = { image: capture.toDataURL('image/jpeg', 0.8).split(',')[1] };
      if (epoch !== cameraEpoch || run !== calibrationRun || profileId !== calibrationId || !stream) continue;
      if (!frame) { onPrediction({ captured_at: capturedAt, gazes: [] }, token); continue; }
      const requestStarted = performance.now();
      const response = await apiFetch('/api/gaze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...frame, captured_at: capturedAt, calibration_id: profileId }), signal: activeRequest.signal });
      const data = await response.json();
      if (epoch !== cameraEpoch || run !== calibrationRun || profileId !== calibrationId || !stream) continue;
      if (!response.ok) throw new Error(data.detail || 'Eye tracking is temporarily unavailable.');
      latency = performance.now() - capturedAt;
      latencyBreakdown = { frame_ms: latency, capture_ms: requestStarted - capturedAt,
        face_ms: browserFaceDetector?.detectionMs ?? null, request_ms: performance.now() - requestStarted,
        server_ms: data.timing?.server_ms ?? null, workflow_ms: data.timing?.workflow_ms ?? null };
      onPrediction(data, token);
    } catch (error) {
      clearTimeout(loadingNotice);
      if (epoch !== cameraEpoch || run !== calibrationRun || profileId !== calibrationId || stopped) continue;
      cameraReady = false;
      const message = error.name === 'AbortError' ? 'Eye tracking timed out. Check the Inference server and try again.' : error.message;
      webcam.classList.add('tracking-warning'); $('webcam-note').textContent = message;
      if (state === 'setup') setupStatus(message);
      else if (state === 'calibration') { resetTargetDwell(); $('calibration-hint').textContent = message; }
      else if (state === 'playing' || state === 'countdown') pauseGame('offline', message);
      await new Promise(r => setTimeout(r, 1600));
    } finally { clearTimeout(timeout); clearTimeout(loadingNotice); activeRequest = null; }
  }
  inferenceActive = false;
  // A new camera can be enabled while an old aborted loop is unwinding.
  if (stream && !stopped) startInference();
}

function onPrediction(data, token) {
  // Old target/attempt frames cannot change a new point's tracking state.
  if (state === 'calibration' && (token !== targetToken || targetAdvanceAt !== null)) return;
  if (!hasFreshCameraFrame()) { loseTracking('Camera paused. Waiting for a live view of your eyes.'); return; }
  const result = selectPlayerGaze(data.gazes);
  const face = faceGeometry(data, result);
  const calibrating = ['calibration-ready', 'calibration', 'saving-calibration'].includes(state);
  let reason = '';
  if (!result) reason = calibrating
    ? 'Gaze lost. Look at the dot to restart it.' : 'Gaze lost. Look toward the screen to continue.';
  // Face geometry is an optional visual guide during calibration. Only gaze
  // availability, freshness and angle stability determine a dot's progress.
  const maxAge = state === 'calibration' ? CALIBRATION_GAP_MS : 1200;
  if (!Number.isFinite(data.captured_at) || data.captured_at > performance.now() || performance.now() - data.captured_at > maxAge) reason = 'Eye tracking is delayed. Waiting for a fresh frame.';
  // Keep the newest valid preview reading. beginCalibration snapshots it
  // before the first dot; subsequent readings cannot move the outline.
  if (!reason && state === 'calibration-ready') updateFaceGuideCandidate(face, data.captured_at);
  const moved = face && baseline && postureChanged(face, baseline);
  postureBad = Boolean(moved);
  cameraReady = !reason;
  drawFace(face, !reason && !moved);
  webcam.classList.toggle('tracking-warning', Boolean(reason || moved));
  const calibrationNote = CALIBRATION_GUIDANCE;
  $('webcam-note').textContent = reason || (calibrating ? calibrationNote
    : moved ? 'Head moved. Keep still for accurate eye control.'
    : state === 'setup' ? 'Comfortable? Keep this position.' : 'Eye control is live. Keep comfortably still.');
  if (reason) {
    loseTracking(reason);
    return;
  }
  lastGood = performance.now(); lastFace = face;
  if (state === 'calibration-ready') updateCalibrationReady(performance.now());
  if (calibration) {
    const freshGaze = data.calibration_id === calibrationId && data.screen_point?.length === 2
      ? data.screen_point : mapGaze(calibration, result.yaw, result.pitch);
    const alpha = gaze ? clamp(1 - Math.exp(-(performance.now() - lastGazeAt) / 110), .24, .85) : 1;
    gaze = gaze ? gaze.map((v, i) => Math.abs(freshGaze[i] - v) < .003 ? v : v + alpha * (freshGaze[i] - v)) : freshGaze;
    lastGazeAt = performance.now();
  }
  if (state === 'calibration' && !document.hidden && data.captured_at >= targetReadyAt) {
    if (lastTargetCapture !== null && (data.captured_at <= lastTargetCapture || data.captured_at - lastTargetCapture > CALIBRATION_GAP_MS)) {
      resetTargetDwell();
      $('calibration-hint').textContent = 'Tracking was interrupted. This point starts again from zero.';
      return;
    }
    if (targetSamples.length) {
      const anchor = aggregateAngles(targetSamples.map(s => [s.yaw, s.pitch]));
      if (Math.hypot(result.yaw - anchor[0], result.pitch - anchor[1]) > .10) {
        resetTargetDwell();
        $('calibration-hint').textContent = 'The gaze estimate shifted. Keep looking at this dot to restart the point.';
        return;
      }
    }
    if (dwellStarted === null) dwellStarted = data.captured_at;
    lastTargetCapture = data.captured_at;
    targetLastGood = performance.now();
    targetSamples.push({ yaw: result.yaw, pitch: result.pitch, captured_at: data.captured_at });
    $('target').classList.add('is-fixating');
    $('calibration-hint').textContent = CALIBRATION_GUIDANCE;
    updateCalibration(performance.now());
  }
  if (state === 'paused' && ['tracking', 'offline'].includes(modalKind)) {
    $('modal-description').textContent = 'You’re back in view. Continue when you’re ready.';
    $('modal-primary').disabled = false;
  }
  $('tracking-label').textContent = 'Eye control is live';
  $('latency-label').textContent = `${Math.round(latency)} ms`;
  if (latencyBreakdown) {
    const timing = latencyBreakdown;
    $('latency-label').title = `Fresh frame to gaze: ${Math.round(timing.frame_ms)} ms`
      + (timing.capture_ms === null ? '' : `; capture/crop: ${Math.round(timing.capture_ms)} ms`)
      + (timing.request_ms === null ? '' : `; gaze request: ${Math.round(timing.request_ms)} ms`)
      + (timing.face_ms === null ? '' : `; background face detection: ${Math.round(timing.face_ms)} ms`)
      + (timing.workflow_ms === null ? '' : `; gaze model: ${Math.round(timing.workflow_ms)} ms`);
    $('latency-label').dataset.timing = JSON.stringify(timing);
  }
}

function drawFace(face, good) {
  const overlay = $('face-overlay'), c = overlay.getContext('2d');
  // Canvas and video must have identical intrinsic aspect ratios: CSS crops
  // both with object-fit:cover before applying the same preview mirror.
  const width = 640, height = video.videoWidth && video.videoHeight
    ? Math.round(width * video.videoHeight / video.videoWidth) : 480;
  if (overlay.width !== width || overlay.height !== height) { overlay.width = width; overlay.height = height; }
  c.clearRect(0, 0, width, height);
  if (baseline) {
    c.strokeStyle = 'rgba(38,56,47,.35)'; c.lineWidth = 5; c.setLineDash([8, 8]);
    c.beginPath(); c.ellipse(baseline.x * width, baseline.y * height,
      baseline.width * width * .58, baseline.height * height * .65, 0, 0, Math.PI * 2); c.stroke();
    c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 2; c.stroke(); c.setLineDash([]);
  }
  if (face) {
    c.strokeStyle = good ? '#d4f58a' : '#edc767'; c.lineWidth = 3;
    c.beginPath(); c.roundRect((face.x - face.width / 2) * width, (face.y - face.height / 2) * height, face.width * width, face.height * height, 12); c.stroke();
  }
}

function prepareCalibration() {
  if (!cameraAccessConfirmed || !hasLiveCameraFeed()) return;
  hideModal(); game.reset(); clearCalibration(); gaze = null; resetFaceGuide(); cameraReady = false;
  // Recollect every point for this run. Retries preserve the chosen length,
  // and repeated Recalibrate clicks never append another set of targets.
  targets = (extendedCalibration ? [...initialTargets, ...additionalTargets] : initialTargets).map(point => [...point]);
  calibrationRun++; calibrationPoints = []; targetIndex = 0;
  calibrationViewport = [window.innerWidth, window.innerHeight];
  targetToken = ''; targetSamples = []; dwellStarted = null;
  state = 'calibration-ready'; setScreen('calibration');
  $('calibration').classList.remove('extra-points', 'lower-center-target');
  $('calibration').classList.add('preparing');
  $('calibration-ready').classList.remove('hidden');
  $('restart-calibration').classList.add('hidden');
  $('calibration-label').textContent = '02 / LEARN YOUR GAZE';
  $('calibration-heading').textContent = 'Look at the first dot.';
  $('calibration-instruction').innerHTML = extendedCalibration
    ? `${CALIBRATION_GUIDANCE}<br>Follow the original nine dots, then nine new positions. All 18 help map your gaze.`
    : `${CALIBRATION_GUIDANCE}<br>Follow nine dots, letting each circle fill for one second. Then the game begins.`;
  $('target').classList.remove('hidden');
  webcam.classList.remove('tracking-warning');
  $('webcam-note').textContent = 'Looking for your gaze. Sit comfortably.';
  drawFace(null, false);
  positionCalibration();
  restartCalibrationReadyTimer();
}

function positionCalibration() {
  const preview = webcam.getBoundingClientRect();
  const radius = $('target').getBoundingClientRect().width * .4;
  targets[0] = [.5, clamp((preview.top - radius - 24) / window.innerHeight, .10, .32)];
  $('calibration').style.setProperty('--first-target-top', `${targets[0][1] * 100}%`);
  $('calibration').style.setProperty('--preview-bottom', `${preview.bottom}px`);
}

function beginCalibration() {
  if (state !== 'calibration-ready' || document.hidden || !calibrationCanStart()) return;
  // Freeze position and size from the last fresh face reading at the instant
  // calibration begins. Missing face geometry must never block eye tracking.
  baseline = latestFaceGuide && performance.now() - lastFaceGuideCapture <= CALIBRATION_GAP_MS
    ? { ...latestFaceGuide } : null;
  postureBad = false;
  drawFace(baseline, true);
  $('webcam-note').textContent = baseline || cameraReady ? CALIBRATION_GUIDANCE
    : 'Waiting for eye tracking. Keep looking at the dot.';
  calibrationReadyStarted = null;
  state = 'calibration';
  $('calibration').classList.remove('preparing');
  $('calibration-ready').classList.add('hidden');
  $('restart-calibration').classList.remove('hidden');
  positionCalibration();
  showTarget();
}

function restartCalibrationReadyTimer() {
  calibrationReadyStarted = null;
  $('calibration-ready-progress').style.transform = 'scaleX(1)';
  $('calibration-ready-caption').textContent = `Starts automatically in ${CALIBRATION_PREVIEW_MS / 1000} seconds`;
  updateCalibrationReady(performance.now());
}

function calibrationCanStart() {
  // Local inference can warm up on the first dot. Cloud streaming must first
  // connect and demonstrate fresh results, before the three-second timer runs.
  return cameraAccessConfirmed && hasFreshCameraFrame() && (transport !== 'cloud-streaming' || cloudGazeReady);
}

function updateCalibrationReady(now) {
  if (state !== 'calibration-ready' || document.hidden) return;
  $('start-calibration').disabled = !calibrationCanStart();
  if (!calibrationCanStart()) {
    calibrationReadyStarted = null;
    $('calibration-ready-progress').style.transform = 'scaleX(1)';
    $('calibration-ready-caption').textContent = cloudConnectionError || (transport === 'cloud-streaming' && !cloudGazeReady
      ? 'Preparing eye tracking…' : 'Waiting for a live camera preview…');
    return;
  }
  if (calibrationReadyStarted === null) calibrationReadyStarted = now;
  const remaining = Math.max(0, CALIBRATION_PREVIEW_MS - (now - calibrationReadyStarted));
  $('calibration-ready-progress').style.transform = `scaleX(${remaining / CALIBRATION_PREVIEW_MS})`;
  const seconds = Math.ceil(remaining / 1000);
  const caption = `Starts automatically in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
  if ($('calibration-ready-caption').textContent !== caption) $('calibration-ready-caption').textContent = caption;
  if (remaining === 0) beginCalibration();
}

function setTargetProgress(progress) {
  $('target').style.setProperty('--fill-angle', `${progress * 360}deg`);
  $('target-progress').style.strokeDashoffset = String(201.06 * (1 - progress));
}

function resetTargetDwell(settle = false) {
  targetSamples = []; dwellStarted = null; targetLastGood = 0; lastTargetCapture = null;
  targetAdvanceAt = null;
  targetShown = performance.now();
  targetReadyAt = targetShown + (settle ? 250 : 0);
  targetToken = `${calibrationRun}:${++targetSequence}:${targetIndex}`;
  $('target').classList.remove('is-fixating', 'is-complete');
  setTargetProgress(0);
}

function showTarget() {
  const [x, y] = targets[targetIndex];
  resetTargetDwell(true);
  $('target').style.left = `${x * 100}%`; $('target').style.top = `${y * 100}%`;
  $('calibration').classList.toggle('extra-points', targetIndex >= initialTargets.length);
  $('calibration').classList.toggle('lower-center-target', x === .5 && y > .7);
  $('calibration-count').textContent = `DOT ${targetIndex + 1} OF ${targets.length}`;
  $('calibration-dots').replaceChildren(...targets.map((_, i) => { const dot = document.createElement('i'); dot.className = i < targetIndex ? 'done' : i === targetIndex ? 'active' : ''; return dot; }));
  if (targetIndex) $('calibration-heading').textContent = 'Now look at the next dot.';
  $('calibration-hint').textContent = CALIBRATION_GUIDANCE;
}

function updateCalibration(now) {
  if (state !== 'calibration' || document.hidden) return;
  if (!hasFreshCameraFrame(now)) { loseTracking('Camera paused. Waiting for a live view of your eyes.'); return; }
  if (targetAdvanceAt !== null) {
    if (now >= targetAdvanceAt) completeTarget();
    return;
  }
  if (dwellStarted === null) return;
  // Capture spacing is checked when the next response arrives. Testing the
  // previous capture's age here double-counted latency and discarded healthy
  // in-flight samples on 400–700 ms connections.
  if (now - targetLastGood > CALIBRATION_GAP_MS) {
    resetTargetDwell();
    webcam.classList.add('tracking-warning');
    $('webcam-note').textContent = 'Waiting for a fresh view of your eyes.';
    $('calibration-hint').textContent = 'Waiting for a fresh view of your eyes. Keep looking at the dot.';
    return;
  }
  // Only confirmed samples advance time. Never extrapolate between inference
  // responses: a look-away or missing frame must not finish the clock.
  const progress = clamp((lastTargetCapture - dwellStarted) / 1000, 0, 1);
  if (progress === 1 && targetSamples.length >= 3) {
    // Show the completed clock briefly before revealing the next point.
    $('target').classList.add('is-complete');
    targetAdvanceAt = now + 140;
  }
  setTargetProgress(progress);
}

async function completeTarget() {
  if (state !== 'calibration' || targetSamples.length < 3) return;
  calibrationPoints.push({ target: [...targets[targetIndex]], samples: [...targetSamples] });
  targetIndex++;
  if (targetIndex < targets.length) { showTarget(); return; }
  const run = calibrationRun;
  state = 'saving-calibration'; targetToken = '';
  setTargetProgress(1);
  $('calibration-hint').textContent = 'Calibration complete. Starting your game…';
  try {
    const response = await apiFetch('/api/calibration', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: calibrationPoints, viewport: calibrationViewport }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (run !== calibrationRun || state !== 'saving-calibration' || !stream) {
      if (data.calibration_id) apiFetch(`/api/calibration/${encodeURIComponent(data.calibration_id)}`, { method: 'DELETE' }).catch(() => {});
      return;
    }
    if (!response.ok) throw new Error(data.detail || 'Calibration couldn’t be saved. Please try again.');
    clearCalibration();
    calibration = data.model; calibrationId = data.calibration_id;
    targetAdvanceAt = null;
    const angles = aggregateAngles(targetSamples.map(s => [s.yaw, s.pitch]));
    gaze = mapGaze(calibration, ...angles); lastGazeAt = performance.now();
    startRound();
    if (data.quality?.approximate) toast('Eye control may be approximate. You can recalibrate from Pause.');
  } catch (error) {
    if (run === calibrationRun && state === 'saving-calibration') calibrationFailed(error.name === 'TimeoutError' ? 'Saving calibration took too long. Please try again.' : error.message);
  }
}

function calibrationFailed(message) {
  clearCalibration(); targetToken = ''; state = 'calibration-failed';
  setScreen('setup');
  showModal({ kind: 'calibration-failed', label: 'LET’S FIND YOUR FOCUS', title: 'One more calibration.', description: message,
    primary: 'Try calibration again', secondary: 'Turn camera off', action: returnToSetup, secondaryAction: stopCamera });
}

function returnToSetup() {
  if (!stream) { enableCamera(); return; }
  prepareCalibration();
  startInference();
}

function recalibrate() {
  extendedCalibration = true;
  returnToSetup();
}

function startRound() {
  if (!calibration) { returnToSetup(); return; }
  game.reset(); state = 'playing'; game.running = true; setScreen('game-view'); hideModal();
  if (document.hidden) pauseGame('manual');
  else if (!canControlGame()) pauseGame('tracking');
}

function endGame(result) {
  if (state !== 'playing') return;
  state = 'gameover';
  showModal({ kind: 'gameover', label: 'THAT’S A WRAP', title: 'One more rally?',
    description: result.playerReturns ? 'A good rally starts with a little focus.' : 'Look toward the ball’s arrival point to meet it with your paddle.',
    stats: [[String(result.playerReturns).padStart(2, '0'), 'RETURNS'], [`${result.multiplier.toFixed(1)}×`, 'TOP SPEED']],
    primary: 'Replay', secondary: 'Recalibrate', action: startRound, secondaryAction: recalibrate });
}

function pauseGame(kind, message) {
  if (!['playing', 'countdown'].includes(state)) return;
  game.running = false; state = 'paused';
  const tracking = ['tracking', 'offline'].includes(kind);
  showModal({ kind, label: tracking ? 'LET’S RECONNECT' : 'TAKE YOUR TIME', title: tracking ? 'Find your focus.' : 'A moment to refocus.',
    description: message || (tracking ? 'Waiting for live eye tracking. Look toward the screen to continue.' : 'Your rally is right where you left it.'),
    primary: 'Continue', secondary: 'Recalibrate', action: resumeGame, secondaryAction: recalibrate });
  $('modal-primary').disabled = tracking && !canControlGame();
}

function canControlGame() {
  return cameraReady && hasFreshCameraFrame() && performance.now() - lastGood <= 1400;
}

function resumeGame() {
  if (!canControlGame()) {
    modalKind = 'tracking'; $('modal-primary').disabled = true;
    $('modal-description').textContent = 'Look toward the camera and return to your calibrated position.';
    return;
  }
  state = 'countdown';
  showModal({ kind: 'countdown', label: 'READY WHEN YOU ARE', title: 'Back in focus.', description: 'Your rally continues.' });
  countdownEnd = performance.now() + 2200;
}

function tick(now) {
  const dt = Math.min((now - lastTick) / 1000, .04); lastTick = now;
  if (state === 'welcome') {
    const t = now / 1000;
    demo.ball = { x: Math.sin(t * .65) * .54, y: Math.cos(t * .9) * .25, z: 2.6 + Math.sin(t * .8) * 1.8 };
    demo.player.x = Math.sin(t * .65 - .5) * .35; demo.player.y = Math.cos(t * .9 - .5) * .13;
    demo.cpu.x = Math.sin(t * .5) * .3; demo.cpu.y = Math.sin(t * .4) * .17;
    demo.trail.push({ ...demo.ball }); if (demo.trail.length > 12) demo.trail.shift();
    hero.render(demo, { demo: true, time: t });
  }
  if (state === 'calibration') updateCalibration(now);
  if (state === 'calibration-ready') updateCalibrationReady(now);
  if (['playing', 'countdown', 'gameover', 'paused'].includes(state)) {
    if (gaze) { const [x, y] = court.gazeToCourt(...gaze); if (Number.isFinite(x) && Number.isFinite(y)) game.setTarget(x, y); }
    if (['playing', 'countdown'].includes(state) && !canControlGame()) loseTracking('Waiting for live eye tracking. Your rally is paused.');
    if (state === 'countdown') {
      const remain = countdownEnd - now;
      $('countdown-number').textContent = String(Math.max(1, Math.ceil(remain / 1000)));
      if (remain <= 0) { hideModal(); state = 'playing'; game.running = true; }
    }
    game.update(dt);
    court.render(game, { marker: state === 'playing' ? gaze : null });
    $('rally-count').textContent = String(game.playerReturns).padStart(2, '0');
    $('speed-count').firstChild.textContent = (game.speed / game.initialSpeed).toFixed(1);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

window.addEventListener('resize', () => {
  positionPermissionArrow();
  if (['calibration-ready', 'calibration', 'saving-calibration'].includes(state)) { returnToSetup(); toast('The window size changed. Let’s restart calibration.'); }
  else if (calibration) {
    game.running = false; clearCalibration(); state = 'paused';
    showModal({ kind: 'resize', label: 'NEW WINDOW, NEW VIEW', title: 'Let’s recalibrate.', description: 'The window changed size. A fresh calibration keeps your paddle aligned with your eyes.', primary: 'Recalibrate', action: recalibrate });
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopStartButtonPulse(); pauseGame('manual'); }
  else if (state === 'welcome') scheduleStartButtonPulse();
  if (state === 'calibration') resetTargetDwell();
  if (state === 'calibration-ready') restartCalibrationReadyTimer();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (['calibration-ready', 'calibration', 'saving-calibration'].includes(state)) stopCamera();
    else if (state === 'playing' || state === 'countdown') pauseGame('manual');
    else if (state === 'paused' && modalKind === 'manual') resumeGame();
  }
  if (event.key === 'Tab' && !$('modal').classList.contains('hidden')) {
    const buttons = [...$('modal').querySelectorAll('button')].filter(b => !b.classList.contains('hidden') && !b.disabled);
    if (!buttons.length) { event.preventDefault(); return; }
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && (document.activeElement === first || !buttons.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !buttons.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
  }
});
window.addEventListener('pagehide', () => {
  pageClosed = true; cancelTrackingPreparation();
  stopStartButtonPulse(); clearCalibration(); stopped = true; cameraAccessConfirmed = false;
  cameraStartup?.abort(); activeRequest?.abort(); stream?.getTracks().forEach(t => t.stop());
  if (videoFrameCallback !== null) video.cancelVideoFrameCallback?.(videoFrameCallback);
  browserFaceDetector?.stop().catch(() => {});
  cloudGazeStream?.stop();
});
