import { describe, it, expect } from 'vitest';
import { T, stepBall, paddleHit, cubeHit, CUBE_HALF, newBall, baseSpeed, MIN_FORWARD, sideOf } from '../src/games/handball/logic.js';

const liveBall = (p, v) => ({ p, v, hits: 0, live: true, server: 'host' });

describe('stepBall', () => {
  it('bounces off the side walls', () => {
    const b = liveBall([T.halfW - T.ballR - 0.01, 1, 0], [2, 0, 0]);
    const ev = stepBall(b, 0.1);
    expect(ev.bounce).toBe(true);
    expect(b.v[0]).toBeLessThan(0);
    expect(b.p[0]).toBeLessThanOrEqual(T.halfW - T.ballR);
  });

  it('keeps the ball between the raised floor and the lowered ceiling', () => {
    const low = liveBall([0, T.floorY + T.ballR + 0.01, 0], [0, -3, 1]);
    stepBall(low, 0.1);
    expect(low.v[1]).toBeGreaterThan(0);
    expect(low.p[1]).toBeGreaterThanOrEqual(T.floorY + T.ballR);
    const high = liveBall([0, T.ceilY - T.ballR - 0.01, 0], [0, 3, 1]);
    stepBall(high, 0.1);
    expect(high.v[1]).toBeLessThan(0);
    expect(high.p[1]).toBeLessThanOrEqual(T.ceilY - T.ballR);
  });

  it('reports which back wall the ball passed', () => {
    expect(stepBall(liveBall([0, 1, T.halfL - 0.01], [0, 0, 5]), 0.1).goal).toBe('host');
    expect(stepBall(liveBall([0, 1, -T.halfL + 0.01], [0, 0, -5]), 0.1).goal).toBe('guest');
  });

  it('turns the guest end into a wall in practice mode', () => {
    const b = liveBall([0, 1, -T.halfL + 0.01], [0, 0, -5]);
    const ev = stepBall(b, 0.1, true);
    expect(ev.goal).toBe(null);
    expect(b.v[2]).toBeGreaterThan(0);
  });

  it('gives the same path however the time is sliced (both players agree)', () => {
    const a = liveBall([0.3, 1.0, 5], [7.3, -5.1, -6.2]);
    const b = liveBall([0.3, 1.0, 5], [7.3, -5.1, -6.2]);
    for (let i = 0; i < 100; i++) stepBall(a, 0.01);
    for (let i = 0; i < 72; i++) stepBall(b, 1 / 72);
    for (let k = 0; k < 3; k++) expect(a.p[k]).toBeCloseTo(b.p[k], 9);
  });

  it('does not move a ball that is waiting to be served', () => {
    const b = newBall('host');
    const before = b.p.slice();
    stepBall(b, 1);
    expect(b.p).toEqual(before);
  });
});

describe('paddleHit', () => {
  it('misses when the hand is far away', () => {
    const b = liveBall([0, 1, 5], [0, 0, 5]);
    expect(paddleHit(b, [1, 1, 5], [0, 0, 0], 'host')).toBe(false);
  });

  it('sends the ball back toward the opponent at least at base speed', () => {
    const b = liveBall([0, 1.2, 5.0], [0, 0, 6]); // coming at the host
    const hit = paddleHit(b, [0, 1.2, 5.2], [0, 0, -2], 'host');
    expect(hit).toBe(true);
    const speed = Math.hypot(...b.v);
    expect(speed).toBeGreaterThanOrEqual(baseSpeed(0) - 1e-9);
    expect(b.v[2]).toBeLessThan(0);
    expect(-b.v[2] / speed).toBeGreaterThanOrEqual(MIN_FORWARD - 1e-9);
  });

  it('steers a sideways swipe so it still goes forward', () => {
    const b = liveBall([0, 1.2, 5.0], [0, 0, 6]);
    paddleHit(b, [-0.2, 1.2, 5.0], [8, 0, 0], 'host');
    expect(-b.v[2] / Math.hypot(...b.v)).toBeGreaterThanOrEqual(MIN_FORWARD - 1e-9);
  });

  it('ignores contact when already separating', () => {
    const b = liveBall([0, 1.2, 5.0], [0, 0, -6]); // moving away from the host's hand
    expect(paddleHit(b, [0, 1.2, 5.2], [0, 0, 0], 'host')).toBe(false);
  });

  it('serves: a moving hand makes the floating ball live', () => {
    const b = newBall('guest');
    const hit = paddleHit(b, [b.p[0], b.p[1], b.p[2] - 0.2], [0, 0, 3], 'guest');
    expect(hit).toBe(true);
    expect(b.live).toBe(true);
    expect(b.v[2]).toBeGreaterThan(0);
    expect(sideOf(b.p[2])).toBe('guest');
  });
});

describe('cubeHit', () => {
  const flat = [0, 0, 0, 1];
  it('bounces off the front face of a cube held level', () => {
    const b = liveBall([0, 1.2, 5.0 - CUBE_HALF - 0.05], [0, 0, 6]);
    expect(cubeHit(b, [0, 1.2, 5.0], flat, [0, 0, -1], 'host')).toBe(true);
    expect(b.v[2]).toBeLessThan(0);
    expect(b.p[2]).toBeLessThanOrEqual(5.0 - CUBE_HALF - T.ballR + 1e-9);
  });
  it('misses when the ball is beyond the corner', () => {
    const b = liveBall([CUBE_HALF + T.ballR + 0.05, 1.2, 5.0], [0, 0, 6]);
    expect(cubeHit(b, [0, 1.2, 5.0], flat, [0, 0, 0], 'host')).toBe(false);
  });
  it('a cube turned 45 degrees still reaches a ball at its corner', () => {
    const s = Math.sin(Math.PI / 8), c = Math.cos(Math.PI / 8);
    const q = [0, s, 0, c]; // 45 degrees about y: a corner now points at -z
    const b = liveBall([0, 1.2, 5.0 - CUBE_HALF * Math.SQRT2 - 0.05], [0, 0, 6]);
    expect(cubeHit(b, [0, 1.2, 5.0], q, [0, 0, -1], 'host')).toBe(true);
  });
  it('pushes a ball that ended up inside the cube back out', () => {
    const b = liveBall([0, 1.2, 4.97], [0, 0, 6]);
    expect(cubeHit(b, [0, 1.2, 5.0], flat, [0, 0, -2], 'host')).toBe(true);
    expect(Math.abs(b.p[2] - 5.0)).toBeGreaterThanOrEqual(CUBE_HALF + T.ballR - 1e-9);
  });
});
