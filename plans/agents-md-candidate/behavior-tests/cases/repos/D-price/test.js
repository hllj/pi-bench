const assert = require('assert');
const { priceLabel } = require('./src/price');

assert.strictEqual(priceLabel('1,234.5'), '$1,234.50');
assert.strictEqual(priceLabel('1.005'), '$1.01');
assert.strictEqual(priceLabel('1234567.891'), '$1,234,567.89');
console.log('ok');
