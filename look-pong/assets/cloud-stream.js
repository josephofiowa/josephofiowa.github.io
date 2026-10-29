// WHIP publishing with latest-only JSON results. Calibration and Pong remain
// in the browser. The frame tag survives video transport and codec buffering.
import { apiFetch, resultsUrl } from './api-client.js';

export const STREAM_WIDTH = 448, STREAM_HEIGHT = 480, TAG_HEIGHT = 32;
export const CAMERA_READY_TIMEOUT_MS = 30000;

export function frameTag(sequence, hasFace) {
  const bytes = [0xA5, hasFace ? 0x3C : 0x3D, sequence >>> 24, (sequence >>> 16) & 255,
    (sequence >>> 8) & 255, sequence & 255];
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 128 ? 7 : 0)) & 255;
  }
  return [...bytes, crc].flatMap(byte => Array.from({ length: 8 }, (_, bit) => (byte >>> (7 - bit)) & 1));
}

export class FrameLedger {
  constructor({ now = () => performance.now(), maxAge = 800 } = {}) {
    this.now = now; this.maxAge = maxAge; this.sequence = 0; this.lastAccepted = 0; this.frames = new Map();
  }
  record(metadata) {
    this.sequence++;
    this.frames.set(this.sequence, { ...metadata });
    for (const [id, frame] of this.frames) if (this.now() - frame.captured_at > this.maxAge || this.frames.size > 120) this.frames.delete(id);
    return this.sequence;
  }
  accept(sequence) {
    if (!Number.isInteger(sequence) || sequence <= this.lastAccepted) return null;
    const frame = this.frames.get(sequence);
    if (!frame || this.now() - frame.captured_at > this.maxAge) return null;
    this.lastAccepted = sequence;
    for (const id of this.frames.keys()) if (id <= sequence) this.frames.delete(id);
    return frame;
  }
}

export class CloudGazeStream {
  constructor({ video = null, detector = null, context = null, onPrediction = () => {}, onStatus = () => {}, onError = () => {}, onFace = () => {} } = {}) {
    this.video = video; this.detector = detector; this.context = context;
    this.onPrediction = onPrediction; this.onStatus = onStatus; this.onError = onError;
    this.onFace = onFace;
    this.abort = new AbortController(); this.ledger = new FrameLedger();
    this.canvas = document.createElement('canvas'); this.canvas.width = STREAM_WIDTH; this.canvas.height = STREAM_HEIGHT;
    this.paint = this.canvas.getContext('2d', { alpha: false });
    this.capture = document.createElement('canvas'); this.capture.width = 640;
    this.captureContext = this.capture.getContext('2d', { alpha: false });
    this.stopped = false; this.streak = 0; this.running = false; this.cameraReady = false;
    this.cameraStats = { captures: 0, frames: 0, faces: 0, results: 0, late: 0 };
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.prepared = new Promise((resolve, reject) => { this.resolvePrepared = resolve; this.rejectPrepared = reject; });
    this.ready.catch(() => {});
    this.prepared.catch(() => {});
  }

  async api(path, body) {
    const response = await apiFetch(`/api/stream/${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(65000)]) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || 'The connection failed. Turn the camera off and try again.');
    return result;
  }

  async start({ prewarm = false } = {}) {
    this.prewarming = prewarm;
    try {
      if (!prewarm && typeof this.detector?.readFace !== 'function') throw new Error('Eye tracking could not load. Reload and try again.');
      const codecs = RTCRtpSender.getCapabilities('video')?.codecs.filter(codec =>
        codec.mimeType.toLowerCase() === 'video/h264' && codec.sdpFmtpLine?.includes('packetization-mode=1'))
        .sort((a, b) => Number(b.sdpFmtpLine.includes('42e0')) - Number(a.sdpFmtpLine.includes('42e0')));
      if (!codecs?.length) throw new Error('Open the game in desktop Chrome to use eye tracking.');
      this.onStatus('Connecting eye tracking…');
      const session = await this.api('sessions', { attempt: crypto.randomUUID() });
      this.id = session.id;
      if (this.stopped) { await this.release(); return; }
      this.ws = new WebSocket(resultsUrl(this.id));
      this.ws.onmessage = event => this.receive(event);
      this.ws.onerror = () => this.fail(new Error('The eye-tracking connection was interrupted. Restart the camera.'));
      this.ws.onclose = () => { if (!this.stopped) this.fail(new Error('Eye tracking disconnected. Restart the camera.')); };
      this.heartbeat = setInterval(() => { if (this.ws.readyState === WebSocket.OPEN) this.ws.send('ping'); }, 10000);
      this.media = this.canvas.captureStream(0);
      this.track = this.media.getVideoTracks()[0];
      this.pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle', iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      const transceiver = this.pc.addTransceiver(this.track, { direction: 'sendonly' });
      transceiver.setCodecPreferences(codecs);
      const senderParameters = transceiver.sender.getParameters();
      if (senderParameters.encodings?.length) {
        senderParameters.encodings[0].maxBitrate = 1500000;
        senderParameters.encodings[0].maxFramerate = 15;
        await transceiver.sender.setParameters(senderParameters);
      }
      this.publishFrames();
      await this.pc.setLocalDescription(await this.pc.createOffer());
      await this.waitFor(this.pc, 'icegatheringstatechange', () => this.pc.iceGatheringState === 'complete', 10000);
      const answer = await this.api(`sessions/${this.id}/offer`, { sdp: this.pc.localDescription.sdp });
      await this.pc.setRemoteDescription(answer);
      await this.waitFor(this.pc, 'connectionstatechange', () => this.pc.connectionState === 'connected', 30000);
      this.pc.addEventListener('connectionstatechange', () => {
        if (['failed', 'closed'].includes(this.pc.connectionState) && !this.stopped) this.fail(new Error('The connection ended. Restart the camera.'));
        if (this.pc.connectionState === 'disconnected') {
          clearTimeout(this.disconnectTimer);
          this.disconnectTimer = setTimeout(() => {
            if (this.pc.connectionState !== 'connected') this.fail(new Error('The connection was lost. Restart the camera.'));
          }, 5000);
        } else clearTimeout(this.disconnectTimer);
      });
      this.onStatus('Starting the eye-tracking model…');
      await this.api(`sessions/${this.id}/start`, {});
      this.warmupTimer = setTimeout(() => this.fail(new Error('The eye-tracking model did not become ready. Please retry eye tracking.')), 120000);
      this.pollStatus();
      await (prewarm ? this.prepared : this.ready);
    } catch (error) {
      if (!this.stopped) this.fail(error);
      throw error;
    }
  }

  async attachCamera({ video, detector, context, onPrediction, onStatus, onError, onFace = () => {} }) {
    if (this.stopped) throw new Error('Eye tracking stopped. Restart the camera.');
    if (typeof detector?.readFace !== 'function') throw new Error('Eye tracking could not load. Reload and try again.');
    Object.assign(this, { video, detector, context, onPrediction, onStatus, onError, onFace });
    this.prewarming = false; this.streak = 0; this.lastResult = 0;
    this.cameraStats = { captures: 0, frames: 0, faces: 0, results: 0, late: 0 };
    this.beginCameraReadiness();
    // Keep sequence numbers increasing; prewarm frames can never become
    // calibration samples or position the user's head outline.
    this.ledger.frames.clear();
    clearTimeout(this.frameTimer); this.wakeFrames?.();
    this.onStatus('Finding your face and gaze. Keep your whole face in view.');
    await this.ready;
  }

  beginCameraReadiness() {
    if (this.stopped || this.prewarming || this.cameraReady || this.cameraReadyTimer) return;
    // Synthetic warmup only proves the model is running. The real camera must
    // independently produce fresh, usable results within a bounded wait.
    this.cameraReadyTimer = setTimeout(() => {
      this.cameraReadyTimer = null;
      const { captures, frames, faces, results, late } = this.cameraStats;
      const [code, message] = !captures
        ? ['camera-frames', 'No live camera frames reached eye tracking. Check that your camera preview is moving, then retry.']
        : !frames
          ? ['face-worker', 'Face detection is not responding in this browser. Please retry in desktop Chrome.']
        : !faces
          ? ['face-crop', 'Face detection could not find a usable face. Keep your whole face in view with good lighting, then retry eye tracking.']
          : !results
            ? ['gaze-results', 'The connection opened, but no eye-tracking results arrived. Retry eye tracking; if it persists, try another network.']
            : late >= results
              ? ['gaze-late', 'Eye-tracking results are arriving too slowly. Close other busy tabs and retry on a stable connection.']
              : ['gaze-unsteady', 'Eye tracking could not get a steady reading. Keep your whole face in view and retry.'];
      // Counts and a stage code only: no images, gaze angles, tokens or URLs.
      console.warn('[Look Pong startup]', { code, ...this.cameraStats });
      this.fail(new Error(`${message} (${code})`));
    }, CAMERA_READY_TIMEOUT_MS);
  }

  waitFor(target, event, condition, timeout) {
    if (condition()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer); target.removeEventListener(event, check); this.abort.signal.removeEventListener('abort', cancel);
        error ? reject(error) : resolve();
      };
      const check = () => {
        if (condition()) finish();
        else if (target.connectionState === 'failed') finish(new Error('Could not connect. Check your network and retry.'));
      };
      const cancel = () => finish(new Error('Camera connection stopped.'));
      const timer = setTimeout(() => finish(new Error('The connection timed out. Check your network and retry.')), timeout);
      target.addEventListener(event, check); this.abort.signal.addEventListener('abort', cancel, { once: true });
      if (this.abort.signal.aborted) cancel();
    });
  }

  async publishFrames() {
    let lastVideoTime = -1;
    while (!this.stopped) {
      const began = performance.now();
      try {
        if (this.prewarming) {
          const sequence = this.ledger.record({ captured_at: began, warmup: true });
          // Synthetic pixels initialize L2CS on the GPU without camera access.
          // Any resulting angles are ignored by receive().
          this.paint.fillStyle = '#808080'; this.paint.fillRect(0, TAG_HEIGHT, STREAM_WIDTH, STREAM_WIDTH);
          this.paintTag(sequence, true);
          this.track.requestFrame();
        } else {
          const metadata = this.context();
          if (metadata.fresh && this.video.currentTime !== lastVideoTime) {
            lastVideoTime = this.video.currentTime;
            const height = Math.round(640 * this.video.videoHeight / this.video.videoWidth);
            if (this.capture.height !== height) this.capture.height = height;
            this.captureContext.drawImage(this.video, 0, 0, 640, height);
            this.cameraStats.captures++;
            const face = await this.detector.readFace(this.capture, metadata.captured_at);
            if (this.stopped) break;
            // Game over or pause can happen while face detection is pending.
            if (!this.context().fresh) continue;
            this.onFace(face);
            this.cameraStats.frames++;
            if (face) this.cameraStats.faces++;
            if (!this.cameraReady) this.onStatus(face
              ? 'Face found. Waiting for fresh eye-tracking results…'
              : 'Looking for your face. Keep your whole face in view.');
            const sequence = this.ledger.record({ ...metadata, face_crop: face });
            this.paint.fillStyle = '#000'; this.paint.fillRect(0, TAG_HEIGHT, STREAM_WIDTH, STREAM_WIDTH);
            if (face) this.paint.drawImage(this.capture, face.x - face.width / 2, face.y - face.height / 2,
              face.width, face.height, 0, TAG_HEIGHT, STREAM_WIDTH, STREAM_WIDTH);
            this.paintTag(sequence, Boolean(face));
            this.track.requestFrame();
          }
        }
      } catch (error) { this.fail(error); break; }
      const interval = this.prewarming && this.preparedAt ? 1000 : 1000 / 15;
      await new Promise(resolve => { this.frameTimer = setTimeout(resolve, Math.max(0, interval - (performance.now() - began))); this.wakeFrames = resolve; });
    }
  }

  paintTag(sequence, hasFace) {
    frameTag(sequence, hasFace).forEach((bit, index) => {
      this.paint.fillStyle = bit ? '#fff' : '#000'; this.paint.fillRect(index * 8, 0, 8, TAG_HEIGHT);
    });
  }

  receive(event) {
    if (this.stopped) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type !== 'prediction') return;
    const prediction = message.prediction;
    if (!this.prewarming) this.cameraStats.results++;
    const frame = this.ledger.accept(prediction?.frame_sequence);
    if (!frame) {
      if (!this.prewarming) this.cameraStats.late++;
      return;
    }
    if (frame.warmup) {
      if (prediction.gazes?.length === 1 && ['yaw', 'pitch'].every(key => Number.isFinite(prediction.gazes[0][key]))) {
        this.preparedAt = performance.now(); this.checkReady();
      }
      return;
    }
    const face = frame.face_crop;
    const valid = face && prediction.gazes?.length === 1 && ['yaw', 'pitch'].every(key => Number.isFinite(prediction.gazes[0][key]));
    const age = performance.now() - frame.captured_at;
    this.streak = valid ? (performance.now() - (this.lastResult || 0) < 800 ? this.streak + 1 : 1) : 0;
    this.lastResult = performance.now();
    const data = { captured_at: frame.captured_at,
      gazes: valid ? [{ ...prediction.gazes[0], face }] : [],
      face_count: valid ? 1 : 0, image_size: { width: face?.image_width || 640, height: face?.image_height || this.capture.height },
      timing: { workflow_ms: prediction.model_ms }, calibration_id: null };
    this.onPrediction(data, frame, { frame_ms: age, model_ms: prediction.model_ms, device: prediction.device });
    this.checkReady();
  }

  checkReady() {
    if (this.prewarming && this.running && this.preparedAt && performance.now() - this.preparedAt < 1500) {
      clearTimeout(this.warmupTimer); this.resolvePrepared();
    }
    if (!this.prewarming && this.running && this.streak >= 3 && performance.now() - this.lastResult < 800) {
      this.cameraReady = true;
      clearTimeout(this.cameraReadyTimer); this.cameraReadyTimer = null;
      clearTimeout(this.warmupTimer);
      this.resolvePrepared();
      this.resolveReady();
    }
  }

  async pollStatus() {
    if (this.stopped) return;
    try {
      const status = await this.api(`sessions/${this.id}`);
      if (this.stopped) return;
      if (status.closed || ['error', 'stopped', 'cancelled', 'completed'].includes(status.state)) throw new Error('Eye tracking stopped. Turn the camera off and try again.');
      this.running = status.state === 'running';
      if (this.running) this.beginCameraReadiness();
      this.checkReady();
      this.statusTimer = setTimeout(() => this.pollStatus(), this.running ? 10000 : 2000);
    } catch (error) { if (!this.stopped) this.fail(error); }
  }

  fail(error) {
    if (this.stopped) return;
    this.rejectPrepared(error); this.rejectReady(error); this.onError(error); this.stop();
  }

  async release() {
    if (!this.id) return;
    try { await apiFetch(`/api/stream/sessions/${this.id}/stop`, { method: 'POST', keepalive: true, signal: AbortSignal.timeout(10000) }); } catch { /* Owner lease also expires if disconnected. */ }
  }

  async stop() {
    if (this.stopped) return this.shutdown;
    this.stopped = true; this.abort.abort(); this.rejectReady(new Error('Camera connection stopped.'));
    this.rejectPrepared(new Error('Camera connection stopped.'));
    for (const timer of [this.frameTimer, this.statusTimer, this.warmupTimer, this.cameraReadyTimer, this.disconnectTimer, this.heartbeat]) clearTimeout(timer);
    this.wakeFrames?.(); this.pc?.close(); this.ws?.close(); this.media?.getTracks().forEach(track => track.stop());
    this.resolveClosed();
    this.shutdown = this.release();
    await this.shutdown;
  }
}
