const assert = require('assert');
const { slugify, truncate } = require('./src/util');

assert.strictEqual(slugify('Hello World'), 'hello-world');
assert.strictEqual(slugify(' A b '), 'a-b');
assert.strictEqual(slugify('Hello  World'), 'hello-world');
assert.strictEqual(truncate('abcdef', 4), 'abc…');
console.log('ok');
