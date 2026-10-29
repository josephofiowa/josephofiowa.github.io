// Prepare models without opening the camera. Ownership transfers to the game
// on Get Started; an unused landing-page connection expires after two minutes.
export class TrackingPreparation {
  constructor({ loadFace, createStream, onStatus = () => {}, idleMs = 120000 }) {
    this.disposed = false; this.claimed = false; this.onStatus = onStatus;
    this.streamStops = new WeakMap();
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
    this.streamPromise = createStream ? Promise.resolve().then(() => this.prepareStream(createStream)).catch(async error => {
      if (this.disposed || this.faceError) {
        try { await this.stopStream(); } catch { /* Cancellation still owns cleanup. */ }
        return null;
      }
      this.streamError = error; this.resolveFailure(error);
      try { await this.stopStream(); } catch { /* Keep the original startup diagnosis. */ }
      return null;
    }) : Promise.resolve(null);
  }

  async prepareStream(createStream) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.disposed || this.faceError) return null;
      const stream = await createStream();
      this.stream = stream;
      stream.onStatus = message => {
        this.streamStatus = message;
        if (this.faceReady && !this.disposed && !this.faceError) this.onStatus(message);
      };
      if (this.disposed || this.faceError) { await this.stopStream(stream); return null; }
      try {
        await stream.start({ prewarm: true });
      } catch (error) {
        const retry = attempt === 0 && error?.name !== 'AbortError'
          && ['ice-gathering', 'webrtc-connect'].includes(error?.code)
          && !this.disposed && !this.faceError;
        if (!retry) throw error;
        // Setup failures happen before the inference job starts. Release the
        // old publishing grant before creating one fresh session, never two
        // concurrent streams. A cleanup failure must not start another job.
        try { await this.stopStream(stream); } catch { throw error; }
        if (this.disposed || this.faceError) return null;
        this.streamStatus = 'Retrying the eye-tracking connection…';
        if (this.faceReady) this.onStatus(this.streamStatus);
        continue;
      }
      if (this.disposed || this.faceError) { await this.stopStream(stream); return null; }
      return stream;
    }
  }

  stopStream(stream = this.stream) {
    if (!stream) return Promise.resolve();
    if (!this.streamStops.has(stream)) {
      this.streamStops.set(stream, Promise.resolve().then(() => stream.stop()));
    }
    return this.streamStops.get(stream);
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
    await Promise.all([this.stopFace(), this.stopStream().catch(() => {})]);
  }
}
