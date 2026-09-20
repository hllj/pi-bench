#!/usr/bin/env python3
"""Ask OpenRouter about the key in .env. Prints ONLY balance-related numbers, never the key."""
import json, os, re, urllib.request

key = None
for line in open(os.environ.get("ENV_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", ".env"))):
    m = re.match(r"\s*OPENROUTER_API_KEY\s*=\s*(.+?)\s*$", line)
    if m:
        key = m.group(1).strip("'\"")
assert key, "no OPENROUTER_API_KEY in .env"
req = urllib.request.Request("https://openrouter.ai/api/v1/key", headers={"Authorization": f"Bearer {key}"})
try:
    c = json.load(urllib.request.urlopen(urllib.request.Request("https://openrouter.ai/api/v1/credits", headers={"Authorization": f"Bearer {key}"}), timeout=20)).get("data", {})
    print("account credits:", json.dumps({"total_credits": c.get("total_credits"), "total_usage": c.get("total_usage"),
          "balance": round((c.get("total_credits") or 0) - (c.get("total_usage") or 0), 4)}))
except Exception as e:
    print("credits query failed:", type(e).__name__, str(e)[:160])
try:
    d = json.load(urllib.request.urlopen(req, timeout=20)).get("data", {})
    keep = {k: d.get(k) for k in ("label", "limit", "limit_remaining", "usage", "usage_daily", "usage_weekly", "usage_monthly", "is_free_tier") if k in d}
    keep["label"] = "(hidden)" if keep.get("label") else keep.get("label")
    print(json.dumps(keep, indent=2))
except Exception as e:
    print("query failed:", type(e).__name__, str(e)[:200])
