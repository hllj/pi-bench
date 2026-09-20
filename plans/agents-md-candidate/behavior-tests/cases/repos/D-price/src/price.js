const { parseAmount } = require('./parse');
const { roundCents } = require('./round');
const { formatUSD } = require('./format');

function priceLabel(input) {
  return formatUSD(roundCents(parseAmount(input)));
}

module.exports = { priceLabel };
