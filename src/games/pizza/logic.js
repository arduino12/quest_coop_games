// Pizza Rush rules: orders, matching a pizza to an order, baking and scoring. Pure (unit tested).
import { rng } from '../starship/logic.js';

export const DOUGHS = ['classic', 'wholewheat', 'charcoal'];
export const SAUCES = ['tomato', 'white'];
export const TOPPINGS = ['pepperoni', 'mushroom', 'olive', 'pepper', 'onion', 'pineapple'];
// Target diameters (m) the dough must be stretched to.
export const SIZES = { S: 0.26, M: 0.32, L: 0.38 };
export const SIZE_TOL = 0.025;
export const DOUGH_START = 0.16;
export const SAUCE_NEEDED = 0.7;
export const BAKE_DONE = 1; // bake reaches 1 after BAKE_TIME seconds in the oven
export const BAKE_BURNT = 1.8;
export const BAKE_TIME = 9;
export const SHIFT_TIME = 240;

export function sizeOf(diameter) {
  for (const [k, d] of Object.entries(SIZES)) if (Math.abs(diameter - d) <= SIZE_TOL) return k;
  return null;
}

// Shift n gets busier: more topping kinds, bigger counts, all doughs and sauces, faster orders.
export function shiftConfig(n) {
  return {
    every: Math.max(16, 32 - n * 4), // seconds between new orders
    maxActive: Math.min(2 + n, 5),
    timeout: Math.max(60, 95 - n * 8), // seconds before an order walks out
    kinds: Math.min(1 + n, 4),
    maxCount: Math.min(2 + n, 6),
    doughs: n >= 2 ? DOUGHS : ['classic'],
    sauces: n >= 2 ? SAUCES : ['tomato'],
    sizes: n >= 2 ? ['S', 'M', 'L'] : ['S', 'M'],
  };
}

export function makeOrder(r, n, id) {
  const cfg = shiftConfig(n);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const toppings = {};
  const kinds = 1 + Math.floor(r() * cfg.kinds);
  while (Object.keys(toppings).length < kinds) toppings[pick(TOPPINGS)] = 2 + Math.floor(r() * (cfg.maxCount - 1));
  return {
    id,
    dough: pick(cfg.doughs),
    size: pick(cfg.sizes),
    sauce: pick(cfg.sauces),
    cheese: r() < 0.85,
    toppings,
    timeout: cfg.timeout,
  };
}

export function orderText(o) {
  const tops = Object.entries(o.toppings).map(([t, c]) => `${t} ×${c}`).join(', ');
  return `${o.size} · ${o.dough} · ${o.sauce}${o.cheese ? ' · cheese' : ''}\n${tops}`;
}

export function countToppings(pizza) {
  const c = {};
  for (const t of pizza.toppings) c[t.t] = (c[t.t] || 0) + 1;
  return c;
}

// What is wrong with this pizza for this order ([] means it's right).
export function problems(pizza, order) {
  const out = [];
  if (pizza.dough !== order.dough) out.push('dough');
  if (sizeOf(pizza.size) !== order.size) out.push('size');
  if (pizza.sauce !== order.sauce || pizza.sauceAmt < SAUCE_NEEDED) out.push('sauce');
  if (order.cheese !== pizza.cheese) out.push('cheese');
  const c = countToppings(pizza);
  for (const t of TOPPINGS) if ((c[t] || 0) !== (order.toppings[t] || 0)) { out.push('toppings'); break; }
  if (pizza.bake < BAKE_DONE) out.push('raw');
  if (pizza.bake >= BAKE_BURNT) out.push('burnt');
  return out;
}

// Best order for a served pizza: the one it fully matches (oldest first), else null.
export function matchOrder(pizza, orders) {
  return [...orders].sort((a, b) => a.age - b.age).reverse().find((o) => problems(pizza, o).length === 0) || null;
}

export function payFor(order) {
  const tip = Math.max(0, Math.round((1 - order.age / order.timeout) * 50));
  return 100 + tip;
}

export const PENALTY = { wrong: 20, expired: 30 };
export const stars = (score) => (score >= 1200 ? 3 : score >= 700 ? 2 : score >= 300 ? 1 : 0);

export function orderStream(seed) {
  const r = rng(seed);
  let id = 1;
  return (n) => makeOrder(r, n, id++);
}
