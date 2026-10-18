import { describe, it, expect } from 'vitest';
import { distPointSeg, distSegSeg, segHitsBody, sphereHitsBody } from '../src/core/geom.js';

describe('distances', () => {
  it('point to segment, including past the ends', () => {
    expect(distPointSeg([0, 1, 0], [-1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(distPointSeg([3, 0, 0], [-1, 0, 0], [1, 0, 0])).toBeCloseTo(2);
  });
  it('segment to segment: crossing, parallel, and apart', () => {
    expect(distSegSeg([-1, 0, 0], [1, 0, 0], [0, -1, 0.5], [0, 1, 0.5])).toBeCloseTo(0.5);
    expect(distSegSeg([0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0])).toBeCloseTo(1);
    expect(distSegSeg([0, 0, 0], [1, 0, 0], [3, 0, 0], [4, 0, 0])).toBeCloseTo(2);
  });
});

describe('body hits', () => {
  const head = [0, 1.6, 0];
  it('a blade through the head or chest hits, one beside the body misses', () => {
    expect(segHitsBody([-0.5, 1.6, 0], [0.5, 1.6, 0], head)).toBe('head');
    expect(segHitsBody([-0.5, 1.1, 0], [0.5, 1.1, 0], head)).toBe('torso');
    expect(segHitsBody([0.5, 1.1, 0], [1.2, 1.1, 0], head)).toBe(null);
  });
  it('a ball hits when it touches the head or torso', () => {
    expect(sphereHitsBody([0.2, 1.6, 0], 0.13, head)).toBe('head');
    expect(sphereHitsBody([0, 1.0, 0.25], 0.13, head)).toBe('torso');
    expect(sphereHitsBody([0, 1.0, 0.6], 0.13, head)).toBe(null);
  });
});
