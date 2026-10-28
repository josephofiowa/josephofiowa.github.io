// The published page and API use separate subdomains of josephofiowa.com.
// Include the API's host-only session cookie on every HTTP request.
export function apiUrl(path) {
  const origin = globalThis.document?.querySelector('meta[name="pong-api-origin"]')?.getAttribute?.('content');
  return origin ? new URL(path, origin).href : path;
}

export function apiFetch(path, options = {}) {
  return fetch(apiUrl(path), { ...options, credentials: 'include' });
}

export function resultsUrl(id) {
  const url = new URL(apiUrl(`/api/stream/sessions/${encodeURIComponent(id)}/results`), location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

export async function loadConfig({ request = apiFetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  // Render Free may need a minute to wake. Retry only this read-only request;
  // stream creation uses its own idempotency key and is never retried here.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await request('/api/config', { signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error('Service is starting');
      return await response.json();
    } catch {
      if (attempt === 2) throw new Error('Eye tracking could not connect. Please reload to try again.');
      await wait(2000);
    }
  }
}
