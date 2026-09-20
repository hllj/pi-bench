const assert = require('assert');
const { total } = require('./src/cart');

const cart = { items: [{ price: 50, qty: 2 }], taxRate: 0.1 };

assert.strictEqual(total(cart, null), 110);
assert.strictEqual(total(cart, { type: 'percent', value: 0.1 }), 99);
// A fixed coupon reduces the pre-tax amount: (100 - 10) * 1.1 = 99
assert.strictEqual(total(cart, { type: 'fixed', value: 10 }), 99);
assert.strictEqual(total({ items: [{ price: 5, qty: 1 }], taxRate: 0 }, { type: 'fixed', value: 10 }), 0);
console.log('ok');
