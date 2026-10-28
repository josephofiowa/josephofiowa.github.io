import test from 'node:test';
import assert from 'node:assert/strict';
import { apiUrl, apiFetch, resultsUrl, loadConfig } from '../web/api-client.js';

test('the Pages build sends API requests and sockets to its backend with cookies', async t => {
  const previous = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch };
  t.after(() => Object.assign(globalThis, previous));
  globalThis.document = { querySelector: () => ({ getAttribute: () => 'https://pong-api.josephofiowa.com' }) };
  globalThis.location = { href: 'https://josephofiowa.com/look-pong/' };
  assert.equal(apiUrl('/api/config'), 'https://pong-api.josephofiowa.com/api/config');
  assert.equal(resultsUrl('session-one'), 'wss://pong-api.josephofiowa.com/api/stream/sessions/session-one/results');
  globalThis.fetch = async (url, options) => ({ url, options });
  const result = await apiFetch('/api/calibration', { method: 'POST', body: '{}' });
  assert.equal(result.options.credentials, 'include');
  assert.equal(result.options.method, 'POST');
});

test('a sleeping backend can return a startup page before configuration is ready', async () => {
  let requests = 0, waits = 0;
  const config = await loadConfig({ request: async path => {
    assert.equal(path, '/api/config');
    if (++requests === 1) throw new Error('cold-start timeout');
    if (requests === 2) return { ok: true, json: async () => { throw new Error('HTML startup page'); } };
    return { ok: true, json: async () => ({ transport: 'cloud-streaming' }) };
  }, wait: async () => waits++ });
  assert.equal(requests, 3); assert.equal(waits, 2);
  assert.equal(config.transport, 'cloud-streaming');
});

test('startup failures are bounded and present a retry instruction', async () => {
  let requests = 0;
  await assert.rejects(loadConfig({ request: async () => { requests++; throw new Error('offline'); }, wait: async () => {} }), /reload/);
  assert.equal(requests, 3);
});
