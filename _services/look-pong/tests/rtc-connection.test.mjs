import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionDiagnostics, waitForIceGathering, waitForPeerConnection } from '../web/rtc-connection.js';

const HOST_SDP = 'v=0\r\na=ice-pwd:private-password\r\na=candidate:1 1 udp 2122260223 192.0.2.10 51432 typ host\r\n';

class TrackedTarget extends EventTarget {
  listeners = new Map();
  addEventListener(name, handler, options) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(handler);
    super.addEventListener(name, handler, options);
  }
  removeEventListener(name, handler, options) {
    this.listeners.get(name)?.delete(handler);
    super.removeEventListener(name, handler, options);
  }
  get listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}

class FakePeer extends TrackedTarget {
  connectionState = 'new';
  iceConnectionState = 'new';
  iceGatheringState = 'gathering';
  localDescription = { sdp: HOST_SDP };
  change(values, event) { Object.assign(this, values); this.dispatchEvent(new Event(event)); }
}

class FakeSignal extends TrackedTarget {
  aborted = false;
  abort() { this.aborted = true; this.dispatchEvent(new Event('abort')); }
}

test('blocked STUN does not prevent trying the host candidates already gathered', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const peer = new FakePeer(), signal = new FakeSignal();
  let done = false;
  const waiting = waitForIceGathering(peer, { signal }).then(result => { done = true; return result; });
  t.mock.timers.tick(2499);
  await Promise.resolve();
  assert.equal(done, false);
  t.mock.timers.tick(1);
  const result = await waiting;
  assert.equal(result.complete, false);
  assert.equal(result.candidates.total, 1);
  assert.equal(result.candidates.host, 1);
  assert.equal(result.iceGatheringState, 'gathering');
  assert.equal(peer.listenerCount, 0);
  assert.equal(signal.listenerCount, 0);
});

test('ICE gathering resolves immediately when already complete with candidates', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const peer = new FakePeer(), signal = new FakeSignal();
  peer.iceGatheringState = 'complete';
  const result = await waitForIceGathering(peer, { signal });
  assert.equal(result.complete, true);
  assert.equal(peer.listenerCount, 0);
  assert.equal(signal.listenerCount, 0);
  signal.abort();
  t.mock.timers.tick(3000);
});

test('ICE gathering resolves on completion and removes all listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const peer = new FakePeer(), signal = new FakeSignal();
  const waiting = waitForIceGathering(peer, { signal });
  peer.change({ iceGatheringState: 'complete' }, 'icegatheringstatechange');
  assert.equal((await waiting).complete, true);
  assert.equal(peer.listenerCount, 0);
  assert.equal(signal.listenerCount, 0);
  t.mock.timers.tick(3000);
});

for (const mode of ['deadline', 'already complete', 'later complete']) {
  test(`ICE gathering fails without candidates: ${mode}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const peer = new FakePeer(), signal = new FakeSignal();
    peer.localDescription = { sdp: 'v=0\r\na=ice-pwd:not-for-diagnostics\r\na=candidate:incomplete\r\n' };
    if (mode === 'already complete') peer.iceGatheringState = 'complete';
    const waiting = waitForIceGathering(peer, { signal });
    const rejected = assert.rejects(waiting, error => {
      assert.equal(error.code, 'ice-gathering');
      assert.equal(error.diagnostics.candidates.total, 0);
      assert.doesNotMatch(JSON.stringify(error), /not-for-diagnostics/);
      return true;
    });
    if (mode === 'deadline') t.mock.timers.tick(2500);
    if (mode === 'later complete') peer.change({ iceGatheringState: 'complete' }, 'icegatheringstatechange');
    await rejected;
    assert.equal(peer.listenerCount, 0);
    assert.equal(signal.listenerCount, 0);
  });
}

test('connection diagnostics expose only whitelisted states and candidate counts', () => {
  const peer = new FakePeer();
  peer.localDescription.sdp += 'a=candidate:2 1 TCP 1 198.51.100.1 443 typ relay raddr 192.0.2.10 rport 1234\r\n'
    + 'a=candidate:3 1 udp 1 203.0.113.1 1234 typ srflx\r\n';
  peer.connectionState = 'https://secret.invalid/token';
  const result = connectionDiagnostics(peer);
  assert.deepEqual(result, {
    connectionState: 'unknown', iceConnectionState: 'new', iceGatheringState: 'gathering',
    candidates: { total: 3, host: 1, srflx: 1, prflx: 0, relay: 1, otherType: 0, udp: 2, tcp: 1, otherProtocol: 0 },
  });
  assert.doesNotMatch(JSON.stringify(result), /192\.0|198\.51|203\.0|password|secret|token/);
});

for (const [name, wait, code] of [
  ['gathering', waitForIceGathering, 'ice-gathering'],
  ['connection', waitForPeerConnection, 'webrtc-connect'],
]) {
  for (const state of ['failed', 'closed']) {
    for (const timing of ['already', 'later']) {
      test(`${name} rejects ${timing} ${state} peer and cleans up`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const peer = new FakePeer(), signal = new FakeSignal();
        if (timing === 'already') peer.connectionState = state;
        const waiting = wait(peer, { signal });
        const rejected = assert.rejects(waiting, error => error.code === code);
        if (timing === 'later') peer.change({ connectionState: state }, 'connectionstatechange');
        await rejected;
        assert.equal(peer.listenerCount, 0);
        assert.equal(signal.listenerCount, 0);
        t.mock.timers.tick(60000);
      });
    }
  }

  for (const timing of ['already', 'later']) {
    test(`${name} handles ${timing} abort and cleans up`, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const peer = new FakePeer(), signal = new FakeSignal();
      if (timing === 'already') signal.abort();
      const waiting = wait(peer, { signal });
      const rejected = assert.rejects(waiting, error => error.name === 'AbortError' && error.code === code);
      if (timing === 'later') signal.abort();
      await rejected;
      assert.equal(peer.listenerCount, 0);
      assert.equal(signal.listenerCount, 0);
      t.mock.timers.tick(60000);
    });
  }

  test(`${name} rejects ICE failure before aggregate connection state updates`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const peer = new FakePeer();
    const waiting = wait(peer);
    const rejected = assert.rejects(waiting, error => error.code === code);
    peer.change({ iceConnectionState: 'failed' }, 'iceconnectionstatechange');
    await rejected;
    assert.equal(peer.listenerCount, 0);
  });
}

for (const timing of ['already', 'later']) {
  test(`peer connection resolves when ${timing} connected`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const peer = new FakePeer(), signal = new FakeSignal();
    if (timing === 'already') peer.connectionState = 'connected';
    const waiting = waitForPeerConnection(peer, { signal });
    if (timing === 'later') peer.change({ connectionState: 'connected' }, 'connectionstatechange');
    assert.equal((await waiting).connectionState, 'connected');
    assert.equal(peer.listenerCount, 0);
    assert.equal(signal.listenerCount, 0);
    t.mock.timers.tick(60000);
  });
}

test('connection deadline reports its own stage and safe diagnostics', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const peer = new FakePeer(), signal = new FakeSignal();
  const waiting = waitForPeerConnection(peer, { signal });
  const rejected = assert.rejects(waiting, error => {
    assert.equal(error.code, 'webrtc-connect');
    assert.equal(error.diagnostics.candidates.host, 1);
    assert.doesNotMatch(error.message + JSON.stringify(error), /192\.0|private-password|a=candidate/);
    return true;
  });
  t.mock.timers.tick(30000);
  await rejected;
  assert.equal(peer.listenerCount, 0);
  assert.equal(signal.listenerCount, 0);
});
