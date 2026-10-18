import { describe, it, expect } from 'vitest';
import { judge, multiplier, generateChart, attackNotes, LANE_HAND, SONG_BEATS, midiHz } from '../src/games/rhythm/logic.js';

describe('timing', () => {
  it('rates hits by how close to the beat they are', () => {
    expect(judge(0.02).rating).toBe('PERFECT');
    expect(judge(-0.08).rating).toBe('GREAT');
    expect(judge(0.14).rating).toBe('GOOD');
    expect(judge(0.2)).toBe(null);
  });
  it('combo multiplier grows to x4', () => {
    expect(multiplier(0)).toBe(1);
    expect(multiplier(25)).toBe(3);
    expect(multiplier(100)).toBe(4);
  });
});

describe('chart', () => {
  const chart = generateChart(99);
  it('is identical for both players', () => {
    expect(generateChart(99)).toEqual(chart);
  });
  it('stays inside the song and gets denser toward the end', () => {
    expect(chart.every((n) => n.beat >= 8 && n.beat < SONG_BEATS)).toBe(true);
    const early = chart.filter((n) => n.beat < 40).length / 32;
    const late = chart.filter((n) => n.beat >= 160).length / 28;
    expect(late).toBeGreaterThan(early * 2);
  });
  it('never asks one hand for two notes closer than half a beat', () => {
    const last = { left: -9, right: -9 };
    for (const n of chart) {
      const h = LANE_HAND[n.lane];
      expect(n.beat - last[h]).toBeGreaterThanOrEqual(0.5);
      last[h] = n.beat;
    }
  });
  it('attacks add off-beat notes after the current beat', () => {
    const extra = attackNotes(50.2, 99);
    expect(extra.length).toBeGreaterThan(0);
    expect(extra.every((n) => n.beat > 50.2 && n.beat % 1 === 0.5)).toBe(true);
  });
  it('tunes notes correctly', () => {
    expect(midiHz(69)).toBeCloseTo(440);
    expect(midiHz(57)).toBeCloseTo(220);
  });
});
