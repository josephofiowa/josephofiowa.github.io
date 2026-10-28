import test from 'node:test';
import assert from 'node:assert/strict';
import { frameTag, FrameLedger, CloudGazeStream } from '../web/cloud-stream.js';

test('video tags carry the exact frame identity and face availability with a checksum', () => {
  const bits = frameTag(0x12345678, true);
  assert.equal(bits.length, 56);
  const bytes = Array.from({ length: 7 }, (_, index) => parseInt(bits.slice(index * 8, index * 8 + 8).join(''), 2));
  assert.deepEqual(bytes.slice(0, 6), [0xA5, 0x3C, 0x12, 0x34, 0x56, 0x78]);
  assert.notDeepEqual(frameTag(0x12345678, false), bits);
  assert.notDeepEqual(frameTag(0x12345679, true), bits);
});

test('results retain the target and capture time from their source frame across calibration transitions', () => {
  let now = 100;
  const ledger = new FrameLedger({ now: () => now });
  const before = ledger.record({ captured_at: now, token: 'dot-one', run: 1 });
  now = 200;
  const after = ledger.record({ captured_at: now, token: 'dot-two', run: 1 });
  now = 250;
  assert.equal(ledger.accept(before).token, 'dot-one');
  assert.deepEqual(ledger.accept(after), { captured_at: 200, token: 'dot-two', run: 1 });
});

test('late, duplicated, out-of-order and unknown cloud frames cannot control the paddle', () => {
  let now = 100;
  const ledger = new FrameLedger({ now: () => now });
  const first = ledger.record({ captured_at: now });
  now = 200;
  const second = ledger.record({ captured_at: now });
  assert.ok(ledger.accept(second));
  assert.equal(ledger.accept(first), null);
  assert.equal(ledger.accept(second), null);
  assert.equal(ledger.accept(1000), null);
  const third = ledger.record({ captured_at: now });
  now = 1001;
  assert.equal(ledger.accept(third), null);
});

test('the pending-frame ledger stays bounded when results never arrive', () => {
  let now = 0;
  const ledger = new FrameLedger({ now: () => now });
  for (let index = 0; index < 10000; index++) {
    now += 67;
    ledger.record({ captured_at: now });
  }
  assert.ok(ledger.frames.size <= 12);
});

test('synthetic warmup results never enter calibration and camera attachment waits for fresh gaze', async t => {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
  t.after(() => { globalThis.document = previous; });
  let predictions = 0, ready = false;
  const stream = new CloudGazeStream({ onPrediction: () => predictions++ });
  stream.running = true; stream.prewarming = true;
  stream.ready.then(() => { ready = true; });
  const deliver = metadata => {
    const sequence = stream.ledger.record({ captured_at: performance.now(), ...metadata });
    stream.receive({ data: JSON.stringify({ type: 'prediction', prediction: {
      frame_sequence: sequence, gazes: [{ yaw: .1, pitch: .2 }], model_ms: 5,
    } }) });
  };
  for (let i = 0; i < 4; i++) deliver({ warmup: true });
  await stream.prepared;
  assert.equal(predictions, 0); assert.equal(ready, false); assert.equal(stream.streak, 0);
  const preparedSequence = stream.ledger.sequence;
  const attached = stream.attachCamera({ video: {}, detector: { readFace() {} }, context: () => ({}),
    onPrediction: () => predictions++, onStatus() {}, onError() {} });
  const face = { x: 200, y: 200, width: 100, height: 100, image_width: 640, image_height: 480 };
  deliver({ face_crop: face, token: 'dot-1' });
  deliver({ face_crop: face, token: 'dot-1' });
  await Promise.resolve();
  assert.equal(ready, false);
  deliver({ face_crop: face, token: 'dot-1' });
  await attached;
  assert.equal(ready, true); assert.equal(predictions, 3);
  assert.ok(stream.ledger.sequence > preparedSequence);
  assert.equal(stream.prewarming, false);
});

for (const stopDuringDetection of [false, true]) test(`a pending face detection cannot publish after ${stopDuringDetection ? 'session shutdown' : 'game over'}`, async t => {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage() {}, fillRect() {} }) }) };
  t.after(() => { globalThis.document = previous; });
  let fresh = true, resolveFace, published = 0;
  const stream = new CloudGazeStream({ video: { currentTime: 1, videoWidth: 640, videoHeight: 480 },
    context: () => ({ fresh, captured_at: performance.now() }),
    detector: { readFace: () => new Promise(resolve => { resolveFace = resolve; }) } });
  stream.track = { requestFrame: () => published++ };
  const loop = stream.publishFrames();
  fresh = false;
  if (stopDuringDetection) await stream.stop();
  resolveFace({ x: 320, y: 240, width: 180, height: 180 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(published, 0);
  assert.equal(stream.ledger.frames.size, 0);
  await stream.stop(); await loop;
});

test('stopping a stream closes every transport, cancels scheduled work, and requests remote teardown once', async t => {
  const previousDocument = globalThis.document, previousFetch = globalThis.fetch;
  globalThis.document = { querySelector: () => null, createElement: () => ({ getContext: () => ({}) }) };
  t.after(() => { globalThis.document = previousDocument; globalThis.fetch = previousFetch; });
  const calls = [];
  let finishStop;
  globalThis.fetch = (url, options) => {
    calls.push({ url, options });
    return new Promise(resolve => { finishStop = resolve; });
  };
  const stream = new CloudGazeStream(); stream.id = 'session-to-release';
  stream.pc = { close: () => calls.push('peer-close') };
  stream.ws = { close: () => calls.push('socket-close') };
  stream.media = { getTracks: () => [{ stop: () => calls.push('video-stop') }] };
  for (const timer of ['frameTimer', 'statusTimer', 'warmupTimer', 'disconnectTimer', 'heartbeat']) {
    stream[timer] = setTimeout(() => calls.push(`unexpected-${timer}`), 10);
  }
  const stopped = stream.stop(), stoppedAgain = stream.stop();
  await stream.closed;
  assert.equal(stream.stopped, true);
  assert.equal(stream.abort.signal.aborted, true);
  assert.deepEqual(calls.slice(0, 3), ['peer-close', 'socket-close', 'video-stop']);
  assert.equal(calls[3].url, '/api/stream/sessions/session-to-release/stop');
  assert.equal(calls[3].options.method, 'POST');
  assert.equal(calls[3].options.keepalive, true);
  assert.equal(calls[3].options.credentials, 'include');
  let released = false; stopped.then(() => { released = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls.length, 4, 'no timers or repeated stop calls should publish or reconnect');
  assert.equal(released, false, 'the next connection must wait until remote teardown completes');
  finishStop({ ok: true }); await Promise.all([stopped, stoppedAgain]);
  assert.equal(released, true);
});
