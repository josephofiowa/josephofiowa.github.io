// Face localization runs in Roboflow's browser worker. L2CS still runs through
// the saved Workflow; a crop from this detector bypasses its Haar detector.
export function selectFaceCrop(predictions, width, height, faceClass = 'face') {
  if (!Array.isArray(predictions)) throw new Error('Invalid face detector response');
  const faces = predictions.filter(p => p.class === faceClass && p.confidence >= .5 && p.bbox &&
    ['x', 'y', 'width', 'height'].every(key => Number.isFinite(p.bbox[key])) && p.bbox.width > 0 && p.bbox.height > 0);
  faces.sort((a, b) => b.bbox.width * b.bbox.height - a.bbox.width * a.bbox.height);
  for (const { bbox } of faces) {
    const left = Math.max(0, Math.floor(bbox.x - bbox.width / 2));
    const top = Math.max(0, Math.floor(bbox.y - bbox.height / 2));
    const right = Math.min(width, Math.ceil(bbox.x + bbox.width / 2));
    const bottom = Math.min(height, Math.ceil(bbox.y + bbox.height / 2));
    if (right - left < 40 || bottom - top < 40) continue;
    return { x: (left + right) / 2, y: (top + bottom) / 2, width: right - left, height: bottom - top,
      image_width: width, image_height: height };
  }
  return null;
}

// Keep face localization off the gaze request's critical path. Only the box
// is reused: every gaze request still crops newly captured camera pixels.
export function createFaceTracker(locate, { now = () => performance.now(), refreshMs = 250, maxAgeMs = 750 } = {}) {
  let face = null, detectedAt = -Infinity, startedAt = -Infinity, pending = null;
  let dimensions = '', generation = 0, stopped = false, failure = null, detectionMs = 0;
  const fresh = () => face && now() - detectedAt <= maxAgeMs;
  return {
    get detectionMs() { return detectionMs; },
    stop() { stopped = true; generation++; face = null; },
    async read(canvas, capturedAt) {
      if (stopped) return null;
      if (failure) throw failure;
      const size = `${canvas.width}:${canvas.height}`;
      if (size !== dimensions) { dimensions = size; generation++; face = null; }
      if (!pending && now() - startedAt >= refreshMs) {
        const run = generation;
        startedAt = now();
        const began = startedAt;
        pending = (async () => {
          try {
            const next = await locate(canvas);
            if (run !== generation || stopped) return;
            detectionMs = now() - began;
            face = next; detectedAt = capturedAt;
          } catch (error) {
            if (run === generation && !stopped) { face = null; failure = error; }
          } finally { pending = null; }
        })();
      }
      if (!fresh() && pending) await pending;
      if (failure) throw failure;
      return !stopped && fresh() ? { ...face } : null;
    },
  };
}

export async function loadFaceModelMetadata(url, {
  request = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  // Retry only the read-only metadata download, before creating a worker.
  // A transient timeout must not permanently fail an otherwise healthy camera.
  for (let attempt = 0; attempt < 2; attempt++) {
    let retryable = true;
    try {
      const response = await request(url, { signal: AbortSignal.timeout(15000) });
      if (response.ok) return await response.json();
      retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    } catch (error) {
      retryable = ['TimeoutError', 'TypeError'].includes(error.name);
    }
    if (!retryable || attempt === 1) break;
    await wait(1000);
  }
  const error = new Error('Face detection could not download. Check your connection and retry eye tracking. (face-download)');
  error.code = 'face-download';
  throw error;
}

export async function loadBrowserFaceDetector(config) {
  if (!config?.model_id || !config.publishable_key?.startsWith('rf_')) return null;
  // An unfinished training has no browser artifact. Check before creating a
  // worker so it cannot hold up camera setup indefinitely while training runs.
  const apiBase = config.api_base ? new URL(config.api_base, location.origin).href : 'https://api.roboflow.com';
  const metadataUrl = `${apiBase}/tfjs/model/${config.model_id}?${new URLSearchParams({
    publishable_key: config.publishable_key, host: location.host,
  })}`;
  if (!(await loadFaceModelMetadata(metadataUrl)).tfjs) return null;
  const { InferenceEngine } = await import(new URL('../vendor/inference.es.js', import.meta.url).href);
  const engine = new InferenceEngine(apiBase);
  const worker = await engine.startWorkerByModelId(config.model_id, config.publishable_key, [{ scoreThreshold: .5, maxNumBoxes: 10 }]);
  const cropped = document.createElement('canvas');
  const locate = async canvas => {
    const width = canvas.width, height = canvas.height;
    // Freeze the pixels before the app captures another frame into this canvas.
    const bitmap = await createImageBitmap(canvas);
    try { return selectFaceCrop(await engine.infer(worker, bitmap), width, height, config.face_class || 'face'); }
    finally { bitmap.close(); }
  };
  const tracker = createFaceTracker(locate);
  const crop = (canvas, face) => {
    if (!face) return null;
    if (cropped.width !== face.width || cropped.height !== face.height) {
      cropped.width = face.width; cropped.height = face.height;
    }
    cropped.getContext('2d').drawImage(canvas, face.x - face.width / 2, face.y - face.height / 2,
      face.width, face.height, 0, 0, face.width, face.height);
    return { image: cropped.toDataURL('image/jpeg', .8).split(',')[1], face_crop: face };
  };
  return {
    modelId: config.model_id,
    async warmup() {
      const blank = document.createElement('canvas'); blank.width = 640; blank.height = 480;
      await locate(blank);
    },
    get detectionMs() { return tracker.detectionMs; },
    readFace: (canvas, capturedAt) => tracker.read(canvas, capturedAt),
    stop: () => { tracker.stop(); return engine.stopWorker(worker); },
    async detect(canvas) { return crop(canvas, await locate(canvas)); },
    async capture(canvas, capturedAt) {
      return crop(canvas, await tracker.read(canvas, capturedAt));
    },
  };
}
