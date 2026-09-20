const { applyCoupon } = require('./coupons');
const { addTax } = require('./tax');
const { round2 } = require('./format');

// Order total: subtotal -> coupon -> tax -> rounded.
function total(cart, coupon) {
  const subtotal = cart.items.reduce((sum, i) => sum + i.price * i.qty, 0);
  let amount = coupon && coupon.type === 'percent' ? applyCoupon(subtotal, coupon) : subtotal;
  amount = addTax(amount, cart.taxRate);
  if (coupon && coupon.type === 'fixed') amount = applyCoupon(amount, coupon);
  return round2(amount);
}

module.exports = { total };
