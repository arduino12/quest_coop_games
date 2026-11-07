import { describe, it, expect } from 'vitest';
import {
  sizeOf, SIZES, shiftConfig, orderStream, problems, matchOrder, payFor, BAKE_DONE, BAKE_BURNT, TOPPINGS, stars,
} from '../src/games/pizza/logic.js';

const pizzaFor = (o, over = {}) => ({
  dough: o.dough, size: SIZES[o.size], sauce: o.sauce, sauceAmt: 1, cheese: o.cheese, bake: BAKE_DONE + 0.2,
  toppings: Object.entries(o.toppings).flatMap(([t, c]) => Array.from({ length: c }, () => ({ t }))),
  ...over,
});

describe('sizes', () => {
  it('maps a stretched diameter to S / M / L', () => {
    expect(sizeOf(0.26)).toBe('S');
    expect(sizeOf(0.33)).toBe('M');
    expect(sizeOf(0.39)).toBe('L');
    expect(sizeOf(0.2)).toBe(null);
  });
});

describe('orders', () => {
  it('are the same for both players from the same seed', () => {
    const a = orderStream(5), b = orderStream(5);
    expect([a(1), a(2), a(3)]).toEqual([b(1), b(2), b(3)]);
  });
  it('get more demanding in later shifts', () => {
    expect(shiftConfig(3).maxActive).toBeGreaterThan(shiftConfig(1).maxActive);
    expect(shiftConfig(3).every).toBeLessThan(shiftConfig(1).every);
    const first = orderStream(1);
    for (let i = 0; i < 30; i++) {
      const o = first(1);
      expect(o.dough).toBe('classic');
      expect(['S', 'M']).toContain(o.size);
      expect(Object.keys(o.toppings).every((t) => TOPPINGS.includes(t))).toBe(true);
    }
  });
});

describe('checking a pizza', () => {
  const next = orderStream(9);
  const order = next(3);
  it('accepts the exact pizza', () => {
    expect(problems(pizzaFor(order), order)).toEqual([]);
  });
  it('lists every mistake', () => {
    const p = pizzaFor(order, { size: 0.2, bake: 0.4, sauceAmt: 0.3 });
    expect(problems(p, order)).toEqual(expect.arrayContaining(['size', 'raw', 'sauce']));
    expect(problems(pizzaFor(order, { bake: BAKE_BURNT + 0.1 }), order)).toContain('burnt');
    const extra = pizzaFor(order);
    extra.toppings.push({ t: TOPPINGS.find((t) => !(t in order.toppings)) });
    expect(problems(extra, order)).toContain('toppings');
  });
  it('matches the right order out of several and pays a tip for speed', () => {
    const other = next(3);
    const orders = [{ ...other, age: 50 }, { ...order, age: 10 }];
    expect(matchOrder(pizzaFor(order), orders).id).toBe(order.id);
    expect(payFor({ ...order, age: 0 })).toBe(150);
    expect(payFor({ ...order, age: order.timeout })).toBe(100);
  });
  it('rates the shift with stars', () => {
    expect(stars(0)).toBe(0);
    expect(stars(800)).toBe(2);
  });
});
