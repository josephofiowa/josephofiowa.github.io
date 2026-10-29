// Prepare models without opening the camera. Ownership transfers to the game
// on Get Started; an unused landing-page connection expires after two minutes.
export class TrackingPreparation {
  constructor({ loadFace, createStream, onStatus = () => {}, idleMs = 120000 }) {
    this.disposed = false; this.claimed = false; this.onStatus = onStatus;
    this.failure = new Promise(resolve => { this.resolveFailure = resolve; });
    this.onStatus('Loading face detection…');
    this.idleTimer = setTimeout(() => { if (!this.claimed) this.dispose(); }, idleMs);
    this.facePromise = Promise.resolve().then(loadFace).then(async face => {
      this.face = face;
      if (this.disposed) { await this.stopFace(); return null; }
      this.onStatus('Preparing face detection…');
      await face?.warmup?.();
      if (this.disposed) { await this.stopFace(); return null; }
      this.faceReady = true;
      this.onStatus(this.streamStatus || 'Connecting eye tracking…');
      return face;
    }).catch(async error => {
      this.faceError = error?.code === 'face-download' ? error
        : new Error('Face detection could not initialize in this browser. Please retry in desktop Chrome. (face-model)');
      this.resolveFailure(this.faceError);
      await this.stopFace(); return null;
    });
    this.streamPromise = createStream ? Promise.resolve().then(createStream).then(async stream => {
      this.stream = stream;
      stream.onStatus = message => {
        this.streamStatus = message;
        if (this.faceReady && !this.disposed) this.onStatus(message);
      };
      if (this.disposed) { await stream.stop(); return null; }
      await stream.start({ prewarm: true });
      if (this.disposed) { await stream.stop(); return null; }
      return stream;
    }).catch(async error => {
      this.streamError = error; this.resolveFailure(error);
      await this.stream?.stop(); return null;
    }) : Promise.resolve(null);
  }

  async take() {
    this.claimed = true; clearTimeout(this.idleTimer);
    const result = await Promise.race([
      Promise.all([this.facePromise, this.streamPromise]).then(([face, stream]) => ({
        face, stream: stream?.stopped ? null : stream, error: this.faceError || this.streamError || null,
      })),
      this.failure.then(error => ({ face: null, stream: null, error })),
    ]);
    if (this.disposed) return { face: null, stream: null };
    if (result.error) await this.dispose();
    return result;
  }

  async stopFace() {
    const face = this.face; this.face = null;
    try { await face?.stop(); } catch { /* A camera stop may already own cleanup. */ }
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true; clearTimeout(this.idleTimer);
    await Promise.all([this.stopFace(), this.stream?.stop()]);
  }
}
