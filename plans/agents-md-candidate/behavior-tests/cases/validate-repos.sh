#!/bin/bash
# For each scratch repo: (1) initial test must FAIL, (2) after the intended fix it must PASS.
R="$(cd "$(dirname "$0")" && pwd)/repos"
T=$(mktemp -d)
cp -R $R/* $T/
cd $T

check() { # name, dir
  ( cd "$2" && node test.js >/dev/null 2>&1 ) && echo "  $1: initial state PASSES (BAD)" || echo "  $1: initial state fails (good)"
}
first_error() { ( cd "$2" && node test.js 2>&1 | grep -E "^(AssertionError|Error|TypeError)|Expected|actual|expected" | head -3 | sed 's/^/      /' ); }

echo "== initial states"
for d in A-slugify B-rename C-cart D-price; do check $d $d; done
echo "-- first errors (what the agent will see)"
for d in A-slugify B-rename C-cart D-price; do echo "  $d"; first_error $d $d; done

echo "== apply intended fixes"
sed -i.bak "s#replace(/\\\\s/g, '-')#replace(/\\\\s+/g, '-')#" A-slugify/src/util.js
grep -rl legacyFetch B-rename/src | xargs sed -i.bak 's/legacyFetch/fetchJson/g'
python3 - <<'EOF'
import re
p='C-cart/src/cart.js'; s=open(p).read()
s=s.replace("let amount = coupon && coupon.type === 'percent' ? applyCoupon(subtotal, coupon) : subtotal;","let amount = coupon ? applyCoupon(subtotal, coupon) : subtotal;").replace("  if (coupon && coupon.type === 'fixed') amount = applyCoupon(amount, coupon);\n","")
open(p,'w').write(s)
p='D-price/src/parse.js'; s=open(p).read(); open(p,'w').write(s.replace("parseFloat(str)","parseFloat(str.replace(/,/g, ''))"))
p='D-price/src/round.js'; s=open(p).read(); open(p,'w').write(s.replace("Math.round(n * 100) / 100","Math.round((n + Number.EPSILON) * 100) / 100"))
p='D-price/src/format.js'; s=open(p).read(); open(p,'w').write(s.replace("whole.replace(/(\\d{3})(?=\\d)/g, '$1,')","whole.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',')"))
EOF
echo "== after fixes"
for d in A-slugify B-rename C-cart D-price; do ( cd $d && node test.js 2>&1 | tail -1 | sed "s/^/  $d: /" ); done
echo "== B leftover legacy names in src/*.js: $(grep -rn --include=*.js legacyFetch B-rename/src | wc -l)"
rm -rf $T
