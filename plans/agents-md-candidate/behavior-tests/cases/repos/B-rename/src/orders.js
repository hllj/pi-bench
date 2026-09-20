const net = require('./net');

async function getOrders() {
  const r = await net.legacyFetch('/orders');
  return r;
}

async function getOrder(id) {
  return net.legacyFetch(`/orders/${id}`);
}

module.exports = { getOrders, getOrder };
