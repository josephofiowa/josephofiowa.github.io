// Give WHIP negotiation a chance even while local discovery is still pending.
// Candidate counts describe discovery; only the connected peer state proves
// readiness. Diagnostics never contain SDP, addresses or credentials.
const CONNECTION_STATES = new Set(['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']);
const ICE_STATES = new Set(['new', 'checking', 'connected', 'completed', 'disconnected', 'failed', 'closed']);
const GATHERING_STATES = new Set(['new', 'gathering', 'complete']);

export function connectionDiagnostics(peer) {
  const candidates = { total: 0, host: 0, srflx: 0, prflx: 0, relay: 0, otherType: 0,
    udp: 0, tcp: 0, otherProtocol: 0 };
  for (const line of (peer.localDescription?.sdp || '').split(/\r?\n/)) {
    if (!/^a=candidate:/i.test(line)) continue;
    const fields = line.trim().split(/\s+/);
    const typeIndex = fields.findIndex(field => field.toLowerCase() === 'typ');
    // Ignore incomplete candidate lines rather than treating them as routes.
    if (fields.length < 8 || typeIndex < 6 || !fields[typeIndex + 1]) continue;
    candidates.total++;
    const type = fields[typeIndex + 1].toLowerCase();
    candidates[['host', 'srflx', 'prflx', 'relay'].includes(type) ? type : 'otherType']++;
    const protocol = fields[2].toLowerCase();
    candidates[['udp', 'tcp'].includes(protocol) ? protocol : 'otherProtocol']++;
  }
  return {
    connectionState: CONNECTION_STATES.has(peer.connectionState) ? peer.connectionState : 'unknown',
    iceConnectionState: ICE_STATES.has(peer.iceConnectionState) ? peer.iceConnectionState : 'unknown',
    iceGatheringState: GATHERING_STATES.has(peer.iceGatheringState) ? peer.iceGatheringState : 'unknown',
    candidates,
  };
}

function connectionError(peer, code, message, aborted = false) {
  const error = new Error(`${message} (${code})`);
  error.name = aborted ? 'AbortError' : 'Error';
  error.code = code;
  error.diagnostics = connectionDiagnostics(peer);
  return error;
}

function isTerminal(peer) {
  return ['failed', 'closed'].includes(peer.connectionState)
    || ['failed', 'closed'].includes(peer.iceConnectionState);
}

function waitForState(peer, { signal, timeoutMs, code, events, check, timeoutMessage }) {
  return new Promise((resolve, reject) => {
    let finished = false, timer;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const event of events) peer.removeEventListener(event, changed);
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve(result);
    };
    const aborted = () => finish(connectionError(peer, code, 'Eye-tracking connection was stopped.', true));
    const evaluate = deadline => {
      if (signal?.aborted) return aborted();
      if (isTerminal(peer)) {
        return finish(connectionError(peer, code, 'The video connection ended before it was ready. Retry eye tracking.'));
      }
      let result;
      try { result = check(deadline); }
      catch (error) { return finish(error); }
      if (result) return finish(null, result);
      if (deadline) finish(connectionError(peer, code, timeoutMessage));
    };
    const changed = () => evaluate(false);
    for (const event of events) peer.addEventListener(event, changed);
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => evaluate(true), timeoutMs);
    evaluate(false);
  });
}

export function waitForIceGathering(peer, { signal, timeoutMs = 1000 } = {}) {
  const code = 'ice-gathering';
  return waitForState(peer, {
    signal, timeoutMs, code,
    events: ['icegatheringstatechange', 'icecandidate', 'connectionstatechange', 'iceconnectionstatechange'],
    check: deadline => {
      const complete = peer.iceGatheringState === 'complete';
      if (!complete && !deadline) return null;
      // Roboflow can answer an offer with no listed candidates and establish
      // a route. Leave success/failure to the connection deadline, rather
      // than failing before the offer/answer exchange can happen.
      return { complete, ...connectionDiagnostics(peer) };
    },
  });
}

export function waitForPeerConnection(peer, { signal, timeoutMs = 30000 } = {}) {
  return waitForState(peer, {
    signal, timeoutMs, code: 'webrtc-connect',
    events: ['connectionstatechange', 'iceconnectionstatechange'],
    timeoutMessage: 'The video connection did not open. Retry eye tracking; your network may be blocking the connection.',
    check: () => peer.connectionState === 'connected' ? connectionDiagnostics(peer) : null,
  });
}
