const { legacyFetch } = require('./net');

async function getUser(id) {
  return legacyFetch(`/users/${id}`);
}

module.exports = { getUser };
