import { describe, it, expect } from 'vitest';
import {
  toWorldPos, toLocalPos, launchVelocity, MAX_SPEED, cubeRotations, nearestAxisQuat, qAxis, distToBox,
  ownerOfId, timeoutWinner, trajectory, onIsland, ISLAND,
} from '../src/games/fortsiege/logic.js';

describe('island frames', () => {
  it('round-trips local <-> world for both sides', () => {
    for (const side of ['host', 'guest']) {
      const w = toWorldPos(side, [1, 2, -1.5]);
      const l = toLocalPos(side, w);
      expect(l[0]).toBeCloseTo(1);
      expect(l[1]).toBeCloseTo(2);
      expect(l[2]).toBeCloseTo(-1.5);
    }
  });

  it('puts local -z (the fort side) toward the enemy', () => {
    expect(toWorldPos('host', [0, 0, -1])[2]).toBeLessThan(ISLAND.dist);
    expect(toWorldPos('guest', [0, 0, -1])[2]).toBeGreaterThan(-ISLAND.dist);
  });

  it('knows what is still on an island', () => {
    expect(onIsland('host', toWorldPos('host', [1, 0.2, 1]))).toBe(true);
    expect(onIsland('host', toWorldPos('host', [5, 0.2, 1]))).toBe(false);
    expect(onIsland('guest', toWorldPos('guest', [0, -3, 0]))).toBe(false);
  });
});

describe('slingshot', () => {
  it('launches opposite to the pull, capped at max speed', () => {
    const v = launchVelocity([0, 1.3, 15], [0, 1.0, 17]);
    expect(v[2]).toBeLessThan(0);
    expect(v[1]).toBeGreaterThan(0);
    expect(Math.hypot(...v)).toBeCloseTo(MAX_SPEED);
  });

  it('ignores tiny pulls', () => {
    expect(launchVelocity([0, 1, 0], [0, 1, 0.05])).toBe(null);
  });

  it('predicts a falling arc', () => {
    const pts = trajectory([0, 1, 0], [0, 10, -10], 30, 0.1);
    const ys = pts.map((p) => p[1]);
    expect(Math.max(...ys)).toBeGreaterThan(5);
    expect(ys[ys.length - 1]).toBeLessThan(ys[5]);
  });
});

describe('rotation snapping', () => {
  it('has exactly 24 axis-aligned orientations', () => {
    expect(cubeRotations()).toHaveLength(24);
  });

  it('snaps a slightly tilted block and leaves a 45 degree one alone', () => {
    const tilted = qAxis([0, 0, 1], (10 * Math.PI) / 180);
    const snapped = nearestAxisQuat(tilted);
    expect(Math.abs(snapped[3])).toBeCloseTo(1);
    expect(nearestAxisQuat(qAxis([0, 1, 0], Math.PI / 4))).toBe(null);
  });
});

describe('distToBox', () => {
  it('is zero inside and the gap outside, respecting rotation', () => {
    const q = qAxis([0, 1, 0], Math.PI / 2); // plank rotated 90 deg: long axis now along z
    const half = [0.6, 0.1, 0.2];
    expect(distToBox([0, 0, 0.5], [0, 0, 0], q, half)).toBeCloseTo(0);
    expect(distToBox([0.5, 0, 0], [0, 0, 0], q, half)).toBeCloseTo(0.3);
  });
});

describe('rules', () => {
  it('maps ids to owners', () => {
    expect(ownerOfId(1)).toBe('host');
    expect(ownerOfId(2)).toBe('guest');
    expect(ownerOfId(1007)).toBe('host');
    expect(ownerOfId(2003)).toBe('guest');
    expect(ownerOfId(5001)).toBe('neutral');
  });

  it('decides a timeout by blocks left standing', () => {
    expect(timeoutWinner({ host: 10, guest: 4 })).toBe('host');
    expect(timeoutWinner({ host: 3, guest: 4 })).toBe('guest');
    expect(timeoutWinner({ host: 5, guest: 5 })).toBe('draw');
  });
});
