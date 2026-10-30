import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackingPreparation } from '../web/tracking-preparation.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('page preparation loads both models immediately and hands over the same resources', async t => {
  const calls = [];
  const face = { warmup: async () => calls.push('face-warm'), stop: async () => calls.push('face-stop') };
  const stream = { start: async options => calls.push(options), stop: async () => calls.push('stream-stop') };
  const prepared = new TrackingPreparation({ loadFace: async () => { calls.push('face-load'); return face; },
    createStream: async () => { calls.push('stream-create'); return stream; } });
  t.after(() => prepared.dispose());
  await tick();
  assert.deepEqual(calls.slice(0, 2), ['face-load', 'stream-create']);
  assert.ok(calls.includes('face-warm'));
  assert.deepEqual(calls.find(call => typeof call === 'object'), { prewarm: true });
  assert.deepEqual(await prepared.take(), { face, stream, error: null });
  assert.equal(calls.filter(c => c === 'stream-create').length, 1);
  await prepared.dispose();
  assert.ok(calls.includes('face-stop') && calls.includes('stream-stop'));
});

test('closing the page during loading stops late resources before they can start', async () => {
  const faceLoad = deferred(), streamLoad = deferred(), calls = [];
  const prepared = new TrackingPreparation({ loadFace: () => faceLoad.promise, createStream: () => streamLoad.promise });
  await tick();
  await prepared.dispose();
  faceLoad.resolve({ stop: async () => calls.push('face-stop'), warmup: () => calls.push('should-not-warm') });
  streamLoad.resolve({ stop: async () => calls.push('stream-stop'), start: () => calls.push('should-not-start') });
  assert.deepEqual(await prepared.take(), { face: null, stream: null });
  assert.deepEqual(calls.sort(), ['face-stop', 'stream-stop']);
});

test('an unused preparation expires, while Get Started keeps its connection', async () => {
  const calls = [];
  const create = id => new TrackingPreparation({ idleMs: 10, loadFace: async () => null,
    createStream: async () => ({ start: async () => {}, stop: async () => calls.push(id) }) });
  const idle = create('idle'), claimed = create('claimed');
  await claimed.take();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(idle.disposed, true);
  assert.equal(claimed.disposed, false);
  assert.deepEqual(calls, ['idle']);
  await claimed.dispose();
});

test('a failed warmup is reported instead of silently starting another connection', async () => {
  let stopped = false;
  const prepared = new TrackingPreparation({ loadFace: async () => ({ stop: async () => {} }),
    createStream: async () => ({ start: async () => { throw Error('offline'); }, stop: async () => { stopped = true; } }) });
  const result = await prepared.take();
  assert.equal(result.face, null); assert.equal(result.stream, null); assert.equal(stopped, true);
  assert.equal(result.error.message, 'offline');
  await prepared.dispose();
});

test('face-model failure is returned even when cloud warmup is still pending', async () => {
  const warmup = deferred(); let stopped = false;
  const prepared = new TrackingPreparation({ loadFace: async () => { throw Error('WebGL failed'); },
    createStream: async () => ({ start: () => warmup.promise, stop: async () => { stopped = true; } }) });
  const result = await prepared.take();
  assert.match(result.error.message, /face-model/);
  assert.equal(stopped, true);
  warmup.resolve(); await tick();
  assert.equal(prepared.disposed, true);
});

test('connection failure stops a face model that finishes loading after the error', async () => {
  const faceLoad = deferred(); let stops = 0;
  const prepared = new TrackingPreparation({ loadFace: () => faceLoad.promise,
    createStream: async () => ({ start: async () => { throw Error('connection timed out'); }, stop: async () => {} }) });
  const result = await prepared.take();
  assert.match(result.error.message, /connection timed out/);
  faceLoad.resolve({ stop: async () => stops++, warmup: () => assert.fail('must not warm after failure') });
  await tick();
  assert.equal(stops, 1);
});

test('download failure retains its specific diagnosis and releases the cloud connection', async () => {
  const download = Object.assign(new Error('Face detection could not download. (face-download)'), { code: 'face-download' });
  let stopped = false;
  const prepared = new TrackingPreparation({ loadFace: async () => { throw download; },
    createStream: async () => ({ start: async () => {}, stop: async () => { stopped = true; } }) });
  assert.equal((await prepared.take()).error, download);
  assert.equal(stopped, true);
});

test('startup reports the face-model stage before forwarding the connection stage', async () => {
  const warmup = deferred(), statuses = [];
  const stream = { async start() { this.onStatus('Starting the eye-tracking model…'); }, stop: async () => {} };
  const prepared = new TrackingPreparation({ onStatus: message => statuses.push(message),
    loadFace: async () => ({ warmup: () => warmup.promise, stop: async () => {} }), createStream: async () => stream });
  await tick();
  assert.deepEqual(statuses, ['Loading face detection…', 'Preparing face detection…']);
  warmup.resolve(); await prepared.take();
  assert.equal(statuses.at(-1), 'Starting the eye-tracking model…');
  await prepared.dispose();
});

const transportError = (message = 'Connection setup failed', code = 'webrtc-connect') =>
  Object.assign(new Error(message), { code });

for (const code of ['ice-gathering', 'webrtc-connect']) {
  test(`${code} retries once after cleanup and keeps the same warmed face worker`, async () => {
    const cleanup = deferred(), calls = [];
    let faceLoads = 0, faceWarms = 0, faceStops = 0, creates = 0, liveStreams = 0, maxLiveStreams = 0, jobs = 0;
    const face = { warmup: async () => faceWarms++, stop: async () => faceStops++ };
    const oldStream = { start: async () => { calls.push('old-start'); liveStreams++; maxLiveStreams = Math.max(maxLiveStreams, liveStreams); throw transportError('first failure', code); },
      stop: async () => { calls.push('old-stop-begin'); await cleanup.promise; liveStreams--; calls.push('old-stop-end'); } };
    const newStream = { start: async () => { calls.push('new-start'); liveStreams++; maxLiveStreams = Math.max(maxLiveStreams, liveStreams); jobs++; },
      stop: async () => { liveStreams--; calls.push('new-stop'); } };
    const prepared = new TrackingPreparation({ loadFace: async () => { faceLoads++; return face; },
      createStream: async () => { creates++; return creates === 1 ? oldStream : newStream; } });
    const taking = prepared.take();
    await tick();
    assert.equal(creates, 1, 'must not create a replacement while release is pending');
    assert.equal(faceStops, 0);
    cleanup.resolve();
    assert.deepEqual(await taking, { face, stream: newStream, error: null });
    assert.equal(creates, 2);
    assert.equal(faceLoads, 1); assert.equal(faceWarms, 1); assert.equal(faceStops, 0);
    assert.deepEqual(calls, ['old-start', 'old-stop-begin', 'old-stop-end', 'new-start']);
    assert.equal(maxLiveStreams, 1);
    assert.equal(jobs, 1, 'transport retry must not duplicate an inference job');
    await prepared.dispose();
    assert.equal(liveStreams, 0);
  });
}

test('a second transport failure is final and preserves its diagnosis', async () => {
  let creates = 0, stops = 0;
  const first = transportError('first failure'), last = transportError('second failure');
  const prepared = new TrackingPreparation({ loadFace: async () => ({ stop: async () => {} }),
    createStream: async () => { const error = ++creates === 1 ? first : last;
      return { start: async () => { throw error; }, stop: async () => stops++ }; } });
  const result = await prepared.take();
  assert.equal(result.error, last);
  assert.equal(creates, 2); assert.equal(stops, 2);
  await tick();
  assert.equal(creates, 2, 'no unbounded retry loop after final failure');
});

test('disposal during failed-session cleanup prevents a replacement', async () => {
  const cleanup = deferred(); let creates = 0, stops = 0;
  const prepared = new TrackingPreparation({ loadFace: async () => ({ stop: async () => {} }),
    createStream: async () => { creates++; return { start: async () => { throw transportError(); },
      stop: async () => { stops++; await cleanup.promise; } }; } });
  const taking = prepared.take();
  await tick();
  const disposing = prepared.dispose();
  cleanup.resolve(); await disposing;
  assert.deepEqual(await taking, { face: null, stream: null });
  assert.equal(creates, 1); assert.equal(stops, 1);
});

test('face failure during failed-session cleanup prevents a replacement', async () => {
  const cleanup = deferred(), faceWarm = deferred(); let creates = 0;
  const prepared = new TrackingPreparation({ loadFace: async () => ({
    warmup: async () => { await faceWarm.promise; throw Error('WebGL stopped'); }, stop: async () => {},
  }), createStream: async () => { creates++; return { start: async () => { throw transportError(); }, stop: () => cleanup.promise }; } });
  const taking = prepared.take();
  await tick(); faceWarm.resolve(); await tick();
  assert.ok(prepared.faceError);
  cleanup.resolve();
  assert.match((await taking).error.message, /face-model/);
  assert.equal(creates, 1);
});

test('failed cleanup preserves the transport error and prevents a replacement', async () => {
  let creates = 0;
  const original = transportError('original transport failure');
  const prepared = new TrackingPreparation({ loadFace: async () => ({ stop: async () => {} }),
    createStream: async () => { creates++; return { start: async () => { throw original; },
      stop: async () => { throw Error('cleanup failed'); } }; } });
  assert.equal((await prepared.take()).error, original);
  assert.equal(creates, 1);
});

for (const error of [new Error('HTTP 503'), new Error('model warmup timed out'),
  Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'webrtc-connect' }),
  Object.assign(new Error('Face failed'), { code: 'face-model' })]) {
  test(`${error.message} never triggers an automatic connection retry`, async () => {
    let creates = 0;
    const prepared = new TrackingPreparation({ loadFace: async () => ({ stop: async () => {} }),
      createStream: async () => { creates++; return { start: async () => { throw error; }, stop: async () => {} }; } });
    assert.equal((await prepared.take()).error, error);
    assert.equal(creates, 1);
  });
}

test('disposing before scheduled setup prevents creating a late stream', async () => {
  let creates = 0;
  const prepared = new TrackingPreparation({ loadFace: async () => null,
    createStream: async () => { creates++; return { start: async () => {}, stop: async () => {} }; } });
  await prepared.dispose();
  await prepared.streamPromise;
  assert.equal(creates, 0);
});

test('disposal while the retry factory is pending stops its late stream before startup', async () => {
  const replacement = deferred(); let creates = 0, replacementStarts = 0, replacementStops = 0;
  const prepared = new TrackingPreparation({ loadFace: async () => ({ stop: async () => {} }),
    createStream: async () => ++creates === 1
      ? { start: async () => { throw transportError(); }, stop: async () => {} }
      : replacement.promise });
  const taking = prepared.take();
  await tick(); assert.equal(creates, 2);
  await prepared.dispose();
  replacement.resolve({ start: async () => replacementStarts++, stop: async () => replacementStops++ });
  await taking;
  assert.equal(replacementStarts, 0); assert.equal(replacementStops, 1);
});
