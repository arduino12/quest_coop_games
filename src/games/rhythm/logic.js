// Rhythm Battle: song timing, note chart and scoring. Pure (unit tested).
import { rng } from '../starship/logic.js';

export const BPM = 128;
export const BEAT = 60 / BPM;
export const SONG_BEATS = 192; // ~90 seconds
export const WINDOW = 0.15; // seconds either side of the beat that still count
export const ATTACK_EVERY = 16; // combo needed to send an attack
export const ATTACK_BEATS = 8;
// Lanes: 0 left-high, 1 left-low, 2 right-high, 3 right-low.
export const LANE_HAND = ['left', 'left', 'right', 'right'];

export function judge(dt) {
  const a = Math.abs(dt);
  if (a <= 0.05) return { rating: 'PERFECT', points: 300 };
  if (a <= 0.1) return { rating: 'GREAT', points: 200 };
  if (a <= WINDOW) return { rating: 'GOOD', points: 100 };
  return null;
}

export const multiplier = (combo) => Math.min(4, 1 + Math.floor(combo / 10));

// Density rises through the song: sparse intro, steady verse, busy chorus, dense finale.
export function generateChart(seed) {
  const r = rng(seed);
  const notes = [];
  const lastByHand = { left: -9, right: -9 };
  const add = (beat, lane) => {
    const hand = LANE_HAND[lane];
    if (beat - lastByHand[hand] < 0.5) return;
    lastByHand[hand] = beat;
    notes.push({ beat, lane });
  };
  let hand = 0;
  for (let b = 8; b < SONG_BEATS - 4; b += 0.5) {
    const onBeat = b % 1 === 0;
    let p;
    if (b < 40) p = b % 2 === 0 ? 1 : 0;
    else if (b < 96) p = onBeat ? 0.9 : 0;
    else if (b < 160) p = onBeat ? 1 : 0.35;
    else p = onBeat ? 1 : 0.7;
    if (r() >= p) continue;
    hand = r() < 0.75 ? 1 - hand : hand; // mostly alternate hands
    add(b, hand * 2 + (r() < 0.5 ? 0 : 1));
  }
  return notes;
}

// Extra notes an attack throws into the victim's chart (on the off-beats, so they collide).
export function attackNotes(fromBeat, seed) {
  const r = rng(seed + Math.floor(fromBeat * 2));
  const start = Math.ceil(fromBeat) + 0.5;
  const out = [];
  for (let b = start; b < start + ATTACK_BEATS && b < SONG_BEATS - 4; b += 1) out.push({ beat: b, lane: Math.floor(r() * 4), extra: true });
  return out;
}

// Bass line: one root per bar from a minor pentatonic, repeating every 8 bars.
const PENTA = [0, 3, 5, 7, 10];
export function bassNote(bar, seed) {
  const r = rng(seed + (bar % 8));
  return 45 + PENTA[Math.floor(r() * PENTA.length)]; // MIDI note around A2
}

export const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);
