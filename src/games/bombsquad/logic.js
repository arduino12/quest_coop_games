// Bomb Squad rules: bomb generation, module solutions and the manual text. Pure (unit tested).
//
// One player (the defuser) sees the bomb; the other (the expert) only has the manual.
// Every rule here is written into the manual, so the pair can solve any bomb by talking.

import { rng } from '../starship/logic.js';

export const WIRE_COLORS = ['red', 'blue', 'yellow', 'white', 'black'];
export const BUTTON_COLORS = ['red', 'blue', 'yellow', 'white'];
export const BUTTON_LABELS = ['ABORT', 'HOLD', 'PUSH', 'STOP'];
export const STRIP_COLORS = ['blue', 'yellow', 'red', 'white'];
export const STRIP_DIGIT = { blue: 3, yellow: 6, red: 1, white: 8 };
export const HOLD_S = 0.7; // shorter than this counts as a tap
export const MAX_STRIKES = 3;

export const KEY_COLUMNS = [
  ['Ω', 'Ψ', 'Σ', 'Δ', 'λ', 'ξ', 'π'],
  ['Ж', 'Ω', 'Ф', '★', 'Я', '¶', 'λ'],
  ['Б', '♣', 'Ψ', '★', '♦', '©', 'Ш'],
  ['♠', 'Ю', 'Ф', '¥', '♥', 'Σ', '€'],
  ['¿', '@', '♣', '&', 'Δ', '%', '#'],
  ['∞', '€', '≈', 'π', 'Ш', '@', 'Я'],
];

export const WORDS = [
  'ABOUT', 'AFTER', 'AGAIN', 'BELOW', 'COULD', 'EVERY', 'FIRST', 'FOUND', 'GREAT', 'HOUSE',
  'LARGE', 'LEARN', 'NEVER', 'OTHER', 'PLACE', 'PLANT', 'POINT', 'RIGHT', 'SMALL', 'SOUND',
  'SPELL', 'STILL', 'STUDY', 'THEIR', 'THERE', 'THESE', 'THING', 'THINK', 'THREE', 'WATER',
  'WHERE', 'WHICH', 'WORLD', 'WOULD', 'WRITE',
];

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
// Fisher-Yates with the seeded generator: identical on every browser.
function shuffle(r, arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const count = (arr, v) => arr.filter((x) => x === v).length;
const lastIndex = (arr, v) => arr.lastIndexOf(v);

export const serialOdd = (serial) => Number(serial[serial.length - 1]) % 2 === 1;
export const serialHasVowel = (serial) => /[AEIOU]/.test(serial);

export function makeSerial(r) {
  let s = '';
  for (let i = 0; i < 5; i++) s += pick(r, r() < 0.5 ? LETTERS.split('') : '0123456789'.split(''));
  return s + Math.floor(r() * 10);
}

// ---- wires ----
export function wireToCut(wires, serial) {
  const n = wires.length;
  const odd = serialOdd(serial);
  const last = wires[n - 1];
  if (n === 3) {
    if (!wires.includes('red')) return 1;
    if (last === 'white') return 2;
    if (count(wires, 'blue') >= 2) return lastIndex(wires, 'blue');
    return 0;
  }
  if (n === 4) {
    if (count(wires, 'red') >= 2 && odd) return lastIndex(wires, 'red');
    if (!wires.includes('yellow')) return 2;
    if (count(wires, 'blue') === 1) return 0;
    return 3;
  }
  if (n === 5) {
    if (last === 'black' && !odd) return 3;
    if (count(wires, 'red') === 1 && count(wires, 'yellow') >= 2) return 0;
    if (!wires.includes('black')) return 1;
    return 4;
  }
  if (!wires.includes('yellow') && odd) return 2;
  if (count(wires, 'yellow') === 1 && count(wires, 'white') >= 2) return 3;
  if (!wires.includes('red')) return 5;
  return 4;
}

// ---- button ----
export function buttonAction(color, label, serial) {
  if (color === 'blue' && label === 'ABORT') return 'hold';
  if (color === 'red' && label === 'HOLD') return 'tap';
  if (label === 'STOP' && !serialOdd(serial)) return 'tap';
  if (color === 'white') return 'hold';
  if (label === 'PUSH' && serialHasVowel(serial)) return 'hold';
  return 'tap';
}

// ---- keypad ----
export function keypadOrder(symbols) {
  const col = KEY_COLUMNS.find((c) => symbols.every((s) => c.includes(s)));
  return [...symbols].sort((a, b) => col.indexOf(a) - col.indexOf(b));
}

function makeKeypad(r) {
  for (;;) {
    const col = pick(r, KEY_COLUMNS);
    const syms = [];
    while (syms.length < 4) {
      const s = pick(r, col);
      if (!syms.includes(s)) syms.push(s);
    }
    const matches = KEY_COLUMNS.filter((c) => syms.every((s) => c.includes(s)));
    if (matches.length === 1) return { type: 'keypad', symbols: syms };
  }
}

// ---- password ----
export function formableWords(columns) {
  return WORDS.filter((w) => w.split('').every((ch, i) => columns[i].includes(ch)));
}

function makePassword(r) {
  const word = pick(r, WORDS);
  for (;;) {
    const columns = word.split('').map((ch) => {
      const set = [ch];
      while (set.length < 6) {
        const l = pick(r, LETTERS.split(''));
        if (!set.includes(l)) set.push(l);
      }
      return shuffle(r, set);
    });
    if (formableWords(columns).length === 1) return { type: 'password', columns, word };
  }
}

export function makeModule(type, r) {
  if (type === 'wires') {
    const n = 3 + Math.floor(r() * 4);
    return { type, wires: Array.from({ length: n }, () => pick(r, WIRE_COLORS)) };
  }
  if (type === 'button') return { type, color: pick(r, BUTTON_COLORS), label: pick(r, BUTTON_LABELS), strip: pick(r, STRIP_COLORS) };
  if (type === 'keypad') return makeKeypad(r);
  return makePassword(r);
}

export function bombConfig(level) {
  const modules = Math.min(2 + level, 6);
  return { modules, time: 120 + modules * 40 };
}

export function generateBomb(level, seed) {
  const r = rng(seed);
  const cfg = bombConfig(level);
  const types = ['wires', 'button', 'keypad', 'password'];
  const order = shuffle(r, types);
  const modules = [];
  for (let i = 0; i < cfg.modules; i++) modules.push(makeModule(i < 4 ? order[i] : pick(r, types), r));
  return { level, serial: makeSerial(r), time: cfg.time, modules };
}

// Fresh per-module progress.
export function initialState(bomb) {
  return bomb.modules.map(() => ({ solved: false, cut: [], progress: 0 }));
}

// Applies one defuser action. Returns 'solve', 'ok' (progress) or 'strike'.
// Actions: { cut: i } | { tap: true } | { held: seconds, digit } | { press: symbol } | { word: 'ABCDE' }
export function applyAction(bomb, state, m, action) {
  const mod = bomb.modules[m];
  const st = state[m];
  if (!mod || !st || st.solved) return 'ok';
  if (mod.type === 'wires') {
    if (st.cut.includes(action.cut)) return 'ok';
    st.cut.push(action.cut);
    if (action.cut === wireToCut(mod.wires, bomb.serial)) { st.solved = true; return 'solve'; }
    return 'strike';
  }
  if (mod.type === 'button') {
    const rule = buttonAction(mod.color, mod.label, bomb.serial);
    const held = action.held ?? 0;
    const ok = rule === 'tap' ? held < HOLD_S : held >= HOLD_S && action.digit === STRIP_DIGIT[mod.strip];
    if (ok) { st.solved = true; return 'solve'; }
    return 'strike';
  }
  if (mod.type === 'keypad') {
    const order = keypadOrder(mod.symbols);
    if (action.press !== order[st.progress]) return 'strike';
    st.progress++;
    if (st.progress >= 4) { st.solved = true; return 'solve'; }
    return 'ok';
  }
  if (action.word === mod.word) { st.solved = true; return 'solve'; }
  return 'strike';
}

// ---- the manual (what the expert reads) ----
export const MANUAL = {
  Basics: [
    'You are the EXPERT. Only the defuser can see the bomb; only you have this manual. Talk!',
    'The bomb has several modules. Solve every module before the timer reaches zero.',
    'Every mistake is a strike. The third strike explodes the bomb.',
    'The serial number is printed on the bomb. Some rules need its LAST DIGIT (odd or even) or whether it contains a VOWEL (A, E, I, O, U).',
    'Pick a page below for each module the defuser describes.',
  ],
  Wires: [
    'Count the wires (3 to 6), top to bottom. Cut exactly one.',
    '3 WIRES: no red wire: cut the 2nd. Else, last wire white: cut the last. Else, 2+ blue: cut the last blue. Else cut the 1st.',
    '4 WIRES: 2+ red and serial odd: cut the last red. Else, no yellow: cut the 3rd. Else, exactly one blue: cut the 1st. Else cut the last.',
    '5 WIRES: last wire black and serial even: cut the 4th. Else, exactly one red and 2+ yellow: cut the 1st. Else, no black: cut the 2nd. Else cut the last.',
    '6 WIRES: no yellow and serial odd: cut the 3rd. Else, exactly one yellow and 2+ white: cut the 4th. Else, no red: cut the last. Else cut the 5th.',
  ],
  Button: [
    'Go down this list and follow the FIRST rule that matches:',
    '1. Blue button that says ABORT: HOLD it.   2. Red button that says HOLD: TAP it.',
    '3. Says STOP and the serial is even: TAP it.   4. White button: HOLD it.',
    '5. Says PUSH and the serial has a vowel: HOLD it.   6. Otherwise: TAP it.',
    'TAP = press and let go right away. HOLD = keep pressing: a colored strip lights up. Let go when the LAST DIGIT of the timer is:',
    'BLUE strip: 3     YELLOW strip: 6     RED strip: 1     WHITE strip: 8',
  ],
  Keypad: [
    'Four keys with symbols. Exactly one column below holds all four. Press the keys in the order they appear in that column, top to bottom.',
    ...KEY_COLUMNS.map((c, i) => `Column ${i + 1}:   ${c.join('   ')}`),
  ],
  Password: [
    'Five letter wheels; each can show 6 letters. Exactly one word from this list can be spelled. Set the wheels to it and press OK.',
    WORDS.join('  '),
  ],
};
