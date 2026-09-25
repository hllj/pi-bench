import { describe, expect, test } from "bun:test";
import { applyGatewayOverrides, checkGatewayRequest, GATEWAY_PLACEHOLDER_KEY, parseGatewayPath, parseGatewaySpec, type GatewayRoute } from "./gateway";

const route: GatewayRoute = { name: "openrouter", upstream: "https://openrouter.ai/api/v1", key: "sk-test", models: ["deepseek/deepseek-v4-flash"] };
const ok = (body: any) => checkGatewayRequest(route, "POST", "/chat/completions", body);

describe("parseGatewayPath", () => {
  test("splits route name and upstream subpath", () => {
    expect(parseGatewayPath("/openrouter/chat/completions")).toEqual({ name: "openrouter", subpath: "/chat/completions" });
    expect(parseGatewayPath("/openrouter/chat/completions?x=1")).toEqual({ name: "openrouter", subpath: "/chat/completions" });
  });
  test("rejects garbage", () => {
    expect(parseGatewayPath("/")).toBeNull();
    expect(parseGatewayPath("/openrouter")).toBeNull();
  });
});

describe("parseGatewaySpec / applyGatewayOverrides", () => {
  test("round-trips a spec into models.json overrides with a placeholder key", () => {
    const gw = parseGatewaySpec("openrouter=http://pi-bench-egress:8787/openrouter");
    const data: any = { providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1", models: [{ id: "x" }] }, ds4: { baseUrl: "http://localhost:8000/v1" } } };
    applyGatewayOverrides(data, gw);
    expect(data.providers.openrouter.baseUrl).toBe("http://pi-bench-egress:8787/openrouter");
    expect(data.providers.openrouter.apiKey).toBe(GATEWAY_PLACEHOLDER_KEY);
    expect(data.providers.openrouter.models).toEqual([{ id: "x" }]);
    expect(data.providers.ds4.baseUrl).toBe("http://localhost:8000/v1");
  });

  test("empty spec is a no-op", () => {
    const data: any = { providers: {} };
    applyGatewayOverrides(data, parseGatewaySpec(""));
    expect(data).toEqual({ providers: {} });
  });
});

describe("checkGatewayRequest", () => {
  test("allows the benchmarked model with ordinary function tools", () => {
    expect(ok({ model: "deepseek/deepseek-v4-flash", messages: [], stream: true, tools: [{ type: "function", function: { name: "bash" } }] }).ok).toBe(true);
  });

  test("rejects any other model -- no calling a stronger model", () => {
    expect(ok({ model: "anthropic/claude-opus-5.5", messages: [] }).ok).toBe(false);
  });

  test("rejects the :online web-search variant of the allowed model", () => {
    expect(ok({ model: "deepseek/deepseek-v4-flash:online", messages: [] }).ok).toBe(false);
  });

  test("rejects OpenRouter web plugins / web_search_options / fallback models", () => {
    expect(ok({ model: "deepseek/deepseek-v4-flash", messages: [], plugins: [{ id: "web" }] }).ok).toBe(false);
    expect(ok({ model: "deepseek/deepseek-v4-flash", messages: [], web_search_options: {} }).ok).toBe(false);
    expect(ok({ model: "deepseek/deepseek-v4-flash", messages: [], models: ["openai/gpt-5:online"] }).ok).toBe(false);
  });

  test("rejects non-function (server-side) tools", () => {
    expect(ok({ model: "deepseek/deepseek-v4-flash", messages: [], tools: [{ type: "web_search" }] }).ok).toBe(false);
  });

  test("rejects other endpoints and methods", () => {
    expect(checkGatewayRequest(route, "GET", "/chat/completions", {}).ok).toBe(false);
    expect(checkGatewayRequest(route, "POST", "/responses", { model: "deepseek/deepseek-v4-flash" }).ok).toBe(false);
    expect(checkGatewayRequest(route, "POST", "/../../v1/chat/completions", { model: "deepseek/deepseek-v4-flash" }).ok).toBe(false);
  });

  test("rejects a non-JSON body", () => {
    expect(ok(null).ok).toBe(false);
  });
});
