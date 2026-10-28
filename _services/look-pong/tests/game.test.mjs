import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as engine from '../web/engine.js';

test('personal calibration recovers independent horizontal and vertical eye control', () => {
  const points = [];
  for (const x of [.12, .5, .88]) for (const y of [.14, .5, .86]) {
    points.push({ target: [x, y], angles: [.5 * x + .08 * y - .2, -.07 * x + .4 * y - .1] });
  }
  const model = engine.fitCalibration(points);
  for (const [x, y] of [[.3, .3], [.7, .7], [.7, .3], [.3, .7]]) {
    const mapped = engine.mapGaze(model, .5 * x + .08 * y - .2, -.07 * x + .4 * y - .1);
    assert.ok(Math.hypot(mapped[0] - x, mapped[1] - y) < .01);
  }
});

test('calibration rejects angles that never change across targets', () => {
  assert.throws(() => engine.fitCalibration(Array.from({ length: 9 }, () => ({ target: [.5, .5], angles: [.1, .2] }))), /eye movement/);
});

test('calibration aggregation ignores a blink or gross outlier', () => {
  const result = engine.aggregateAngles([[.1, .2], [.101, .201], [.099, .199], [.1, .2], [1.5, -2]]);
  assert.ok(Math.abs(result[0] - .1) < .002 && Math.abs(result[1] - .2) < .002);
});

test('the largest valid face supplies player gaze regardless of detection order', () => {
  const player = { yaw: .1, pitch: .2, face: { x: 320, y: 230, width: 180, height: 200 } };
  const extra = { yaw: -.6, pitch: -.7, face: { x: 100, y: 350, width: 40, height: 40 } };
  const invalid = { yaw: NaN, pitch: .2, face: { x: 320, y: 230, width: 600, height: 400 } };
  assert.equal(engine.selectPlayerGaze([extra, player, invalid]), player);
  assert.equal(engine.selectPlayerGaze([player, extra]), player);
  assert.equal(engine.selectPlayerGaze([invalid]), null);
  assert.equal(engine.selectPlayerGaze(null), null);
});

test('gaze containment uses the visible circular radius in viewport pixels', () => {
  const model = { mean: [0, 0], scale: [1, 1], x: [0, 1, 0], y: [0, 0, 1] };
  const inside = (x, y, target = [.5, .5]) => engine.gazeInsideTarget(model, x, y, target, [1280, 850], 32);
  assert.equal(inside(.5 + 31 / 1280, .5), true);
  assert.equal(inside(.5, .5 + 31 / 850), true);
  assert.equal(inside(.5 + 33 / 1280, .5), false);
  assert.equal(inside(.5 + 24 / 1280, .5 + 24 / 850), false);
  assert.equal(inside(1.03, .5, [1, .5]), false); // No edge clipping.
  assert.equal(inside(NaN, .5), false);
  assert.equal(engine.gazeInsideTarget(null, .5, .5, [.5, .5], [1280, 850], 32), false);
});

test('small posture changes are tolerated, large position and distance changes are flagged', () => {
  const baseline = { x: .5, y: .5, width: .3 };
  assert.equal(engine.postureChanged({ x: .52, y: .51, width: .31 }, baseline), false);
  assert.equal(engine.postureChanged({ x: .7, y: .5, width: .3 }, baseline), true);
  assert.equal(engine.postureChanged({ x: .5, y: .5, width: .45 }, baseline), true);
});

test('a new round floats slowly away from the player toward the CPU', () => {
  const game = new engine.PongGame();
  assert.ok(game.ball.vz > 0 && game.speed < 1);
  const start = game.ball.z; game.running = true; game.update(.5);
  assert.ok(game.ball.z > start);
  assert.equal(game.hits, 0);
});

test('a successful return reverses depth and increases volley speed', () => {
  const game = new engine.PongGame(); game.running = true;
  game.ball = { x: 0, y: 0, z: .17, vx: 0, vy: 0, vz: -2 };
  const before = game.speed;
  game.update(.03);
  assert.equal(game.hits, 1);
  assert.ok(game.ball.vz > 0 && game.speed > before);
});

test('the score counts player returns once and excludes CPU hits, walls, serves, and misses', () => {
  let result;
  const game = new engine.PongGame(value => { result = value; });
  game.running = true;
  assert.equal(game.playerReturns, 0);
  game.ball = { x: 0, y: 0, z: 5.14, vx: 0, vy: 0, vz: 2 };
  game.update(.02); // CPU return.
  assert.equal(game.hits, 1);
  assert.equal(game.playerReturns, 0);
  game.ball = { x: 0, y: 0, z: .16, vx: 0, vy: 0, vz: -2 };
  game.update(.02); // Player return.
  assert.equal(game.playerReturns, 1);
  game.update(.02); // The ball has left the paddle; don't count twice.
  assert.equal(game.playerReturns, 1);
  game.ball = { x: .95, y: .1, z: 2, vx: 2, vy: 0, vz: .1 };
  game.update(.02); // Wall bounce.
  assert.ok(game.ball.vx < 0);
  assert.equal(game.playerReturns, 1);
  game.ball = { x: .9, y: .6, z: 5.14, vx: 0, vy: 0, vz: 2 };
  game.cpu.x = 0; game.cpu.y = 0;
  game.update(.02); // CPU miss and re-serve.
  assert.equal(game.points, 1);
  assert.equal(game.playerReturns, 1);
  game.ball = { x: .9, y: .6, z: .16, vx: 0, vy: 0, vz: -2 };
  game.update(.02); // Player miss.
  assert.equal(result.playerReturns, 1);
  assert.equal(result.hits, 2);
  game.update(.02);
  assert.equal(game.playerReturns, 1);
  game.reset();
  assert.equal(game.playerReturns, 0);
});

test('speed adds 0.1x, 0.2x, and 0.4x across the first three five-return groups', () => {
  const game = new engine.PongGame();
  const multipliers = [1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 1.9, 2.1, 2.3, 2.5, 2.9, 3.3, 3.7, 4.1, 4.5, 5.3, 6.1, 6.9];
  for (const [index, expected] of multipliers.entries()) {
    game.bounce(index % 2 === 0);
    assert.ok(Math.abs(game.speed / game.initialSpeed - expected) < 1e-10, `return ${index + 1}`);
    assert.ok(Math.abs(Math.hypot(game.ball.vx, game.ball.vy, game.ball.vz) - game.speed) < 1e-10);
  }
  for (let i = 0; i < 20; i++) game.bounce(i % 2 === 0);
  assert.equal(game.speed, 6.8);
  game.reset(); game.bounce(true);
  assert.ok(Math.abs(game.speed / game.initialSpeed - 1.1) < 1e-10);
});

test('CPU returns favor all four reachable edges while retaining center shots and speed', () => {
  let seed = 0xA11CE;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const game = new engine.PongGame(() => {}, random);
  const edges = [0, 0, 0, 0];
  let center = 0;
  for (let i = 0; i < 1000; i++) {
    game.ball = { x: Math.sin(i) * .9, y: Math.cos(i) * .6, z: 5.15, vx: 0, vy: 0, vz: game.speed };
    game.bounce(true);
    const b = game.ball, time = (.15 - b.z) / b.vz;
    const x = b.x + b.vx * time, y = b.y + b.vy * time;
    assert.ok(time > 0 && Math.abs(x) < .955 && Math.abs(y) < .675);
    assert.ok(Math.abs(Math.hypot(b.vx, b.vy, b.vz) - game.speed) < 1e-10);
    if (Math.abs(x) > .75) edges[x < 0 ? 0 : 1]++;
    else if (Math.abs(y) > .53) edges[y > 0 ? 2 : 3]++;
    else { center++; assert.ok(Math.abs(x) <= .35 && Math.abs(y) <= .24); }
  }
  assert.ok(center >= 150 && center <= 250, `${center} center shots out of 1000`);
  for (const count of edges) assert.ok(count >= 150 && count <= 250, `${count} shots to an edge`);
});

test('parking the paddle at each edge catches the corresponding aimed shot', () => {
  for (let edge = 0; edge < 4; edge++) {
    const draws = [.1, (edge + .5) / 4, .5, .5];
    let missed = false;
    const game = new engine.PongGame(() => { missed = true; }, () => draws.shift() ?? .5);
    game.running = true;
    game.ball = { x: 0, y: 0, z: 5.15, vx: 0, vy: 0, vz: game.speed };
    game.bounce(true);
    const hint = game.arrivalHint();
    const [x, y] = [[-.83, 0], [.83, 0], [0, .585], [0, -.585]][edge];
    assert.ok(Math.abs(hint.x - x) < 1e-10 && Math.abs(hint.y - y) < 1e-10);
    game.setTarget(x, y);
    game.player.x = game.target.x; game.player.y = game.target.y;
    for (let i = 0; i < 2000 && game.running && game.ball.vz < 0; i++) game.update(.004);
    assert.equal(missed, false, `edge ${edge} should be reachable`);
    assert.equal(game.hits, 2);
    assert.ok(game.ball.vz > 0);
  }
});

test('a serve after a CPU miss follows the same edge bias without adding speed', () => {
  const game = new engine.PongGame(() => {}, () => .2); game.running = true;
  game.ball = { x: .9, y: .6, z: 5.14, vx: 0, vy: 0, vz: 1 };
  game.update(.02);
  const hint = game.arrivalHint();
  assert.ok(hint.x < -.75);
  assert.equal(game.incomingVolleys, 1);
  assert.equal(game.hits, 0);
  assert.equal(game.speed, game.initialSpeed);
});

test('arrival guidance covers exactly the first three incoming balls and resets on replay', () => {
  const game = new engine.PongGame(); game.running = true;
  assert.equal(game.arrivalHint(), null); // Opening serve travels away.
  for (let incoming = 1; incoming <= 4; incoming++) {
    game.ball.z = 4.8;
    game.bounce(true);
    assert.equal(game.incomingVolleys, incoming);
    assert.equal(game.arrivalHint() !== null, incoming <= 3);
    if (incoming <= 3) {
      game.running = false;
      assert.equal(game.arrivalHint(), null);
      game.running = true;
    }
    game.ball.z = .15;
    game.bounce(false);
    assert.equal(game.arrivalHint(), null);
  }
  game.reset(); game.running = true; game.bounce(true);
  assert.equal(game.incomingVolleys, 1);
  assert.notEqual(game.arrivalHint(), null);
});

test('the arrival label is drawn only for ball one while the outline remains for balls two and three', () => {
  const text = [], dashes = [];
  const context = new Proxy({
    createRadialGradient: () => ({ addColorStop() {} }),
    measureText: () => ({ width: 100 }),
    fillText: value => text.push(value),
    setLineDash: value => dashes.push([...value]),
  }, { get: (object, key) => object[key] ?? (() => {}) });
  const renderer = new engine.CourtRenderer({ getContext: () => context });
  renderer.resize = () => Object.assign(renderer, { width: 1280, height: 720, cx: 640, cy: 360, base: 400, scaleX: 400, scaleY: 400 });
  const game = new engine.PongGame(); game.running = true;
  game.ball.vz = -1; game.ball.z = 2;
  for (let incoming = 1; incoming <= 4; incoming++) {
    game.incomingVolleys = incoming; text.length = 0; dashes.length = 0;
    renderer.render(game);
    assert.equal(text.includes('BALL ARRIVES HERE'), incoming === 1);
    assert.equal(dashes.some(dash => dash[0] === 6 && dash[1] === 6), incoming <= 3);
  }
  game.reset(); game.running = true; game.ball.vz = -1; game.incomingVolleys = 1;
  text.length = 0; renderer.render(game);
  assert.equal(text.includes('BALL ARRIVES HERE'), true);
});

test('arrival guidance predicts the actual paddle-plane position after wall bounces', () => {
  let arrived;
  const game = new engine.PongGame(() => { arrived = { ...game.ball }; });
  game.running = true; game.incomingVolleys = 1;
  game.ball = { x: .8, y: .5, z: 3, vx: .45, vy: .32, vz: -2 };
  const hint = game.arrivalHint();
  assert.ok(Math.abs(hint.x - .46875) < 1e-10);
  assert.ok(Math.abs(hint.y - .394) < 1e-10);
  for (let i = 0; i < 300 && !arrived; i++) game.update(.005);
  assert.ok(arrived);
  assert.ok(Math.abs(arrived.x - hint.x) < .003);
  assert.ok(Math.abs(arrived.y - hint.y) < .003);
});

test('CPU misses consume incoming hints without adding a paddle return or changing speed', () => {
  const game = new engine.PongGame(); game.running = true;
  for (let incoming = 1; incoming <= 4; incoming++) {
    game.cpu.x = 0; game.cpu.y = 0;
    game.ball = { x: .9, y: .6, z: 5.14, vx: 0, vy: 0, vz: 1 };
    game.update(.02);
    assert.equal(game.points, incoming);
    assert.equal(game.incomingVolleys, incoming);
    assert.equal(game.arrivalHint() !== null, incoming <= 3);
    assert.equal(game.hits, 0);
    assert.equal(game.speed, game.initialSpeed);
  }
});

test('a miss ends the round exactly once and reset restores the initial state', () => {
  let misses = 0;
  const game = new engine.PongGame(() => misses++); game.running = true;
  game.ball = { x: .85, y: .5, z: .17, vx: 0, vy: 0, vz: -2 };
  game.update(.03); game.update(.03);
  assert.equal(misses, 1); assert.equal(game.running, false);
  game.hits = 20; game.reset();
  assert.equal(game.hits, 0); assert.equal(game.speed, game.initialSpeed);
});

test('paddle remains on the fixed near plane and inside the court', () => {
  const game = new engine.PongGame(); game.setTarget(100, -100);
  for (let i = 0; i < 100; i++) game.update(.02);
  assert.ok(game.player.x <= 1 - game.player.w);
  assert.ok(game.player.y >= -.72 + game.player.h);
  assert.equal(game.player.z, undefined);
});

test('the full-page court fills wide and tall viewports and places the paddle at the gaze point', () => {
  const previousWindow = globalThis.window;
  try {
    let bounds;
    const renderer = new engine.CourtRenderer({
      getContext: () => ({ setTransform() {} }), getBoundingClientRect: () => bounds,
    }, { fillViewport: true });
    for (const [width, height, left, top] of [[1440, 900, 0, 0], [2560, 1080, 0, 0], [900, 1200, 0, 0], [1000, 600, 40, 60]]) {
      bounds = { width, height, left, top };
      globalThis.window = { innerWidth: width + left, innerHeight: height + top, devicePixelRatio: 2 };
      // The first gaze reading also refreshes geometry, before the first render.
      const center = renderer.gazeToCourt((left + width / 2) / window.innerWidth, (top + height / 2) / window.innerHeight);
      assert.ok(center.every(value => Math.abs(value) < 1e-10));
      const inset = engine.clamp(Math.min(width, height) * .025, 12, 24);
      const nearCorner = renderer.project(1, -.72, 0);
      assert.ok(Math.abs(nearCorner[0] - (width - inset)) < 1e-10);
      assert.ok(Math.abs(nearCorner[1] - (height - inset)) < 1e-10);
      for (const point of [[.25, .3], [.7, .65], [.5, .5]]) {
        const target = renderer.gazeToCourt(...point);
        const game = new engine.PongGame();
        game.setTarget(...target);
        const drawn = renderer.project(game.target.x, game.target.y, .12);
        assert.ok(Math.abs(drawn[0] + left - point[0] * window.innerWidth) < 1e-8);
        assert.ok(Math.abs(drawn[1] + top - point[1] * window.innerHeight) < 1e-8);
      }
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

// An isolated DOM fixture exercises the production state machine without
// accessing a camera, altering browser permissions, or adding a test mode to UI.
function appFixture(options = {}) {
  const initialConfig = options.configResponse || options.config || { processing: 'local' };
  let time = 10000;
  let timerId = 0;
  const timers = new Map();
  const handlers = new Map();
  const listen = (key, fn) => { if (!handlers.has(key)) handlers.set(key, new Set()); handlers.get(key).add(fn); };
  const emit = key => { let result; for (const fn of [...(handlers.get(key) || [])]) result = fn(); return result; };
  const requests = [];
  let profileCount = 0;
  let saveCalibration = body => ({ calibration_id: `test-profile-${++profileCount}`, model: engine.fitCalibration(body.points.map(p => ({ target: p.target, angles: engine.aggregateAngles(p.samples.map(s => [s.yaw, s.pitch])) }))) });
  class Element {
    constructor(id = '', classes = '') {
      this.id = id; this.classes = new Set(classes.split(' ').filter(Boolean));
      this.style = { setProperty(name, value) { this[name] = value; } }; this.dataset = {}; this.children = []; this.textContent = ''; this.disabled = false;
      this.classList = { add: (...a) => a.forEach(x => this.classes.add(x)), remove: (...a) => a.forEach(x => this.classes.delete(x)),
        contains: x => this.classes.has(x), toggle: (x, force) => { const value = force ?? !this.classes.has(x); value ? this.classes.add(x) : this.classes.delete(x); return value; } };
      this.firstChild = { textContent: '' };
    }
    addEventListener(name, fn) { listen(`${this.id}:${name}`, fn); }
    removeEventListener(name, fn) { handlers.get(`${this.id}:${name}`)?.delete(fn); }
    append(...children) {
      for (const child of children) {
        if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(item => item !== child);
        child.parentElement = this;
        this.children.push(child);
      }
    }
    replaceChildren(...children) { this.children = children; }
    getClientRects() { return [{}]; }
    focus() { document.activeElement = this; }
    setAttribute() {}
    getContext() {
      this.drawCalls ??= [];
      this.drawingContext ??= new Proxy({}, { get: (object, key) => object[key] ?? ((...args) => {
        if (key === 'clearRect') this.drawCalls.length = 0;
        this.drawCalls.push({ name: key, args });
      }) });
      return this.drawingContext;
    }
    toDataURL() { return 'data:image/jpeg;base64,dGVzdGltYWdl'; }
    getBoundingClientRect() {
      return this.id === 'target' ? { width: 144, height: 144 }
        : this.id === 'webcam' ? { left: 500, top: 290, bottom: 560, width: 280, height: 270 }
        : { left: 0, top: 100, width: 1280, height: 650 };
    }
    querySelectorAll() { return [$('modal-primary'), $('modal-secondary')]; }
    async play() { if (options.play) await options.play(); this.paused = false; }
  }
  const elements = new Map();
  for (const match of fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    elements.set(match[1], new Element(match[1], match[0].match(/class="([^"]*)"/)?.[1] || ''));
  }
  const $ = id => elements.get(id);
  const main = new Element('main');
  main.getAttribute = () => options.apiOrigin;
  const document = { getElementById: $, createElement: () => new Element(), createTextNode: text => ({ textContent: text }),
    querySelector: () => main, addEventListener: (name, fn) => listen(`document:${name}`, fn), activeElement: null, hidden: false };
  $('video').parentElement = new Element(); $('video').videoWidth = 640; $('video').videoHeight = 480;
  $('video').readyState = 3;
  Object.defineProperty($('video'), 'currentTime', { configurable: true, get: () => time / 1000 });
  $('video').paused = true;
  const track = new EventTarget();
  Object.assign(track, { readyState: 'live', enabled: true, muted: false,
    stop() { this.readyState = 'ended'; media.active = false; } });
  const media = { active: true, getTracks: () => [track], getVideoTracks: () => [track] };
  let frameCallback = null, mediaRequests = 0;
  if (options.waitForFrame) {
    $('video').requestVideoFrameCallback = callback => { frameCallback = callback; return 1; };
    $('video').cancelVideoFrameCallback = () => { frameCallback = null; };
  }
  const context = vm.createContext({ ...engine, URL, console, document, performance: { now: () => time },
    window: { innerWidth: 1280, innerHeight: 850, addEventListener() {} },
    navigator: { permissions: options.permissions, mediaDevices: { getUserMedia: async () => {
      mediaRequests++;
      return options.getUserMedia ? options.getUserMedia(media) : media;
    } } },
    fetch: async (url, options = {}) => {
      requests.push({ url, ...options });
      if (url.endsWith('/api/config')) return { ok: true, json: async () => initialConfig };
      if (url === '/api/calibration') return { ok: true, json: async () => saveCalibration(JSON.parse(options.body)) };
      if (options.method === 'DELETE') return { ok: true };
      if (url === '/api/gaze' && gazeDelay !== null) {
        const body = JSON.parse(options.body);
        return new Promise((resolve, reject) => {
          const id = ++timerId;
          timers.set(id, { at: time + gazeDelay, fn: () => resolve({ ok: true, json: async () => ({
            captured_at: body.captured_at, gazes: [{ yaw: .1, pitch: .2 }],
          }) }) });
          options.signal?.addEventListener('abort', () => { timers.delete(id); reject(Object.assign(new Error(), { name: 'AbortError' })); }, { once: true });
        });
      }
      return new Promise(() => {});
    },
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimeout: id => timers.delete(id), requestAnimationFrame() {}, AbortController, AbortSignal });
  const gazeDelay = options.gazeDelay ?? null;
  let source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8').replace(/^import .*?;\n/gm, '');
  vm.runInContext(fs.readFileSync(new URL("../web/api-client.js", import.meta.url), "utf8").replace(/^export /gm, ""), context);
  vm.runInContext(source, context);
  return { context, $, requests, media, track, mediaRequests: () => mediaRequests,
    presentFrame: () => { const callback = frameCallback; frameCallback = null; callback?.(time, { mediaTime: time / 1000 }); },
    setCalibrationResponse: fn => { saveCalibration = fn; }, run: expression => vm.runInContext(expression, context),
    advance: amount => {
      time += amount;
      for (const [id, timer] of [...timers]) if (timer.at <= time && timers.has(id)) { timers.delete(id); timer.fn(); }
    },
    setHidden: hidden => { document.hidden = hidden; emit('document:visibilitychange'); },
    click: id => emit(`${id}:click`) };
}

test('Get Started stays still for five seconds before pulsing', () => {
  const f = appFixture();
  assert.equal(f.$('enable-camera').classList.contains('is-idle'), false);
  f.advance(4999);
  assert.equal(f.$('enable-camera').classList.contains('is-idle'), false);
  f.advance(1);
  assert.equal(f.$('enable-camera').classList.contains('is-idle'), true);
});

test('a Render cold start cannot start calibration before configuration and tracking are ready', async () => {
  const f = appFixture({ apiOrigin: 'https://pong-api.josephofiowa.com', configResponse: new Promise(() => {}) });
  assert.equal(f.run('transport'), 'cloud-streaming');
  await f.click('enable-camera');
  advanceCalibrationReady(f, 65000);
  f.click('start-calibration');
  assert.equal(f.run('state'), 'calibration-ready');
  assert.equal(f.run('calibrationReadyStarted'), null);
  assert.equal(f.$('start-calibration').disabled, true);
  assert.match(f.$('calibration-ready-caption').textContent, /Preparing eye tracking/);
});

test('page load prepares tracking without requesting camera access or starting calibration', async () => {
  const config = { processing: 'cloud', transport: 'cloud-streaming', face_detector: { model_id: 'test-face' } };
  const f = appFixture({ config }); f.context.preparationCalls = [];
  f.run('prepareTracking = config => { preparationCalls.push(config); return Promise.resolve(null); };');
  await flushAsync();
  assert.deepEqual(f.context.preparationCalls, [config]);
  assert.equal(f.mediaRequests(), 0);
  assert.equal(f.run('state'), 'welcome');
  assert.equal(f.run('calibrationReadyStarted'), null);
});

test('pressing Get Started before five seconds cancels the pulse', async () => {
  const f = appFixture(); f.advance(3000);
  await allowCameraAndCalibrate(f); f.advance(6000);
  assert.equal(f.$('enable-camera').classList.contains('is-idle'), false);
});

test('returning to the welcome screen or tab restarts the full five-second wait', () => {
  const f = appFixture(); f.advance(5000);
  f.run("state='setup'; setScreen('setup'); state='welcome'; setScreen('welcome');");
  f.advance(4999);
  assert.equal(f.$('enable-camera').classList.contains('is-idle'), false);
  f.advance(1);
  assert.equal(f.$('enable-camera').classList.contains('is-idle'), true);
  f.setHidden(true); f.advance(10000); f.setHidden(false);
  assert.equal(f.$('enable-camera').classList.contains('is-idle'), false);
  f.advance(4999);
  assert.equal(f.$('enable-camera').classList.contains('is-idle'), false);
  f.advance(1);
  assert.equal(f.$('enable-camera').classList.contains('is-idle'), true);
});

function predict(f, yaw, pitch, token = f.run('targetToken'), face = { x: 320, y: 230, width: 180, height: 200 }) {
  f.context.prediction = {
    captured_at: f.run('performance.now()'), face_count: 1,
    image_size: { width: 640, height: 480 },
    gazes: [{ yaw, pitch, face }],
  };
  f.context.predictionToken = token;
  f.run('onPrediction(prediction, predictionToken)');
}

function advanceCalibrationReady(f, milliseconds) {
  f.advance(milliseconds);
  f.run('updateCalibrationReady(performance.now())');
}

function advanceReadyWithGaze(f, milliseconds) {
  let remaining = milliseconds;
  while (remaining > 0) {
    const step = Math.min(100, remaining);
    f.advance(step); remaining -= step;
    predict(f, .1, .2);
    f.run('updateCalibrationReady(performance.now())');
  }
}

test('cloud calibration waits for fresh streaming results before its full five-second countdown', async () => {
  const f = appFixture(); await f.click('enable-camera');
  f.run("transport = 'cloud-streaming'; cloudGazeReady = false;");
  advanceReadyWithGaze(f, 10000);
  f.click('start-calibration');
  assert.equal(f.run('state'), 'calibration-ready');
  assert.equal(f.$('start-calibration').disabled, true);
  assert.equal(f.run('calibrationReadyStarted'), null);
  f.run('cloudGazeReady = true; restartCalibrationReadyTimer();');
  advanceReadyWithGaze(f, 4999);
  assert.equal(f.run('state'), 'calibration-ready');
  advanceReadyWithGaze(f, 1);
  assert.equal(f.run('state'), 'calibration');
  assert.equal(f.run('targetIndex'), 0);
});

test('cloud startup failure stays visible instead of being replaced by a waiting message', async () => {
  const f = appFixture(); await f.click('enable-camera');
  f.run("transport = 'cloud-streaming'; cloudGazeReady = false; cloudConnectionError = 'Connection failed. Restart the camera.';");
  advanceCalibrationReady(f, 5000);
  assert.equal(f.$('calibration-ready-caption').textContent, 'Connection failed. Restart the camera.');
  assert.equal(f.run('state'), 'calibration-ready');
});

test('Start Calibration visibly counts all five seconds after live tracking becomes ready', async () => {
  const f = appFixture(); await f.click('enable-camera');
  f.run("transport = 'cloud-streaming'; cloudGazeReady = true; restartCalibrationReadyTimer();");
  const captions = [f.$('calibration-ready-caption').textContent];
  for (let second = 1; second < 5; second++) {
    advanceReadyWithGaze(f, 1000);
    assert.equal(f.run('state'), 'calibration-ready');
    captions.push(f.$('calibration-ready-caption').textContent);
  }
  assert.deepEqual(captions, [5, 4, 3, 2, 1].map(n => `Starts automatically in ${n} ${n === 1 ? 'second' : 'seconds'}`));
  advanceReadyWithGaze(f, 999);
  assert.equal(f.run('state'), 'calibration-ready');
  advanceReadyWithGaze(f, 1);
  assert.equal(f.run('state'), 'calibration');
});

async function allowCameraAndCalibrate(f) {
  await f.click('enable-camera');
  predict(f, .1, .2, undefined, null);
  f.click('start-calibration');
}

const flushAsync = () => new Promise(resolve => setImmediate(resolve));

function finishCurrentDot(f) {
  const [x, y] = f.run('targets[targetIndex]');
  const yaw = .5 * x + .08 * y - .2, pitch = -.07 * x + .4 * y - .1;
  f.advance(250); predict(f, yaw, pitch, undefined, null);
  f.advance(500); predict(f, yaw, pitch, undefined, null);
  f.advance(500); predict(f, yaw, pitch, undefined, null);
  f.advance(140); f.run('updateCalibration(performance.now())');
}

test('an unanswered Allow prompt never opens the ready step, even after a long wait or another start attempt', async () => {
  let allow;
  const f = appFixture({ getUserMedia: media => new Promise(resolve => { allow = () => resolve(media); }) });
  const request = f.click('enable-camera');
  await flushAsync();
  await f.click('enable-camera');
  advanceCalibrationReady(f, 30000);
  f.run('beginCalibration()');
  assert.equal(f.mediaRequests(), 1);
  assert.equal(f.run('state'), 'setup');
  assert.equal(f.run('cameraAccessConfirmed'), false);
  assert.equal(f.$('permission-guide').classList.contains('hidden'), false);
  assert.equal(f.$('calibration').classList.contains('hidden'), true);
  allow(); await request;
  assert.equal(f.run('state'), 'calibration-ready');
  assert.equal(f.$('calibration-ready-caption').textContent, 'Starts automatically in 5 seconds');
  assert.notEqual(f.run('calibrationReadyStarted'), null);
});

test('denying camera permission keeps calibration hidden and offers retry', async () => {
  const f = appFixture({ getUserMedia: async () => { throw Object.assign(new Error(), { name: 'NotAllowedError' }); } });
  await f.click('enable-camera');
  advanceCalibrationReady(f, 5000);
  assert.equal(f.run('state'), 'setup');
  assert.equal(f.run('cameraAccessConfirmed'), false);
  assert.equal(f.run('stream'), null);
  assert.equal(f.$('calibration').classList.contains('hidden'), true);
  assert.equal(f.$('retry-camera').classList.contains('hidden'), false);
  assert.match(f.$('setup-description').textContent, /Camera access is blocked/);
});

test('a stream object cannot bypass a camera permission that still reports prompt', async () => {
  const status = new EventTarget(); status.state = 'prompt';
  const f = appFixture({ permissions: { query: async () => status } });
  const request = f.click('enable-camera');
  await flushAsync();
  assert.notEqual(f.run('stream'), null);
  advanceCalibrationReady(f, 5000);
  f.run('beginCalibration()');
  assert.equal(f.run('state'), 'setup');
  assert.equal(f.$('permission-guide').classList.contains('hidden'), false);
  status.state = 'granted'; status.dispatchEvent(new Event('change'));
  await request;
  assert.equal(f.run('state'), 'calibration-ready');
  assert.equal(f.run('cameraAccessConfirmed'), true);
});

test('granted permission still waits for playback and a presented live camera frame', async () => {
  let play;
  const f = appFixture({ play: () => new Promise(resolve => { play = resolve; }), waitForFrame: true });
  const request = f.click('enable-camera');
  await flushAsync();
  advanceCalibrationReady(f, 5000);
  f.run('beginCalibration()');
  assert.equal(f.run('state'), 'setup');
  play(); await flushAsync();
  advanceCalibrationReady(f, 5000);
  assert.equal(f.run('state'), 'setup');
  assert.equal(f.run('cameraAccessConfirmed'), false);
  f.presentFrame(); await request;
  assert.equal(f.run('state'), 'calibration-ready');
  assert.equal(f.$('calibration-ready-caption').textContent, 'Starts automatically in 5 seconds');
});

test('a late camera grant after cancellation stops the returned stream without starting calibration', async () => {
  let allow;
  const f = appFixture({ getUserMedia: media => new Promise(resolve => { allow = () => resolve(media); }) });
  const request = f.click('enable-camera');
  f.click('camera-stop');
  allow(); await request;
  advanceCalibrationReady(f, 5000);
  assert.equal(f.run('state'), 'welcome');
  assert.equal(f.track.readyState, 'ended');
  assert.equal(f.run('cameraAccessConfirmed'), false);
});

test('losing live camera output during the preview wait prevents calibration from starting', async () => {
  const f = appFixture(); await f.click('enable-camera');
  f.track.muted = true;
  advanceCalibrationReady(f, 5000);
  assert.equal(f.run('state'), 'calibration-ready');
  assert.equal(f.run('calibrationReadyStarted'), null);
  assert.equal(f.run('targetToken'), '');
  assert.equal(f.$('start-calibration').disabled, true);
});

test('camera allowance shows a live preview and Start Calibration, then automatically starts at five seconds', async () => {
  const f = appFixture(); await f.click('enable-camera');
  assert.equal(f.run('state'), 'calibration-ready');
  assert.equal(f.$('webcam').classList.contains('hidden'), false);
  assert.equal(f.$('webcam').parentElement, f.$('calibration'));
  assert.equal(f.$('calibration-ready').classList.contains('hidden'), false);
  assert.equal(f.$('permission-guide').classList.contains('hidden'), true);
  assert.equal(f.$('calibration-ready-progress').style.transform, 'scaleX(1)');
  predict(f, .1, .2);
  assert.equal(f.run('targetSamples.length'), 0);
  advanceReadyWithGaze(f, 2500);
  assert.equal(f.run('state'), 'calibration-ready');
  assert.equal(f.$('calibration-ready-progress').style.transform, 'scaleX(0.5)');
  advanceReadyWithGaze(f, 2499);
  assert.equal(f.run('state'), 'calibration-ready');
  advanceCalibrationReady(f, 1);
  assert.equal(f.run('state'), 'calibration');
  assert.equal(f.run('targetIndex'), 0);
  assert.equal(f.$('calibration').classList.contains('preparing'), false);
  assert.equal(f.$('calibration-ready').classList.contains('hidden'), true);
  assert.equal(f.$('calibration-heading').textContent, 'Look at the first dot.');
  assert.equal(f.$('webcam').classList.contains('hidden'), false);
});

test('Start Calibration begins immediately and a later timer tick cannot restart the first point', async () => {
  const f = appFixture(); await f.click('enable-camera');
  advanceCalibrationReady(f, 1200);
  predict(f, .1, .2);
  f.click('start-calibration');
  assert.equal(f.run('state'), 'calibration');
  assert.equal(f.run('targetIndex'), 0);
  const token=f.run('targetToken');
  f.click('start-calibration');
  advanceCalibrationReady(f, 10000);
  assert.equal(f.run('targetToken'), token);
  assert.equal(f.$('webcam').classList.contains('hidden'), false);
});

test('cancelling the preview timer cannot start calibration afterward', async () => {
  const f = appFixture(); await f.click('enable-camera');
  advanceCalibrationReady(f, 600);
  f.click('cancel-calibration');
  advanceCalibrationReady(f, 5000);
  assert.equal(f.run('state'), 'welcome');
  assert.equal(f.run('stream'), null);
  assert.equal(f.run('targetToken'), '');
});

test('returning from a hidden tab gives the user a full five seconds with the preview', async () => {
  const f = appFixture(); await f.click('enable-camera');
  predict(f, .1, .2);
  advanceReadyWithGaze(f, 2000);
  assert.equal(f.$('calibration-ready-caption').textContent, 'Starts automatically in 3 seconds');
  f.setHidden(true); advanceCalibrationReady(f, 10000);
  assert.equal(f.run('state'), 'calibration-ready');
  f.setHidden(false);
  predict(f, .1, .2);
  assert.equal(f.$('calibration-ready-progress').style.transform, 'scaleX(1)');
  advanceReadyWithGaze(f, 4999);
  assert.equal(f.run('state'), 'calibration-ready');
  advanceCalibrationReady(f, 1);
  assert.equal(f.run('state'), 'calibration');
});
test('the mapping pass shows a one-second clock and briefly displays its completed circle', async () => {
  const f = appFixture(); await allowCameraAndCalibrate(f);
  f.advance(250); predict(f, .1, .2);
  f.advance(500); predict(f, .1, .2); f.run('updateCalibration(performance.now())');
  assert.equal(f.run('targetSamples.length'), 2);
  assert.equal(f.$('target').style['--fill-angle'], '180deg');
  f.advance(500); predict(f, .1, .2);
  assert.equal(f.$('target').style['--fill-angle'], '360deg');
  assert.equal(f.run('targetIndex'), 0);
  f.advance(139); f.run('updateCalibration(performance.now())');
  assert.equal(f.run('targetIndex'), 0);
  f.advance(1); f.run('updateCalibration(performance.now())');
  assert.equal(f.run('targetIndex'), 1);
});

test('the initial mapping tolerates small angle jitter but resets on a clear look-away', async () => {
  const f = appFixture(); await allowCameraAndCalibrate(f);
  f.advance(250); predict(f, .1, .2);
  f.advance(500); predict(f, .17, .2);
  assert.equal(f.$('target').style['--fill-angle'], '180deg');
  f.advance(100); predict(f, .32, .2);
  assert.equal(f.run('dwellStarted'), null);
  assert.equal(f.$('target').style['--fill-angle'], '0deg');
  f.advance(100); predict(f, .1, .2);
  f.advance(500); predict(f, .17, .2);
  f.advance(500); predict(f, .16, .2);
  assert.equal(f.$('target').style['--fill-angle'], '360deg');
  f.advance(140); f.run('updateCalibration(performance.now())');
  assert.equal(f.run('targetIndex'), 1);
  assert.equal(f.run('calibrationPoints[0].samples.length'), 3);
});


test('the centered webcam stays visible and the first point is above it without overlapping other targets', async () => {
  const f = appFixture(); await allowCameraAndCalibrate(f);
  assert.equal(f.$('webcam').classList.contains('hidden'), false);
  assert.equal(f.$('webcam').classList.contains('in-calibration'), true);
  assert.equal(f.$('webcam').parentElement, f.$('calibration'));
  const preview=f.$('webcam').getBoundingClientRect();
  const [x,y]=f.run('targets[0]');
  const radius=f.$('target').getBoundingClientRect().width*.4;
  assert.equal(x,.5);
  assert.ok(y*850+radius < preview.top);
  for (const [tx,ty] of f.run('targets')) {
    const closestX=engine.clamp(tx*1280,preview.left,preview.left+preview.width);
    const closestY=engine.clamp(ty*850,preview.top,preview.bottom);
    assert.ok(Math.hypot(tx*1280-closestX,ty*850-closestY)>radius);
  }
});

test('the calibration preview warns about head movement without blocking valid gaze', async () => {
  const f = appFixture(); await f.click('enable-camera');
  predict(f, .1, .2); f.click('start-calibration');
  f.advance(250); predict(f, .1, .2);
  f.advance(100); predict(f, .1, .2);
  assert.equal(f.$('webcam-note').textContent, "Look at the dot. It's ok to turn your head naturally");
  f.advance(100); predict(f, .1, .2, undefined, { x: 450, y: 230, width: 180, height: 200 });
  assert.equal(f.$('webcam').classList.contains('tracking-warning'), true);
  assert.match(f.$('webcam-note').textContent, /turn your head naturally/);
  assert.notEqual(f.run('dwellStarted'), null);
  assert.equal(f.$('target').style['--fill-angle'], '72deg');
  f.advance(100); predict(f, .1, .2);
  assert.equal(f.$('webcam').classList.contains('tracking-warning'), false);
  assert.equal(f.$('webcam-note').textContent, "Look at the dot. It's ok to turn your head naturally");
});

const guideEllipse = f => f.$('face-overlay').drawCalls.find(call => call.name === 'ellipse')?.args;

test('clicking Start Calibration freezes the last preview face position and size, not the first ten average', async () => {
  const f = appFixture(); await f.click('enable-camera');
  assert.equal(guideEllipse(f), undefined);
  for (let i = 0; i < 10; i++) {
    f.advance(100);
    predict(f, .1, .2, undefined, { x: 280 + i * 8, y: 190 + i * 4, width: 160 + i * 4, height: 180 + i * 2 });
    assert.equal(f.run('baseline'), null);
    assert.equal(guideEllipse(f), undefined);
    assert.equal(f.run('postureBad'), false);
  }
  f.advance(100);
  predict(f, .1, .2, undefined, { x: 450, y: 260, width: 240, height: 260 });
  assert.equal(guideEllipse(f), undefined);
  f.click('start-calibration');
  const anchoredGuide = [...guideEllipse(f)];
  assert.deepEqual(anchoredGuide.slice(0, 4), [450, 260, 240 * .58, 260 * .65]);
  assert.equal(f.run('state'), 'calibration');
  f.advance(250); predict(f, .1, .2);
  assert.deepEqual(guideEllipse(f), anchoredGuide);
  assert.equal(f.run('postureBad'), true);
});

test('automatic calibration anchors the newest reading arriving at the five-second boundary', async () => {
  const f = appFixture(); await f.click('enable-camera');
  predict(f, .1, .2);
  advanceReadyWithGaze(f, 4900);
  assert.equal(guideEllipse(f), undefined);
  f.advance(100);
  predict(f, .1, .2, undefined, { x: 450, y: 260, width: 240, height: 260 });
  assert.equal(f.run('state'), 'calibration');
  assert.deepEqual(guideEllipse(f).slice(0, 4), [450, 260, 240 * .58, 260 * .65]);
  const anchoredGuide = [...guideEllipse(f)];
  f.advance(250); predict(f, .1, .2);
  f.click('start-calibration');
  f.run('updateCalibrationReady(performance.now())');
  assert.deepEqual(guideEllipse(f), anchoredGuide);
});

for (const [width, height] of [[1280, 720], [720, 1280]]) test(`the head overlay matches a ${width}×${height} camera feed before CSS cropping and mirroring`, async () => {
  const f = appFixture();
  f.$('video').videoWidth = width; f.$('video').videoHeight = height;
  await f.click('enable-camera');
  const overlayHeight = Math.round(640 * height / width);
  f.context.prediction = { captured_at: f.run('performance.now()'), face_count: 1,
    image_size: { width: 640, height: overlayHeight }, gazes: [{ yaw: .1, pitch: .2,
      face: { x: 370, y: overlayHeight * .45, width: 180, height: 200 } }] };
  f.run('onPrediction(prediction,targetToken)');
  f.click('start-calibration');
  assert.equal(f.$('face-overlay').width, 640);
  assert.equal(f.$('face-overlay').height, overlayHeight);
  assert.deepEqual(guideEllipse(f).slice(0, 4), [370, overlayHeight * .45, 180 * .58, 200 * .65]);
  const box = f.$('face-overlay').drawCalls.find(call => call.name === 'roundRect');
  assert.deepEqual(box.args.slice(0, 4), [280, overlayHeight * .45 - 100, 180, 200]);
});

test('one fresh preview reading can anchor an off-center head without waiting for more detections', async () => {
  const f = appFixture(); await f.click('enable-camera');
  assert.equal(guideEllipse(f), undefined);
  predict(f, .1, .2, undefined, { x: 500, y: 300, width: 180, height: 200 });
  f.click('start-calibration');
  assert.equal(f.run('cameraReady'), true);
  assert.equal(f.run('baseline.x'), 500 / 640);
  assert.equal(f.run('baseline.y'), 300 / 480);
  assert.deepEqual(guideEllipse(f).slice(0, 4), [500, 300, 180 * .58, 200 * .65]);
  assert.equal(f.$('webcam-note').textContent, "Look at the dot. It's ok to turn your head naturally");
});

test('the guide stays at the initial position through movement and lost detection', async () => {
  const f = appFixture(); await f.click('enable-camera');
  predict(f, .1, .2); f.click('start-calibration');
  f.advance(250); predict(f, .1, .2);
  const anchoredGuide = [...guideEllipse(f)];
  f.advance(100);
  predict(f, .1, .2, undefined, { x: 450, y: 260, width: 230, height: 250 });
  assert.deepEqual(guideEllipse(f), anchoredGuide);
  assert.equal(f.run('baseline.x'), .5);
  assert.equal(f.run('postureBad'), true);
  assert.notEqual(f.run('dwellStarted'), null);
  assert.ok(f.$('face-overlay').drawCalls.some(call => call.name === 'roundRect' && call.args[2] === 230));
  f.run('prediction.face_count=0; prediction.gazes=[]; onPrediction(prediction,targetToken)');
  assert.deepEqual(guideEllipse(f), anchoredGuide);
  assert.equal(f.$('face-overlay').drawCalls.some(call => call.name === 'roundRect'), false);
});

test('recalibration clears the old guide and captures a new natural seated position', async () => {
  const f = appFixture(); await f.click('enable-camera');
  predict(f, .1, .2); f.click('start-calibration');
  f.advance(250); predict(f, .1, .2);
  f.click('restart-calibration');
  assert.equal(f.run('baseline'), null);
  assert.equal(f.run('latestFaceGuide'), null);
  assert.equal(guideEllipse(f), undefined);
  predict(f, .1, .2, undefined, { x: 160, y: 280, width: 150, height: 190 });
  assert.equal(guideEllipse(f), undefined);
  f.click('start-calibration');
  assert.equal(f.run('cameraReady'), true);
  assert.deepEqual(guideEllipse(f).slice(0, 4), [160, 280, 150 * .58, 190 * .65]);
});

test('an expired preview face cannot anchor the guide or block gaze calibration', async () => {
  const f = appFixture(); await f.click('enable-camera');
  predict(f, .1, .2);
  f.advance(900);
  predict(f, .1, .2, undefined, null);
  f.click('start-calibration');
  assert.equal(f.run('state'), 'calibration');
  assert.equal(f.run('baseline'), null);
  assert.equal(guideEllipse(f), undefined);
  // Face detection returning after the start must not move the anchor.
  f.advance(250); predict(f, .1, .2);
  f.advance(500); predict(f, .1, .2);
  assert.equal(guideEllipse(f), undefined);
  assert.equal(f.$('target').style['--fill-angle'], '180deg');
});

test('missing, invalid, repeated and older readings cannot replace the latest valid preview face', async () => {
  const f = appFixture(); await f.click('enable-camera');
  predict(f, .1, .2);
  f.advance(100);
  predict(f, .1, .2, undefined, { x: 450, y: 260, width: 230, height: 250 });
  f.run('prediction.gazes[0].face.x=150');
  f.run('onPrediction(prediction,targetToken)'); // Same captured frame again.
  f.run('prediction.captured_at-=5; onPrediction(prediction,targetToken)');
  f.advance(100);
  predict(f, .1, .2, undefined, null);
  predict(f, .1, .2, undefined, { x: 320, y: 230, width: 0, height: 200 });
  predict(f, NaN, .2);
  f.run('prediction.gazes[0].yaw=.1; prediction.captured_at-=1500; onPrediction(prediction,targetToken)');
  assert.equal(guideEllipse(f), undefined);
  predict(f, .1, .2, undefined, null);
  f.click('start-calibration');
  [450, 260, 230 * .58, 250 * .65].forEach((value, i) => {
    assert.ok(Math.abs(guideEllipse(f)[i] - value) < 1e-9);
  });
  f.click('camera-stop');
  assert.equal(f.run('latestFaceGuide'), null);
  assert.equal(f.run('lastFaceGuideCapture'), null);
  assert.equal(f.run('baseline'), null);
});

test('the calibration clock requires a full second of confirmed gaze readings', async () => {
  const f = appFixture(); await allowCameraAndCalibrate(f);
  f.advance(250); predict(f, .5, .22);
  f.advance(500); predict(f, .5, .22);
  assert.equal(f.$('target').style['--fill-angle'], '180deg');
  f.advance(499); predict(f, .5, .22);
  assert.equal(f.run('targetIndex'), 0);
  f.advance(1); f.run('updateCalibration(performance.now())');
  assert.equal(f.run('targetIndex'), 0); // Wall time alone never completes it.
  predict(f, .5, .22);
  f.advance(140); f.run('updateCalibration(performance.now())');
  assert.equal(f.run('targetIndex'), 1);
  assert.equal(f.$('target').style.left, '12%');
  assert.equal(f.$('target').style['--fill-angle'], '0deg');
  assert.equal(f.run('calibrationPoints[0].samples.length'), 4);
});


test('a large gaze shift clears partial progress and samples, then requires a new full second', async () => {
  const f = appFixture(); await allowCameraAndCalibrate(f);
  f.advance(250); predict(f, .5, .22);
  f.advance(500); predict(f, .5, .22);
  assert.equal(f.$('target').style['--fill-angle'], '180deg');
  f.advance(50); predict(f, .7, .22);
  assert.equal(f.run('dwellStarted'), null);
  assert.equal(f.run('targetSamples.length'), 0);
  assert.equal(f.$('target').style['--fill-angle'], '0deg');
  assert.match(f.$('calibration-hint').textContent, /gaze estimate shifted/);
  f.advance(100); predict(f, .5, .22);
  f.advance(500); predict(f, .5, .22);
  assert.equal(f.run('targetIndex'), 0);
  assert.equal(f.$('target').style['--fill-angle'], '180deg');
  f.advance(500); predict(f, .5, .22);
  f.advance(140); f.run('updateCalibration(performance.now())');
  assert.equal(f.run('targetIndex'), 1);
  assert.equal(f.run('calibrationPoints[0].samples.length'), 3);
});


test('lost tracking resets the dwell and a previous target’s frame is discarded', async () => {
  const f = appFixture(); await allowCameraAndCalibrate(f);
  f.advance(250); predict(f, .5, .22); const oldToken = f.run('targetToken');
  f.advance(500); f.run('onPrediction({captured_at:performance.now(),face_count:0,gazes:[]},targetToken)');
  assert.equal(f.run('dwellStarted'), null);
  f.advance(250); predict(f, .5, .22, oldToken);
  assert.equal(f.run('targetSamples.length'), 0);
  predict(f, .5, .22);
  f.setHidden(true); f.advance(5000); f.setHidden(false);
  assert.equal(f.run('dwellStarted'), null);
  assert.equal(f.run('targetIndex'), 0);
});

for (const lost of [[], [{ yaw: NaN, pitch: .22 }]]) test(`gaze-only calibration resets on ${lost.length ? 'invalid angles' : 'missing gaze'} and requires a new full second`, async () => {
  const f = appFixture(); await allowCameraAndCalibrate(f);
  const gazeOnly = gazes => {
    f.context.prediction = { captured_at: f.run('performance.now()'), gazes };
    f.run('onPrediction(prediction,targetToken)');
  };
  f.advance(250); gazeOnly([{ yaw: .5, pitch: .22 }]);
  f.advance(500); gazeOnly([{ yaw: .5, pitch: .22 }]);
  assert.equal(f.$('target').style['--fill-angle'], '180deg');
  f.advance(50); gazeOnly(lost);
  assert.equal(f.$('target').style['--fill-angle'], '0deg');
  assert.equal(f.run('targetSamples.length'), 0);
  assert.equal(f.run('dwellStarted'), null);
  assert.match(f.$('calibration-hint').textContent, /Gaze lost/);
  f.advance(100); gazeOnly([{ yaw: .5, pitch: .22 }]);
  f.advance(500); gazeOnly([{ yaw: .5, pitch: .22 }]);
  assert.equal(f.run('targetIndex'), 0);
  assert.equal(f.$('target').style['--fill-angle'], '180deg');
  f.advance(500); gazeOnly([{ yaw: .5, pitch: .22 }]);
  f.advance(140); f.run('updateCalibration(performance.now())');
  assert.equal(f.run('targetIndex'), 1);
});

test('a stalled inference response cannot finish a calibration target', async () => {
  const f = appFixture(); await allowCameraAndCalibrate(f);
  f.advance(250); predict(f, .5, .22);
  f.advance(500); predict(f, .5, .22);
  f.advance(801); f.run('updateCalibration(performance.now())');
  assert.equal(f.run('targetIndex'), 0);
  assert.equal(f.run('dwellStarted'), null);
  assert.equal(f.$('target').style['--fill-angle'], '0deg');
  assert.equal(f.$('webcam').classList.contains('tracking-warning'), true);
  assert.match(f.$('webcam-note').textContent, /fresh view/);
});

for (const mode of ['single face', 'no face metadata', 'extra detections']) test(`exactly nine calibration points start play with ${mode}`, async () => {
  const f = appFixture(); await allowCameraAndCalibrate(f);
  const readGaze = (yaw, pitch) => {
    if (mode === 'single face') return predict(f, yaw, pitch);
    let gazes = [{ yaw, pitch }];
    if (mode === 'extra detections') {
      gazes[0].face = { x: 320, y: 230, width: 180, height: 200 };
      const extra = { yaw: -.6, pitch: -.7, face: { x: 100, y: 350, width: 40, height: 40 } };
      gazes = f.run('targetSamples.length') % 2 ? [gazes[0], extra] : [extra, gazes[0]];
    }
    f.context.prediction = { captured_at: f.run('performance.now()'), face_count: mode === 'extra detections' ? 2 : 0,
      image_size: { width: 640, height: 480 }, gazes };
    f.run('onPrediction(prediction,targetToken)');
  };
  for (let index = 0; index < 9; index++) {
    assert.equal(f.run('state'), 'calibration');
    assert.equal(f.$('calibration-count').textContent, `DOT ${index + 1} OF 9`);
    const [x, y] = f.run('targets[targetIndex]');
    const yaw = .5 * x + .08 * y - .2, pitch = -.07 * x + .4 * y - .1;
    f.advance(250); readGaze(yaw, pitch);
    f.advance(500); readGaze(yaw, pitch);
    f.advance(500); readGaze(yaw, pitch);
    f.advance(140); f.run('updateCalibration(performance.now())');
  }
  await flushAsync();
  const saves = f.requests.filter(r => r.url === '/api/calibration');
  assert.equal(saves.length, 1);
  const submitted = JSON.parse(saves[0].body);
  assert.equal(submitted.points.length, 9);
  assert.deepEqual(submitted.viewport, [1280, 850]);
  assert.equal(submitted.points[0].target[0], .5);
  assert.ok(submitted.points[0].target[1] < .4);
  assert.equal(submitted.points[0].samples.length, 3);
  assert.equal(f.run('state'), 'playing');
  assert.equal(f.run('game.running'), true);
  assert.ok(f.run('game.ball.vz') > 0);
  assert.equal(f.run('calibrationId'), 'test-profile-1');
  assert.equal(f.requests.some(r => r.url === '/api/calibration/test-profile-1' && r.method === 'DELETE'), false);
  assert.equal(f.$('game-view').classList.contains('hidden'), false);
  assert.equal(f.$('modal').classList.contains('hidden'), true);
  assert.ok(f.run('gaze.every(Number.isFinite)'));
  if (mode === 'no face metadata') {
    assert.equal(f.run('baseline'), null);
    f.advance(100); readGaze(.05, .08);
    assert.equal(f.run('cameraReady'), true);
    assert.equal(f.run('state'), 'playing');
  }
});

for (const approximate of [false, true]) test(`saving the ninth dot starts play with ${approximate ? 'approximate' : 'precise'} calibration`, async () => {
  const f = appFixture(); await allowCameraAndCalibrate(f);
  f.setCalibrationResponse(() => ({ calibration_id: 'saved-profile', quality: { approximate, fit_rmse: approximate ? .3 : .02 },
    model: { mean:[0,0], scale:[1,1], x:[0,1,0], y:[0,0,1] } }));
  f.run('targetIndex=8; showTarget(); court.render=()=>{}; court.gazeToCourt=()=>[0,0];');
  f.advance(250); predict(f, .12, .5);
  f.advance(500); predict(f, .12, .5);
  assert.equal(f.run('state'), 'calibration');
  assert.equal(f.run('game.running'), false);
  f.advance(500); predict(f, .12, .5);
  f.advance(140); f.run('updateCalibration(performance.now())');
  assert.equal(f.run('state'), 'saving-calibration');
  await flushAsync();
  assert.equal(f.run('state'), 'playing');
  assert.equal(f.run('game.running'), true);
  assert.equal(f.$('game-view').classList.contains('hidden'), false);
  assert.equal(f.$('modal').classList.contains('hidden'), true);
  assert.equal(f.run('calibrationId'), 'saved-profile');
  assert.equal(f.requests.filter(r => r.url === '/api/calibration').length, 1);
  assert.equal(f.$('toast').classList.contains('hidden'), !approximate);
  if (approximate) assert.match(f.$('toast').textContent, /Eye control may be approximate/);
  const initialZ = f.run('game.ball.z');
  f.advance(16); f.run('tick(performance.now())');
  assert.ok(f.run('game.ball.z') > initialZ);
  assert.equal(f.run('game.speed'), f.run('game.initialSpeed'));
});

test('the full-page game keeps camera-off accessible and restores the header on exit', async () => {
  const f = appFixture(); await allowCameraAndCalibrate(f);
  f.run('calibration={mean:[0,0],scale:[1,1],x:[0,1,0],y:[0,0,1]}; startRound();');
  assert.equal(f.$('site-header').classList.contains('hidden'), true);
  assert.equal(f.$('game-view').classList.contains('hidden'), false);
  f.click('game-camera-stop');
  assert.equal(f.run('state'), 'welcome');
  assert.equal(f.$('site-header').classList.contains('hidden'), false);
  assert.equal(f.$('game-view').classList.contains('hidden'), true);
  assert.equal(f.track.readyState, 'ended');
});

test('Restart calibration discards partial samples and returns to the preview', async () => {
  const f = appFixture(); await allowCameraAndCalibrate(f);
  f.advance(250); predict(f, .1, .2);
  assert.equal(f.$('restart-calibration').classList.contains('hidden'), false);
  f.click('restart-calibration');
  assert.equal(f.run('state'), 'calibration-ready');
  assert.equal(f.run('targetIndex'), 0);
  assert.equal(f.run('targetSamples.length'), 0);
  assert.equal(f.run('calibration'), null);
  assert.equal(f.$('restart-calibration').classList.contains('hidden'), true);
});

test('a late calibration save cannot restart a cancelled game', async () => {
  const f = appFixture();
  let resolveSave;
  f.setCalibrationResponse(() => new Promise(resolve => { resolveSave = resolve; }));
  await allowCameraAndCalibrate(f);
  f.run(`targetIndex=8; targetSamples=[{yaw:.1,pitch:.2,captured_at:10000},{yaw:.1,pitch:.2,captured_at:10500},{yaw:.1,pitch:.2,captured_at:11000}]; completeTarget();`);
  await new Promise(resolve => setImmediate(resolve));
  f.click('cancel-calibration');
  resolveSave({calibration_id:'abandoned-profile',model:{}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.run('state'), 'welcome');
  assert.equal(f.run('calibration'), null);
  assert.ok(f.requests.some(r => r.url === '/api/calibration/abandoned-profile' && r.method === 'DELETE'));
});

test('live and game-over RETURNS display only the player count, including zero before the first return', () => {
  for (const [playerReturns, hits] of [[0, 1], [4, 9]]) {
    const f = appFixture();
    f.context.score = { playerReturns, hits };
    f.run('state="gameover"; game.playerReturns=score.playerReturns; game.hits=score.hits; court.render=()=>{}; tick(performance.now());');
    const expected = String(playerReturns).padStart(2, '0');
    assert.equal(f.$('rally-count').textContent, expected);
    f.run('state="playing"; endGame({...score,multiplier:1.5});');
    assert.equal(f.$('modal-stats').children[0].children[0].textContent, expected);
    assert.equal(f.$('modal-stats').children[0].children[1].textContent, 'RETURNS');
  }
});

test('game-over offers Replay and a smaller Recalibrate; Replay keeps calibration', async () => {
  const f = appFixture(); await allowCameraAndCalibrate(f);
  f.run(`calibration = {mean:[0,0],scale:[1,1],x:[0,1,0],y:[0,0,1]}; state='playing'; game.playerReturns=6;
    endGame({playerReturns:6,hits:12,points:0,multiplier:1.7});`);
  assert.equal(f.run('state'), 'gameover');
  assert.match(f.$('modal-primary').textContent, /Replay/);
  assert.equal(f.$('modal-secondary').textContent, 'Recalibrate');
  f.click('modal-primary');
  assert.equal(f.run('state'), 'playing');
  assert.equal(f.run('game.hits'), 0);
  assert.equal(f.run('game.playerReturns'), 0);
  assert.notEqual(f.run('calibration'), null);
});

test('Recalibrate forgets the personal mapping and restarts at the first target', async () => {
  const f = appFixture();
  await allowCameraAndCalibrate(f);
  f.run(`state='playing'; calibration={}; calibrationId='old-profile'; game.hits=20; endGame({playerReturns:10,hits:20,points:0,multiplier:2});`);
  f.click('modal-secondary');
  assert.equal(f.run('state'), 'calibration-ready');
  predict(f, .1, .2);
  advanceReadyWithGaze(f, 5000);
  assert.equal(f.run('state'), 'calibration');
  assert.equal(f.run('game.hits'), 0);
  assert.equal(f.run('calibration'), null);
  assert.equal(f.run('calibrationId'), null);
  assert.equal(f.run('targetIndex'), 0);
  assert.equal(f.run('targets.length'), 18);
  assert.ok(f.requests.some(r => r.url === '/api/calibration/old-profile' && r.method === 'DELETE'));
});

test('first play takes nine dots; Recalibrate recollects those nine plus nine new positions before play', async () => {
  const f = appFixture(); await allowCameraAndCalibrate(f);
  for (let i = 0; i < 9; i++) finishCurrentDot(f);
  await flushAsync();
  assert.equal(f.run('state'), 'playing');
  const first = JSON.parse(f.requests.find(r => r.url === '/api/calibration').body);
  assert.equal(first.points.length, 9);
  f.run('endGame({playerReturns:1,multiplier:1.2})');
  f.click('modal-secondary');
  assert.match(f.$('calibration-instruction').innerHTML, /All 18/);
  f.click('start-calibration');
  for (let i = 0; i < 18; i++) {
    assert.equal(f.$('calibration-count').textContent, `DOT ${i + 1} OF 18`);
    assert.equal(f.$('calibration').classList.contains('extra-points'), i >= 9);
    if (i === 9) {
      assert.equal(f.run('state'), 'calibration');
      assert.equal(f.run('game.running'), false);
      assert.equal(f.requests.filter(r => r.url === '/api/calibration').length, 1);
    }
    finishCurrentDot(f);
  }
  await flushAsync();
  const saves = f.requests.filter(r => r.url === '/api/calibration');
  assert.equal(saves.length, 2);
  const second = JSON.parse(saves[1].body);
  assert.equal(second.points.length, 18);
  assert.deepEqual(second.points.slice(0, 9).map(p => p.target), first.points.map(p => p.target));
  assert.equal(new Set(second.points.map(p => p.target.join(','))).size, 18);
  assert.ok(second.points[0].samples[0].captured_at > first.points.at(-1).samples.at(-1).captured_at);
  assert.equal(f.run('state'), 'playing');
  assert.equal(f.run('game.running'), true);
  assert.equal(f.run('baseline'), null, 'face geometry is not required for either collection');
  predict(f, .5 * .3 + .08 * .7 - .2, -.07 * .3 + .4 * .7 - .1);
  assert.ok(f.run('gaze.every(Number.isFinite)'));
  f.click('pause-button'); f.click('modal-secondary');
  assert.equal(f.run('targets.length'), 18, 'later Recalibrate clicks never grow to 27 points');
});

test('restarting or retrying extended calibration keeps 18 fresh targets and restores the preview', async () => {
  const f = appFixture(); await allowCameraAndCalibrate(f);
  f.run('state="playing"; pauseGame("manual")'); f.click('modal-secondary'); f.click('start-calibration');
  for (let i = 0; i < 10; i++) finishCurrentDot(f);
  assert.equal(f.$('calibration').classList.contains('extra-points'), true);
  f.click('restart-calibration');
  assert.equal(f.run('targets.length'), 18);
  assert.equal(f.run('calibrationPoints.length'), 0);
  assert.equal(f.run('targetIndex'), 0);
  assert.equal(f.$('calibration').classList.contains('extra-points'), false);
  f.run('calibrationFailed("Save failed")'); f.click('modal-primary');
  assert.equal(f.run('targets.length'), 18);
  assert.equal(f.run('state'), 'calibration-ready');
  f.click('cancel-calibration');
  assert.equal(f.run('extendedCalibration'), false, 'a new camera session starts with the quick nine-point setup');
});

test('tracking loss pauses the game instead of registering a miss', () => {
  const f = appFixture();
  f.run(`state='playing'; game.running=true; cameraReady=false; pauseGame('tracking');`);
  assert.equal(f.run('state'), 'paused');
  assert.equal(f.run('game.running'), false);
  assert.equal(f.$('modal-primary').disabled, true);
  assert.equal(f.$('modal-secondary').textContent, 'Recalibrate');
});

async function animate(f, duration, freshFrames = true) {
  for (let elapsed = 0; elapsed < duration; elapsed += 10) {
    f.advance(Math.min(10, duration - elapsed));
    if (freshFrames) f.presentFrame();
    f.run('tick(performance.now())');
    await flushAsync();
  }
}

test('fresh gaze requests are capped at eight per second without an extra post-response delay', async () => {
  const f = appFixture({ waitForFrame: true, gazeDelay: 100 });
  f.run('hero.render=()=>{}; court.render=()=>{};');
  const startup = f.click('enable-camera'); await flushAsync(); f.presentFrame(); await startup;
  await animate(f, 1200);
  const frames = f.requests.filter(r => r.url === '/api/gaze').map(r => JSON.parse(r.body));
  assert.ok(frames.length >= 9);
  for (let i = 1; i < frames.length; i++) {
    const interval = frames[i].captured_at - frames[i-1].captured_at;
    assert.ok(interval >= 125 && interval <= 130, `unexpected request interval ${interval} ms`);
  }
  assert.ok(f.run('latencyBreakdown.request_ms') >= 100);
  assert.match(f.$('latency-label').title, /gaze request/);
});

for (const delay of [100, 400, 500, 700]) test(`serial inference with ${delay} ms latency completes a dot while animation continues`, async () => {
  const f = appFixture({ waitForFrame: true, gazeDelay: delay });
  f.run('hero.render=()=>{}; court.render=()=>{};');
  const startup = f.click('enable-camera'); await flushAsync(); f.presentFrame(); await startup;
  await animate(f, delay + 50);
  assert.equal(f.$('start-calibration').disabled, false);
  f.click('start-calibration');
  await animate(f, 5000);
  assert.ok(f.run('targetIndex') >= 1, 'healthy slow responses must advance the first point');
  const samples = f.run('calibrationPoints[0].samples');
  assert.ok(samples.length >= 3);
  assert.ok(samples.at(-1).captured_at - samples[0].captured_at >= 1000);
  assert.ok(f.requests.filter(r => r.url === '/api/gaze').length >= 4);
  f.click('camera-stop');
});

test('a camera with no new presented frames cannot submit repeated pixels or finish a dot', async () => {
  const f = appFixture({ waitForFrame: true, gazeDelay: 100 });
  f.run('hero.render=()=>{}; court.render=()=>{};');
  const startup = f.click('enable-camera'); await flushAsync(); f.presentFrame(); await startup;
  await animate(f, 200); f.click('start-calibration');
  await animate(f, 800);
  assert.ok(f.run('targetSamples.length') > 1);
  const calls = f.requests.filter(r => r.url === '/api/gaze').length;
  await animate(f, 1500, false);
  assert.ok(f.requests.filter(r => r.url === '/api/gaze').length <= calls + 1);
  assert.equal(f.run('targetIndex'), 0);
  assert.equal(f.run('dwellStarted'), null);
  assert.equal(f.$('target').style['--fill-angle'], '0deg');
  await animate(f, 1600);
  assert.equal(f.run('targetIndex'), 1, 'new frames recover without another camera permission request');
  f.click('camera-stop');
});

test('muting the camera immediately clears partial dwell and rejects a returning prediction', async () => {
  const f = appFixture(); await allowCameraAndCalibrate(f);
  f.advance(250); predict(f, .1, .2); f.advance(500); predict(f, .1, .2);
  const token = f.run('targetToken');
  f.track.muted = true; f.track.dispatchEvent(new Event('mute'));
  assert.equal(f.run('dwellStarted'), null);
  predict(f, .1, .2, token);
  assert.equal(f.run('targetSamples.length'), 0);
  f.track.muted = false; f.advance(100); predict(f, .1, .2);
  assert.equal(f.$('target').style['--fill-angle'], '0deg');
});

for (const start of ['click', 'timer']) test(`a live preview starts calibration by ${start} while gaze is still loading`, async () => {
  const f = appFixture(); await f.click('enable-camera');
  assert.equal(f.$('start-calibration').disabled, false);
  assert.equal(f.$('calibration-ready-caption').textContent, 'Starts automatically in 5 seconds');
  advanceCalibrationReady(f, 2000);
  f.run('onPrediction({captured_at:performance.now(),gazes:[]},targetToken)');
  assert.equal(f.$('start-calibration').disabled, false);
  assert.equal(f.$('calibration-ready-caption').textContent, 'Starts automatically in 3 seconds');
  if (start === 'click') f.click('start-calibration');
  else advanceCalibrationReady(f, 3000);
  assert.equal(f.run('state'), 'calibration');
  assert.equal(f.$('calibration-count').textContent, 'DOT 1 OF 9');
  f.advance(2000); f.run('updateCalibration(performance.now())');
  assert.equal(f.run('targetIndex'), 0);
  assert.equal(f.run('targetSamples.length'), 0);
  assert.equal(f.$('target').style['--fill-angle'], '0deg');
  predict(f, .1, .2, undefined, null);
  f.advance(500); predict(f, .1, .2, undefined, null);
  f.advance(500); predict(f, .1, .2, undefined, null);
  f.advance(140); f.run('updateCalibration(performance.now())');
  assert.equal(f.run('targetIndex'), 1, 'tracking recovery advances the dot without another start click');
});

test('an existing camera grant opens the preview and enables calibration without another permission prompt', async () => {
  const permission = new EventTarget(); permission.state = 'granted';
  const f = appFixture({ permissions: { query: async () => permission } });
  await f.click('enable-camera');
  assert.equal(f.mediaRequests(), 1);
  assert.equal(f.run('cameraAccessConfirmed'), true);
  assert.equal(f.run('state'), 'calibration-ready');
  assert.equal(f.$('permission-guide').classList.contains('hidden'), true);
  assert.equal(f.$('start-calibration').disabled, false);
  f.click('start-calibration');
  assert.equal(f.run('state'), 'calibration');
  assert.equal(f.mediaRequests(), 1);
});

for (const failure of ['empty gaze', 'muted camera', 'stalled camera', 'stale response']) test(`${failure} pauses before an imminent paddle miss, including at the start of a round`, async () => {
  const f = appFixture(); await allowCameraAndCalibrate(f);
  f.run("state='playing';game.running=true;court.render=()=>{};game.ball={x:.85,y:.5,z:.17,vx:0,vy:0,vz:-2};");
  if (failure === 'empty gaze') f.run('onPrediction({captured_at:performance.now(),gazes:[]},targetToken)');
  if (failure === 'muted camera') f.track.muted = true;
  if (failure === 'stalled camera') {
    Object.defineProperty(f.$('video'), 'currentTime', { value: f.run('videoFrameTime') });
    f.advance(351);
  }
  if (failure === 'stale response') f.run('onPrediction({captured_at:performance.now()-1500,gazes:[{yaw:.1,pitch:.2}]},targetToken)');
  f.advance(30); f.run('tick(performance.now())');
  assert.equal(f.run('state'), 'paused');
  assert.equal(f.run('game.ball.z'), .17);
  assert.equal(f.run('game.running'), false);
  assert.equal(f.$('modal-primary').disabled, true);
});
