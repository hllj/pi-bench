const assert = require('assert');
const net = require('./src/net');
const { getUser } = require('./src/users');
const { getOrders, getOrder } = require('./src/orders');
const lib = require('./src/lib');

(async () => {
  assert.strictEqual(typeof net.fetchJson, 'function');
  assert.strictEqual(net['legacy' + 'Fetch'], undefined);
  assert.strictEqual((await getUser(1)).url, '/users/1');
  assert.strictEqual((await getOrders()).url, '/orders');
  assert.strictEqual((await getOrder(2)).url, '/orders/2');
  assert.strictEqual((await lib.ping()).url, '/ping');
  console.log('ok');
})();
