export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const median = (values) => {
  const a = [...values].sort((a, b) => a - b);
  const n = a.length;
  return n ? (a[(n - 1) >> 1] + a[n >> 1]) / 2 : NaN;
};

// This is a single-player game. A smaller extra detection must not veto the
// player's gaze or replace it because the detector changed its output order.
export function selectPlayerGaze(gazes) {
  const area = gaze => {
    const face = gaze.face;
    return face && [face.x, face.y, face.width, face.height].every(Number.isFinite)
      && face.width > 0 && face.height > 0 ? face.width * face.height : 0;
  };
  return (Array.isArray(gazes) ? gazes : []).filter(gaze => gaze
    && Number.isFinite(gaze.yaw) && Number.isFinite(gaze.pitch))
    .reduce((player, gaze) => !player || area(gaze) > area(player) ? gaze : player, null);
}

// Personal affine calibration in standardized angle space. The tiny ridge
// penalty regularizes noisy eye estimates without penalizing the intercept.
export function fitCalibration(points) {
  if (points.length < 5) throw new Error('More calibration targets are needed.');
  const mean = [0, 1].map(j => points.reduce((s, p) => s + p.angles[j], 0) / points.length);
  const scale = mean.map((m, j) => Math.sqrt(points.reduce((s, p) => s + (p.angles[j] - m) ** 2, 0) / points.length));
  if (scale.some(s => s < 0.006)) throw new Error('We couldn’t distinguish enough eye movement. Try again with your face well lit and the camera closer.');
  const rows = points.map(p => [1, (p.angles[0] - mean[0]) / scale[0], (p.angles[1] - mean[1]) / scale[1]]);
  const solve = axis => {
    const matrix = Array.from({ length: 3 }, (_, i) => [
      ...Array.from({ length: 3 }, (_, j) => rows.reduce((s, r) => s + r[i] * r[j], 0) + (i === j && i > 0 ? 0.03 : 0)),
      rows.reduce((s, r, k) => s + r[i] * points[k].target[axis], 0)
    ]);
    for (let c = 0; c < 3; c++) {
      let pivot = c;
      for (let r = c + 1; r < 3; r++) if (Math.abs(matrix[r][c]) > Math.abs(matrix[pivot][c])) pivot = r;
      [matrix[c], matrix[pivot]] = [matrix[pivot], matrix[c]];
      const divisor = matrix[c][c];
      if (Math.abs(divisor) < 1e-8) throw new Error('Eye movement was too similar across targets. Please recalibrate.');
      for (let j = c; j < 4; j++) matrix[c][j] /= divisor;
      for (let r = 0; r < 3; r++) if (r !== c) {
        const factor = matrix[r][c];
        for (let j = c; j < 4; j++) matrix[r][j] -= factor * matrix[c][j];
      }
    }
    return matrix.map(r => r[3]);
  };
  return { mean, scale, x: solve(0), y: solve(1) };
}

export function mapGaze(model, yaw, pitch, bounded = true) {
  const f = [1, (yaw - model.mean[0]) / model.scale[0], (pitch - model.mean[1]) / model.scale[1]];
  const dot = a => a.reduce((s, v, i) => s + v * f[i], 0);
  const point = [dot(model.x), dot(model.y)];
  return bounded ? point.map(x => clamp(x, 0, 1)) : point;
}

export function gazeInsideTarget(model, yaw, pitch, target, viewport, radius) {
  if (!model || !Number.isFinite(yaw) || !Number.isFinite(pitch) || !(radius > 0)) return false;
  // Use raw, unclamped gaze in viewport pixels. Smoothing or clipping at an
  // edge could conceal a glance outside the actual visible circle.
  const point = mapGaze(model, yaw, pitch, false);
  return point.every(Number.isFinite) && Math.hypot(
    (point[0] - target[0]) * viewport[0],
    (point[1] - target[1]) * viewport[1],
  ) <= radius;
}

export function aggregateAngles(samples) {
  const center = [median(samples.map(s => s[0])), median(samples.map(s => s[1]))];
  const distances = samples.map(s => Math.hypot(s[0] - center[0], s[1] - center[1]));
  const cutoff = Math.max(0.012, median(distances) * 2.8);
  const clean = samples.filter((_, i) => distances[i] <= cutoff);
  return [0, 1].map(j => median(clean.map(s => s[j])));
}

export function postureChanged(current, baseline) {
  if (!current || !baseline) return false;
  return Math.hypot(current.x - baseline.x, current.y - baseline.y) > 0.12 ||
    Math.abs(current.width / baseline.width - 1) > 0.3;
}

export function reflected(position, limit) {
  const period = 4 * limit;
  const phase = ((position + limit) % period + period) % period;
  return phase <= 2 * limit ? phase - limit : 3 * limit - phase;
}

export class PongGame {
  constructor(onMiss = () => {}, random = Math.random) {
    this.onMiss = onMiss;
    this.random = random;
    this.reset();
  }
  reset() {
    this.player = { x: 0, y: 0, w: 0.29, h: 0.22 };
    this.cpu = { x: 0, y: 0, w: 0.25, h: 0.20 };
    this.target = { x: 0, y: 0 };
    this.ball = { x: 0, y: 0.04, z: 0.55, vx: 0.08, vy: 0.04, vz: 0.95 };
    this.speed = Math.hypot(this.ball.vx, this.ball.vy, this.ball.vz);
    this.initialSpeed = this.speed;
    this.hits = 0;
    this.playerReturns = 0;
    this.incomingVolleys = 0;
    this.points = 0;
    this.running = false;
    this.elapsed = 0;
    this.cpuClock = 0;
    this.cpuAim = { x: 0, y: 0 };
    this.trail = [];
  }
  setTarget(x, y) {
    this.target = { x: clamp(x, -1 + this.player.w, 1 - this.player.w), y: clamp(y, -0.72 + this.player.h, 0.72 - this.player.h) };
  }
  arrivalHint() {
    const b = this.ball;
    if (!this.running || b.vz >= 0 || this.incomingVolleys < 1 || this.incomingVolleys > 3) return null;
    const time = (0.15 - b.z) / b.vz;
    if (time < 0) return null;
    return { x: reflected(b.x + b.vx * time, .955), y: reflected(b.y + b.vy * time, .675), z: .15 };
  }
  aimIncomingBall() {
    // Bias 80% of incoming shots toward a reachable edge. The remaining shots
    // land near the middle, so rallies still vary. Aim at the player's plane
    // rather than increasing sideways velocity, which could bounce back inward.
    let x, y;
    if (this.random() < .8) {
      const edge = Math.floor(this.random() * 4);
      if (edge < 2) {
        x = (edge === 0 ? -1 : 1) * (.78 + this.random() * .1);
        y = (this.random() * 2 - 1) * .42;
      } else {
        y = (edge === 2 ? 1 : -1) * (.55 + this.random() * .07);
        x = (this.random() * 2 - 1) * .62;
      }
    } else {
      x = (this.random() * 2 - 1) * .35;
      y = (this.random() * 2 - 1) * .24;
    }
    const b = this.ball;
    const dx = x - b.x, dy = y - b.y, dz = .15 - b.z;
    const scale = this.speed / Math.hypot(dx, dy, dz);
    b.vx = dx * scale; b.vy = dy * scale; b.vz = dz * scale;
    this.incomingVolleys++;
  }
  bounce(atCpu) {
    const paddle = atCpu ? this.cpu : this.player;
    const b = this.ball;
    // Pace still increases on both paddles' hits. The displayed RETURNS score
    // counts only the player, separately from this speed progression.
    const increment = .1 * 2 ** Math.floor(this.hits / 5);
    this.speed = Math.min(6.8, this.speed + this.initialSpeed * increment);
    if (atCpu) this.aimIncomingBall();
    else {
      b.vx = clamp((b.x - paddle.x) / paddle.w, -1, 1) * this.speed * 0.43;
      b.vy = clamp((b.y - paddle.y) / paddle.h, -1, 1) * this.speed * 0.36;
      b.vz = Math.sqrt(this.speed ** 2 - b.vx ** 2 - b.vy ** 2);
      this.playerReturns++;
    }
    this.hits++;
  }
  update(dt) {
    const blend = 1 - Math.exp(-18 * dt);
    this.player.x += (this.target.x - this.player.x) * blend;
    this.player.y += (this.target.y - this.player.y) * blend;
    if (!this.running) return;
    this.elapsed += dt;
    this.cpuClock -= dt;
    if (this.cpuClock <= 0) {
      this.cpuClock = 0.21;
      const b = this.ball;
      const t = b.vz > 0 ? (5.15 - b.z) / b.vz : 0;
      this.cpuAim = { x: reflected(b.x + b.vx * t, 0.955) + Math.sin(this.elapsed * 1.3) * 0.095,
                      y: reflected(b.y + b.vy * t, 0.675) + Math.cos(this.elapsed * 1.7) * 0.075 };
    }
    for (const axis of ['x', 'y']) this.cpu[axis] += clamp(this.cpuAim[axis] - this.cpu[axis], -0.82 * dt, 0.82 * dt);
    this.cpu.x = clamp(this.cpu.x, -0.75, 0.75);
    this.cpu.y = clamp(this.cpu.y, -0.52, 0.52);
    const steps = Math.max(1, Math.ceil(dt / 0.006));
    const step = dt / steps;
    for (let i = 0; i < steps && this.running; i++) {
      const b = this.ball;
      b.x += b.vx * step; b.y += b.vy * step; b.z += b.vz * step;
      if (Math.abs(b.x) > 0.955) { b.x = Math.sign(b.x) * (1.91 - Math.abs(b.x)); b.vx *= -1; }
      if (Math.abs(b.y) > 0.675) { b.y = Math.sign(b.y) * (1.35 - Math.abs(b.y)); b.vy *= -1; }
      if (b.vz < 0 && b.z <= 0.15) {
        if (Math.abs(b.x - this.player.x) <= this.player.w + 0.045 && Math.abs(b.y - this.player.y) <= this.player.h + 0.045) {
          b.z = 0.3 - b.z; this.bounce(false);
        } else {
          this.running = false;
          this.onMiss({ playerReturns: this.playerReturns, hits: this.hits, points: this.points, multiplier: this.speed / this.initialSpeed });
        }
      } else if (b.vz > 0 && b.z >= 5.15) {
        if (Math.abs(b.x - this.cpu.x) <= this.cpu.w + 0.045 && Math.abs(b.y - this.cpu.y) <= this.cpu.h + 0.045) {
          b.z = 10.3 - b.z; this.bounce(true);
        } else {
          this.points++;
          // A CPU miss serves another incoming ball; it also uses one of the
          // three introductory hints, even though no paddle hit was scored.
          b.x = 0; b.y = 0; b.z = 4.8;
          this.aimIncomingBall();
        }
      }
    }
    this.trail.push({ ...this.ball });
    if (this.trail.length > 12) this.trail.shift();
  }
}

export class CourtRenderer {
  constructor(canvas, { fillViewport = false } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.fillViewport = fillViewport;
    this.width = 0; this.height = 0;
  }
  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (Math.abs(this.width - r.width) > 0.5 || Math.abs(this.height - r.height) > 0.5) {
      this.width = r.width; this.height = r.height;
      this.canvas.width = r.width * dpr; this.canvas.height = r.height * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    if (this.fillViewport) {
      const inset = clamp(Math.min(this.width, this.height) * .025, 12, 24);
      this.scaleX = Math.max(1, this.width / 2 - inset);
      this.scaleY = Math.max(1, (this.height / 2 - inset) / .72);
      this.base = Math.min(this.scaleX, this.scaleY);
      this.cx = this.width / 2; this.cy = this.height / 2;
    } else {
      this.base = Math.min(this.width * 0.43, this.height * 0.56);
      this.scaleX = this.scaleY = this.base;
      this.cx = this.width / 2; this.cy = this.height * 0.49;
    }
  }
  project(x, y, z) {
    const depth = 1 + z * .29;
    return [this.cx + x * this.scaleX / depth, this.cy - y * this.scaleY / depth,
      this.base / depth, this.scaleX / depth, this.scaleY / depth];
  }
  gazeToCourt(x, y) {
    // Calibration uses viewport coordinates. Invert the same projection used
    // to draw the player's paddle, including its slight depth into the court.
    this.resize();
    const r = this.canvas.getBoundingClientRect();
    const depth = 1 + .12 * .29;
    return [(x * window.innerWidth - r.left - this.cx) * depth / this.scaleX,
            -(y * window.innerHeight - r.top - this.cy) * depth / this.scaleY];
  }
  line(points, color, width = 1) {
    const c = this.ctx;
    c.beginPath(); points.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]));
    c.strokeStyle = color; c.lineWidth = width; c.stroke();
  }
  plane(z, color, width = 1) {
    this.line([[-1, -0.72], [-1, 0.72], [1, 0.72], [1, -0.72], [-1, -0.72]].map(([x, y]) => this.project(x, y, z)), color, width);
  }
  paddle(p, z, front) {
    const c = this.ctx, [x, y, , sx, sy] = this.project(p.x, p.y, z);
    c.beginPath(); c.roundRect(x - p.w * sx, y - p.h * sy, 2 * p.w * sx, 2 * p.h * sy, 9);
    c.fillStyle = front ? 'rgba(199, 242, 104, 0.45)' : '#26382f'; c.fill();
    c.lineWidth = front ? 2 : 1; c.strokeStyle = front ? '#477333' : '#16261d'; c.stroke();
    this.line([[x - 7, y], [x + 7, y]], front ? '#345b2c' : '#d2f2b9', 1.5);
    this.line([[x, y - 7], [x, y + 7]], front ? '#345b2c' : '#d2f2b9', 1.5);
  }
  render(game, { demo = false, time = 0, marker = null } = {}) {
    this.resize();
    const c = this.ctx;
    c.clearRect(0, 0, this.width, this.height);
    const gradient = c.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, this.base * 1.6);
    gradient.addColorStop(0, '#f1f8e9'); gradient.addColorStop(1, '#fdfefb');
    c.fillStyle = gradient; c.fillRect(0, 0, this.width, this.height);
    for (let z = 5.2; z >= 0; z -= 0.65) this.plane(z, '#dce3d6');
    for (const x of [-1, 1]) for (const y of [-0.72, 0.72]) this.line([this.project(x, y, 0), this.project(x, y, 5.2)], '#b4c2ac', 1.2);
    this.line([this.project(0, -0.72, 0), this.project(0, -0.72, 5.2)], '#d8e1d2');
    this.plane(5.2, '#a7b69d', 1.5);
    this.paddle(game.cpu, 5.2, false);
    for (let i = 0; i < game.trail.length; i++) {
      const b = game.trail[i], [x, y, s] = this.project(b.x, b.y, b.z);
      c.beginPath(); c.arc(x, y, 0.041 * s * i / game.trail.length, 0, Math.PI * 2);
      c.fillStyle = `rgba(213, 176, 43, ${i / game.trail.length * 0.14})`; c.fill();
    }
    const [bx, by, bs] = this.project(game.ball.x, game.ball.y, game.ball.z);
    c.shadowColor = 'rgba(131, 113, 30, 0.22)'; c.shadowBlur = 18;
    c.beginPath(); c.arc(bx, by, bs * 0.045, 0, Math.PI * 2); c.fillStyle = '#edcc4b'; c.fill();
    c.shadowBlur = 0; c.strokeStyle = '#aa8b21'; c.lineWidth = 1.3; c.stroke();
    this.plane(0, '#84997b', 1.6);
    this.paddle(game.player, 0.12, true);
    const arrival = !demo && game.arrivalHint();
    if (arrival) {
      const [x, y] = this.project(arrival.x, arrival.y, arrival.z);
      const radius = clamp(this.base * .1, 26, 54);
      c.beginPath(); c.arc(x, y, radius, 0, Math.PI * 2);
      c.fillStyle = 'rgba(199, 242, 104, 0.24)'; c.fill();
      c.setLineDash([6, 6]); c.strokeStyle = '#719447'; c.lineWidth = 2; c.stroke(); c.setLineDash([]);
      if (game.incomingVolleys === 1) {
        c.font = '10px ui-monospace, monospace'; c.textAlign = 'center';
        const labelY = y + radius + 18 < this.height - 40 ? y + radius + 18 : y - radius - 12;
        const labelX = clamp(x, 90, this.width - 90);
        const labelWidth = c.measureText('BALL ARRIVES HERE').width + 16;
        c.beginPath(); c.roundRect(labelX - labelWidth / 2, labelY - 12, labelWidth, 18, 5);
        c.fillStyle = 'rgba(253, 254, 251, .94)'; c.fill();
        c.fillStyle = '#4c6e34'; c.fillText('BALL ARRIVES HERE', labelX, labelY);
      }
    }
    if (marker) {
      const r = this.canvas.getBoundingClientRect();
      const x = marker[0] * window.innerWidth - r.left, y = marker[1] * window.innerHeight - r.top;
      c.beginPath(); c.arc(x, y, 4, 0, Math.PI * 2); c.fillStyle = '#446c39'; c.fill();
    }
    c.font = '10px ui-monospace, monospace'; c.textAlign = 'center'; c.fillStyle = '#73816c';
    const far = this.project(0, 0.83, 5.2);
    const near = this.fillViewport ? this.project(0, -.66, 0) : this.project(0, -.87, 0);
    c.fillText('CPU', far[0], far[1]); c.fillText('YOUR PADDLE', near[0], near[1]);
  }
}
