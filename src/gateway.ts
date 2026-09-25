// Key-holding LLM gateway policy (served by scripts/egress-proxy.ts).
//
// Without it, a sealed container still needed the provider API key in its
// environment -- readable by the agent (root) via /proc/1/environ -- and the
// provider host on the egress allowlist. With the key, OpenRouter itself is
// a path to the internet (":online" web-search models, the `web` plugin,
// `web_search_options`) or to a stronger model than the one benchmarked.
//
// Instead the container talks plain HTTP to http://pi-bench-egress:8787/<route>/...
// with no key; the gateway checks the request against this policy, adds the
// real key, and forwards it. The agent can still reach the gateway, but only
// to call the model it already is, with no server-side web features.

export interface GatewayRoute {
  name: string; // path prefix, e.g. "openrouter"
  upstream: string; // e.g. "https://openrouter.ai/api/v1"
  key: string; // real API key -- only ever lives in the gateway container
  models: string[]; // exact model ids allowed through this route
}

const ALLOWED_ENDPOINTS = new Set(["/chat/completions"]);
// OpenRouter request fields that reach the web or swap the model.
const FORBIDDEN_FIELDS = ["plugins", "web_search_options", "models", "route"];

export const GATEWAY_HOST = "pi-bench-egress";
export const GATEWAY_PORT = 8787;
// What the sealed container sends as its "API key". The gateway ignores it.
export const GATEWAY_PLACEHOLDER_KEY = "sealed-by-pi-bench-gateway";

// PI_BENCH_GATEWAY="openrouter=http://pi-bench-egress:8787/openrouter,..." -> { openrouter: "http://..." }
export function parseGatewaySpec(spec: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (spec || "").split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Points each gatewayed provider in a models.json document at the gateway,
// with a placeholder key -- the real key is added by the gateway.
export function applyGatewayOverrides(modelsData: any, gateways: Record<string, string>): void {
  if (Object.keys(gateways).length === 0) return;
  modelsData.providers = modelsData.providers || {};
  for (const [provider, url] of Object.entries(gateways)) {
    modelsData.providers[provider] = { ...(modelsData.providers[provider] || {}), baseUrl: url, apiKey: GATEWAY_PLACEHOLDER_KEY };
  }
}

export function parseGatewayPath(url: string): { name: string; subpath: string } | null {
  const path = url.split("?")[0];
  const m = path.match(/^\/([A-Za-z0-9._-]+)(\/.+)$/);
  return m ? { name: m[1], subpath: m[2] } : null;
}

export function checkGatewayRequest(
  route: GatewayRoute,
  method: string,
  subpath: string,
  body: any
): { ok: true } | { ok: false; reason: string } {
  if (method !== "POST") return { ok: false, reason: `method ${method} not allowed` };
  if (!ALLOWED_ENDPOINTS.has(subpath)) return { ok: false, reason: `endpoint ${subpath} not allowed` };
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "body must be a JSON object" };
  if (typeof body.model !== "string" || !route.models.includes(body.model)) {
    return { ok: false, reason: `model ${JSON.stringify(body.model)} not allowed (allowed: ${route.models.join(", ")})` };
  }
  for (const f of FORBIDDEN_FIELDS) {
    if (body[f] !== undefined) return { ok: false, reason: `field "${f}" not allowed` };
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.some((t: any) => !t || t.type !== "function")) {
      return { ok: false, reason: "only function tools are allowed" };
    }
  }
  return { ok: true };
}
