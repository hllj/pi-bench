function addTax(amount, rate) {
  return amount * (1 + (rate || 0));
}

module.exports = { addTax };
