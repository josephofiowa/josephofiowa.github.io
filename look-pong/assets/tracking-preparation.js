// Prepare models without opening the camera. Ownership transfers to the game
// on Get Started; an unused landing-page connection expires after two minutes.
export class TrackingPreparation {
  constructor({ loadFace, createStream, idleMs = 120000 }) {
    this.disposed = false; this.claimed = false;
    this.idleTimer = setTimeout(() => { if (!this.claimed) this.dispose(); }, idleMs);
    this.facePromise = Promise.resolve().then(loadFace).then(async face => {
      this.face = face;
      if (this.disposed) { await this.stopFace(); return null; }
      await face?.warmup?.();
      if (this.disposed) { await this.stopFace(); return null; }
      return face;
    }).catch(async () => { await this.stopFace(); return null; });
    this.streamPromise = createStream ? Promise.resolve().then(createStream).then(async stream => {
      this.stream = stream;
      if (this.disposed) { await stream.stop(); return null; }
      await stream.start({ prewarm: true });
      if (this.disposed) { await stream.stop(); return null; }
      return stream;
    }).catch(async () => { await this.stream?.stop(); return null; }) : Promise.resolve(null);
  }

  async take() {
    this.claimed = true; clearTimeout(this.idleTimer);
    const [face, stream] = await Promise.all([this.facePromise, this.streamPromise]);
    return this.disposed ? { face: null, stream: null } : { face, stream: stream?.stopped ? null : stream };
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
