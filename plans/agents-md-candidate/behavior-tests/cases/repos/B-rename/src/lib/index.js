// Aliased import: the call sites below use `lf`, not the original name.
const { legacyFetch: lf } = require('../net');

module.exports = { ping: () => lf('/ping') };
