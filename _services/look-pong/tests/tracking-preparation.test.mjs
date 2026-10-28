import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackingPreparation } from '../web/tracking-preparation.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('page preparation loads both models immediately and hands over the same resources', async () => {
  const calls = [];
  const face = { warmup: async () => calls.push('face-warm'), stop: async () => calls.push('face-stop') };
  const stream = { start: async options => calls.push(options), stop: async () => calls.push('stream-stop') };
  const prepared = new TrackingPreparation({ loadFace: async () => { calls.push('face-load'); return face; },
    createStream: async () => { calls.push('stream-create'); return stream; } });
  await tick();
  assert.deepEqual(calls, ['face-load', 'stream-create', 'face-warm', { prewarm: true }]);
  assert.deepEqual(await prepared.take(), { face, stream });
  assert.equal(calls.filter(c => c === 'stream-create').length, 1);
  await prepared.dispose();
  assert.ok(calls.includes('face-stop') && calls.includes('stream-stop'));
});

test('closing the page during loading stops late resources before they can start', async () => {
  const faceLoad = deferred(), streamLoad = deferred(), calls = [];
  const prepared = new TrackingPreparation({ loadFace: () => faceLoad.promise, createStream: () => streamLoad.promise });
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

test('a failed warmup cleans up and permits a fresh connection at camera start', async () => {
  let stops = 0;
  const prepared = new TrackingPreparation({ loadFace: async () => ({ stop: async () => {} }),
    createStream: async () => ({ start: async () => { throw Error('offline'); }, stop: async () => { stops++; } }) });
  const result = await prepared.take();
  assert.ok(result.face); assert.equal(result.stream, null); assert.equal(stops, 1);
  await prepared.dispose();
});
