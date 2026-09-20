// coupon: { type: 'percent' | 'fixed', value }   (percent value is a fraction, e.g. 0.1 = 10%)
function applyCoupon(amount, coupon) {
  if (coupon.type === 'percent') return amount - amount * coupon.value;
  if (coupon.type === 'fixed') return Math.max(0, amount - coupon.value);
  return amount;
}

module.exports = { applyCoupon };
