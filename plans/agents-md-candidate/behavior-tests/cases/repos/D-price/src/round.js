// Round to whole cents.
function roundCents(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { roundCents };
