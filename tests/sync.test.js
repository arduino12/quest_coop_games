import { describe, it, expect } from 'vitest';
import { ClockSync, SnapshotBuffer, EntityBuffer, interpolate } from '../src/core/sync.js';

describe('ClockSync', () => {
  it('keeps the smallest observed offset', () => {
    const c = new ClockSync(0);
    c.update(1000, 5050); // 50 ms trip
    c.update(1100, 5130); // 30 ms trip: better estimate
    c.update(1200, 5290); // 90 ms trip: jitter, ignored
    expect(c.offset).toBe(4030);
    expect(c.remoteNow(5300)).toBe(1270);
  });

  it('relaxes upward slowly so a drifting clock recovers', () => {
    const c = new ClockSync(0.001);
    c.update(0, 100);
    c.update(10000, 10200); // 10 s later the true offset is 200
    expect(c.offset).toBeCloseTo(110.1, 5); // 100 + 10100 ms * 0.001
  });
});

describe('interpolate', () => {
  it('lerps positions and nlerps quaternions along the short path', () => {
    const a = [0, 0, 0, 0, 0, 0, 1];
    const b = [2, 4, 6, 0, 0, 0, -1]; // same rotation, opposite sign
    const out = interpolate([], a, b, 0.5, 7, 3);
    expect(out.slice(0, 3)).toEqual([1, 2, 3]);
    expect(out[6]).toBeCloseTo(1);
    expect(Math.hypot(out[3], out[4], out[5], out[6])).toBeCloseTo(1);
  });
});

describe('SnapshotBuffer', () => {
  it('interpolates between the bracketing snapshots and clamps outside', () => {
    const buf = new SnapshotBuffer({ stride: 2, quatOffset: -1 });
    buf.push(100, [0, 0]);
    buf.push(200, [10, 20]);
    buf.push(300, [20, 40]);
    expect(buf.sample(250)).toEqual([15, 30]);
    expect(buf.sample(50)).toEqual([0, 0]);
    expect(buf.sample(999)).toEqual([20, 40]);
  });

  it('drops out-of-order packets', () => {
    const buf = new SnapshotBuffer({ stride: 1, quatOffset: -1 });
    expect(buf.push(200, [2])).toBe(true);
    expect(buf.push(150, [1])).toBe(false);
    expect(buf.size).toBe(1);
  });
});

describe('EntityBuffer', () => {
  it('interpolates shared ids, shows new ids, drops removed ids', () => {
    const buf = new EntityBuffer();
    buf.push(0, [[1, 0, 0], [2, 5, 5]]);
    buf.push(100, [[1, 10, 0], [3, 7, 7]]);
    const m = buf.sample(50);
    expect(m.get(1)).toEqual([5, 0]);
    expect(m.get(3)).toEqual([7, 7]);
    expect(m.has(2)).toBe(false);
  });
});
