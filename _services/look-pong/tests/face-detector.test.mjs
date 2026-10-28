import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { selectFaceCrop, createFaceTracker } from '../web/face-detector.js';

test('browser face cropping excludes other classes, low confidence and malformed detections', () => {
  const face = { class: 'face', confidence: .9, bbox: { x: 370, y: 170, width: 180, height: 200 } };
  const candidates = [
    { ...face, class: 'rick', bbox: { x: 320, y: 180, width: 600, height: 350 } },
    { ...face, confidence: .2 }, { ...face, bbox: { ...face.bbox, x: NaN } }, face,
  ];
  assert.deepEqual(selectFaceCrop(candidates, 640, 360), {
    x: 370, y: 170, width: 180, height: 200, image_width: 640, image_height: 360,
  });
  assert.equal(selectFaceCrop(candidates.slice(0, 3), 640, 360), null);
  assert.equal(selectFaceCrop([], 640, 360), null);
  assert.throws(() => selectFaceCrop('worker failure', 640, 360), /Invalid/);
});

test('face crop clamps edges and chooses the largest usable face regardless of order', () => {
  const face = { class: 'face', confidence: .9, bbox: { x: 20, y: 50, width: 150, height: 140 } };
  const smaller = { ...face, bbox: { x: 320, y: 180, width: 50, height: 50 } };
  const expected = { x: 47.5, y: 60, width: 95, height: 120, image_width: 640, image_height: 360 };
  assert.deepEqual(selectFaceCrop([smaller, face], 640, 360), expected);
  assert.deepEqual(selectFaceCrop([face, smaller], 640, 360), expected);
});

function trackerFixture() {
  let time = 0;
  const pending = [];
  const tracker = createFaceTracker(() => new Promise((resolve, reject) => pending.push({ resolve, reject })), { now: () => time });
  return { tracker, pending, canvas: { width: 640, height: 480 }, at: value => { time = value; } };
}
const face = { x: 320, y: 200, width: 180, height: 200, image_width: 640, image_height: 480 };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('the loaded browser detector exposes capture and crops fresh pixels for the gaze request', async () => {
  let time = 0, detections = 0, stops = 0;
  const draws = [];
  // Exercise the real loader and returned interface with only the external
  // worker and browser APIs stubbed, rather than testing the tracker alone.
  const source = fs.readFileSync(new URL('../web/face-detector.js', import.meta.url), 'utf8')
    .replace(/^export /gm, '')
    .replace("await import(new URL('../vendor/inference.es.js', import.meta.url).href)", '({ InferenceEngine: globalThis.InferenceEngine })');
  const context = vm.createContext({
    URLSearchParams, AbortSignal, performance: { now: () => time }, location: { host: 'localhost' },
    fetch: async () => ({ ok: true, json: async () => ({ tfjs: {} }) }),
    createImageBitmap: async () => ({ close() {} }),
    document: { createElement: () => ({
      getContext: () => ({ drawImage: (...args) => draws.push(args) }),
      toDataURL: () => 'data:image/jpeg;base64,dGVzdGltYWdl',
    }) },
    InferenceEngine: class {
      async startWorkerByModelId() { return 'face-worker'; }
      async infer() { detections++; return [{ class: 'face', confidence: .9, bbox: face }]; }
      async stopWorker() { stops++; }
    },
  });
  vm.runInContext(source, context);
  const detector = await vm.runInContext("loadBrowserFaceDetector({ model_id: 'test/1', publishable_key: 'rf_test' })", context);
  const canvas = { width: 640, height: 480 };
  assert.equal(typeof detector.capture, 'function');
  const first = await detector.capture(canvas, time);
  assert.equal(first.image, 'dGVzdGltYWdl');
  assert.deepEqual({ ...first.face_crop }, face);
  time = 125;
  const second = await detector.capture(canvas, time);
  assert.equal(second.image, first.image);
  assert.equal(detections, 1, 'a recent face box avoids blocking on another detection');
  assert.equal(draws.length, 2, 'each gaze request crops the current camera pixels');
  assert.equal(draws[1][0], canvas);
  await detector.stop();
  assert.equal(stops, 1);
  assert.equal(await detector.capture(canvas, time), null);
});

test('background localization lets fresh gaze frames use a recent box without waiting for the next detection', async () => {
  const f = trackerFixture();
  const first = f.tracker.read(f.canvas, 0);
  f.at(200); f.pending[0].resolve(face);
  assert.deepEqual(await first, face);
  f.at(250);
  assert.deepEqual(await f.tracker.read(f.canvas, 250), face);
  assert.equal(f.pending.length, 2);
  f.at(375);
  assert.deepEqual(await f.tracker.read(f.canvas, 375), face);
  assert.equal(f.pending.length, 2, 'one face inference at a time, no frame queue');
  const moved = { ...face, x: 350 };
  f.at(450); f.pending[1].resolve(moved); await flush();
  assert.deepEqual(await f.tracker.read(f.canvas, 450), moved);
  assert.equal(f.tracker.detectionMs, 200);
});

test('a missing face clears the box immediately, even before its maximum age', async () => {
  const f = trackerFixture();
  const first = f.tracker.read(f.canvas, 0); f.pending[0].resolve(face); await first;
  f.at(250); await f.tracker.read(f.canvas, 250);
  f.at(400); f.pending[1].resolve(null); await flush();
  assert.equal(await f.tracker.read(f.canvas, 400), null);
});

test('expired or very slow face detections cannot keep supplying a crop', async () => {
  const f = trackerFixture();
  const first = f.tracker.read(f.canvas, 0); f.pending[0].resolve(face); await first;
  f.at(751);
  let settled = false;
  const next = f.tracker.read(f.canvas, 751).then(value => { settled = true; return value; });
  await flush(); assert.equal(settled, false, 'an expired box must wait for localization');
  f.at(1600); f.pending[1].resolve(face);
  assert.equal(await next, null, 'a late result is aged from its capture, not its arrival');
});

test('camera dimensions invalidate old boxes and in-flight detections', async () => {
  const f = trackerFixture();
  const first = f.tracker.read(f.canvas, 0); f.pending[0].resolve(face); await first;
  f.at(250); await f.tracker.read(f.canvas, 250);
  f.canvas.height = 360;
  const resized = f.tracker.read(f.canvas, 260);
  f.pending[1].resolve(face);
  assert.equal(await resized, null);
});

test('stopping the tracker ignores late results and never starts more work', async () => {
  const f = trackerFixture(); const first = f.tracker.read(f.canvas, 0);
  f.tracker.stop(); f.pending[0].resolve(face);
  assert.equal(await first, null);
  f.at(1000); assert.equal(await f.tracker.read(f.canvas, 1000), null);
  assert.equal(f.pending.length, 1);
});

test('background detector errors invalidate the cache and surface on the next frame', async () => {
  const f = trackerFixture();
  const first = f.tracker.read(f.canvas, 0); f.pending[0].resolve(face); await first;
  f.at(250); await f.tracker.read(f.canvas, 250);
  f.pending[1].reject(new Error('Worker failed')); await flush();
  await assert.rejects(f.tracker.read(f.canvas, 300), /Worker failed/);
});
