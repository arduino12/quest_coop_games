import { describe, it, expect } from 'vitest';
import {
  wireToCut, buttonAction, keypadOrder, formableWords, generateBomb, initialState, applyAction,
  KEY_COLUMNS, STRIP_DIGIT, MANUAL,
} from '../src/games/bombsquad/logic.js';

describe('wires', () => {
  it('follows the 3-wire rules', () => {
    expect(wireToCut(['blue', 'blue', 'white'], 'AB12C4')).toBe(1); // no red
    expect(wireToCut(['red', 'blue', 'white'], 'AB12C4')).toBe(2); // last white
    expect(wireToCut(['blue', 'red', 'blue'], 'AB12C4')).toBe(2); // last blue
    expect(wireToCut(['red', 'yellow', 'black'], 'AB12C4')).toBe(0);
  });
  it('uses the serial number for 4 wires', () => {
    expect(wireToCut(['red', 'blue', 'red', 'yellow'], 'AB12C3')).toBe(2); // odd -> last red
    expect(wireToCut(['red', 'blue', 'red', 'yellow'], 'AB12C4')).toBe(0); // even -> one blue -> first
  });
  it('covers 5 and 6 wires', () => {
    expect(wireToCut(['red', 'blue', 'white', 'blue', 'black'], 'X00002')).toBe(3);
    expect(wireToCut(['red', 'blue', 'white', 'blue', 'blue'], 'X00002')).toBe(1);
    expect(wireToCut(['red', 'blue', 'white', 'blue', 'black', 'white'], 'X00001')).toBe(2);
    expect(wireToCut(['blue', 'blue', 'white', 'blue', 'black', 'white'], 'X00002')).toBe(5);
  });
});

describe('button', () => {
  it('takes the first matching rule', () => {
    expect(buttonAction('blue', 'ABORT', 'X00001')).toBe('hold');
    expect(buttonAction('red', 'HOLD', 'X00001')).toBe('tap');
    expect(buttonAction('white', 'STOP', 'X00002')).toBe('tap'); // rule 3 before rule 4
    expect(buttonAction('white', 'STOP', 'X00001')).toBe('hold');
    expect(buttonAction('yellow', 'PUSH', 'AXXXX1')).toBe('hold');
    expect(buttonAction('yellow', 'PUSH', 'XXXXX1')).toBe('tap');
  });
});

describe('keypad', () => {
  it('orders by the one column holding all four symbols', () => {
    const col = KEY_COLUMNS[0];
    expect(keypadOrder([col[5], col[1], col[3], col[0]])).toEqual([col[0], col[1], col[3], col[5]]);
  });
});

describe('generated bombs', () => {
  it('are identical for the same seed and always solvable', () => {
    for (let seed = 1; seed < 40; seed++) {
      const a = generateBomb(3, seed);
      expect(generateBomb(3, seed)).toEqual(a);
      for (const m of a.modules) {
        if (m.type === 'keypad') expect(KEY_COLUMNS.filter((c) => m.symbols.every((s) => c.includes(s)))).toHaveLength(1);
        if (m.type === 'password') expect(formableWords(m.columns)).toEqual([m.word]);
      }
    }
  });

  it('get more modules on higher levels', () => {
    expect(generateBomb(1, 5).modules.length).toBe(3);
    expect(generateBomb(4, 5).modules.length).toBe(6);
  });

  it('solve each module with the manual answer and strike on mistakes', () => {
    for (let seed = 1; seed < 30; seed++) {
      const bomb = generateBomb(2, seed);
      const st = initialState(bomb);
      bomb.modules.forEach((m, i) => {
        if (m.type === 'wires') {
          const right = wireToCut(m.wires, bomb.serial);
          const wrong = (right + 1) % m.wires.length;
          expect(applyAction(bomb, st, i, { cut: wrong })).toBe('strike');
          expect(applyAction(bomb, st, i, { cut: right })).toBe('solve');
        } else if (m.type === 'button') {
          const rule = buttonAction(m.color, m.label, bomb.serial);
          const action = rule === 'tap' ? { held: 0.2 } : { held: 2, digit: STRIP_DIGIT[m.strip] };
          expect(applyAction(bomb, st, i, action)).toBe('solve');
        } else if (m.type === 'keypad') {
          const order = keypadOrder(m.symbols);
          expect(applyAction(bomb, st, i, { press: order[1] })).toBe('strike');
          for (let k = 0; k < 3; k++) expect(applyAction(bomb, st, i, { press: order[k] })).toBe('ok');
          expect(applyAction(bomb, st, i, { press: order[3] })).toBe('solve');
        } else {
          expect(applyAction(bomb, st, i, { word: 'XXXXX' })).toBe('strike');
          expect(applyAction(bomb, st, i, { word: m.word })).toBe('solve');
        }
      });
      expect(st.every((s) => s.solved)).toBe(true);
    }
  });

  it('has a manual page for every module type', () => {
    for (const k of ['Wires', 'Button', 'Keypad', 'Password']) expect(MANUAL[k].length).toBeGreaterThan(1);
  });
});
