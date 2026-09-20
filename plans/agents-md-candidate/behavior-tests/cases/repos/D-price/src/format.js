// 1234567.89 -> "$1,234,567.89"
function formatUSD(n) {
  const [whole, frac] = n.toFixed(2).split('.');
  return '$' + whole.replace(/(\d{3})(?=\d)/g, '$1,') + '.' + frac;
}

module.exports = { formatUSD };
