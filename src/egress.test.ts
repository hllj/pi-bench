import { describe, expect, test } from "bun:test";
import {
  detectEgressAttempt,
  egressTargetFromBaseUrl,
  isEgressAllowed,
  parseEgressAllowlist,
  rewriteLocalBaseUrl,
} from "./egress";

describe("egressTargetFromBaseUrl", () => {
  test("https URL without explicit port defaults to 443", () => {
    expect(egressTargetFromBaseUrl("https://openrouter.ai/api/v1")).toBe("openrouter.ai:443");
  });

  test("http URL keeps its explicit port", () => {
    expect(egressTargetFromBaseUrl("http://10.0.0.5:8000/v1")).toBe("10.0.0.5:8000");
  });

  test("localhost is mapped to the host alias", () => {
    expect(egressTargetFromBaseUrl("http://localhost:8080/v1", "host.docker.internal")).toBe("host.docker.internal:8080");
    expect(egressTargetFromBaseUrl("http://127.0.0.1:8000/v1", "host.docker.internal")).toBe("host.docker.internal:8000");
  });

  test("returns null for garbage", () => {
    expect(egressTargetFromBaseUrl("not a url")).toBeNull();
  });
});

describe("rewriteLocalBaseUrl", () => {
  test("rewrites localhost/127.0.0.1 and leaves remote hosts alone", () => {
    expect(rewriteLocalBaseUrl("http://localhost:8080/v1", "host.docker.internal")).toBe("http://host.docker.internal:8080/v1");
    expect(rewriteLocalBaseUrl("http://127.0.0.1:8000/v1", "host.docker.internal")).toBe("http://host.docker.internal:8000/v1");
    expect(rewriteLocalBaseUrl("https://openrouter.ai/api/v1", "host.docker.internal")).toBe("https://openrouter.ai/api/v1");
  });

  test("no-op when alias is localhost", () => {
    expect(rewriteLocalBaseUrl("http://localhost:8080/v1", "localhost")).toBe("http://localhost:8080/v1");
  });
});

describe("parseEgressAllowlist / isEgressAllowed", () => {
  const allow = parseEgressAllowlist(" OpenRouter.ai:443, host.docker.internal:8080 ,,");

  test("normalizes case and whitespace, drops empties", () => {
    expect([...allow].sort()).toEqual(["host.docker.internal:8080", "openrouter.ai:443"]);
  });

  test("exact host:port match only", () => {
    expect(isEgressAllowed("openrouter.ai", 443, allow)).toBe(true);
    expect(isEgressAllowed("OPENROUTER.AI", 443, allow)).toBe(true);
    expect(isEgressAllowed("openrouter.ai", 80, allow)).toBe(false);
    expect(isEgressAllowed("host.docker.internal", 8080, allow)).toBe(true);
    expect(isEgressAllowed("host.docker.internal", 22, allow)).toBe(false);
  });

  test("denies the upstream-source hosts agents were observed using", () => {
    for (const h of ["pypi.org", "files.pythonhosted.org", "github.com", "raw.githubusercontent.com", "api.github.com"]) {
      expect(isEgressAllowed(h, 443, allow)).toBe(false);
    }
  });

  test("subdomains of an allowed host are NOT implicitly allowed", () => {
    expect(isEgressAllowed("evil.openrouter.ai", 443, allow)).toBe(false);
  });
});

describe("detectEgressAttempt", () => {
  // Real commands lifted from deepseek-v4-flash-0731 transcripts.
  test("pip download of a later release is upstream-source", () => {
    const a = detectEgressAttempt("bash", { command: "cd /tmp && timeout 120 pip download sphinx==8.0.2 --no-deps --no-binary :all: -d /tmp/sphinx_ref" });
    expect(a?.category).toBe("upstream-source");
  });

  test("curl raw.githubusercontent is upstream-source", () => {
    const a = detectEgressAttempt("bash", { command: "curl -s https://raw.githubusercontent.com/sphinx-doc/sphinx/v4.0.0/sphinx/ext/autodoc/__init__.py -o /tmp/x.py" });
    expect(a?.category).toBe("upstream-source");
  });

  test("python urllib against api.github.com is upstream-source", () => {
    const a = detectEgressAttempt("bash", { command: "python - <<'EOF'\nimport urllib.request\nurl = 'https://api.github.com/repos/sphinx-doc/sphinx/issues/5977/timeline'\nEOF" });
    expect(a?.category).toBe("upstream-source");
  });

  test("git clone / fetch / remote add are upstream-source", () => {
    expect(detectEgressAttempt("bash", { command: "git clone https://github.com/django/django /tmp/dj" })?.category).toBe("upstream-source");
    expect(detectEgressAttempt("bash", { command: "git fetch origin --tags" })?.category).toBe("upstream-source");
    expect(detectEgressAttempt("bash", { command: "git remote add up https://example.com/x.git" })?.category).toBe("upstream-source");
  });

  test("pip install is package-install", () => {
    expect(detectEgressAttempt("bash", { command: "cd /testbed && pip install pytest pytest-django" })?.category).toBe("package-install");
  });

  test("generic http fetch to a non-source host is http-fetch", () => {
    expect(detectEgressAttempt("bash", { command: "timeout 8 python -c \"import requests; r=requests.get('http://example.com')\"" })?.category).toBe("http-fetch");
  });

  test("ignores non-bash tools (e.g. an edit that mentions requests.get in test code)", () => {
    expect(detectEgressAttempt("edit", { path: "tests/test_x.py", edits: [{ newText: "mock.patch('requests.get')" }] })).toBeNull();
  });

  test("ignores ordinary local commands", () => {
    expect(detectEgressAttempt("bash", { command: "cd /testbed && python -m pytest tests/test_build.py -x" })).toBeNull();
    expect(detectEgressAttempt("bash", { command: "git diff && git status" })).toBeNull();
    expect(detectEgressAttempt("bash", { command: "rg 'urlopen' sphinx/" })).toBeNull();
  });

  test("a URL merely written into a file via cat heredoc is not a fetch", () => {
    // Real false positive from an audit: the agent wrote a linkcheck test
    // that mentions github.com and requests.get into a scratch file.
    const cmd = "cd /testbed && cat > /tmp/test_linkcheck.py << 'EOF'\nimport requests\nr = requests.get('https://github.com/sphinx-doc/sphinx')\nEOF\npython -m pytest /tmp/test_linkcheck.py";
    expect(detectEgressAttempt("bash", { command: cmd })).toBeNull();
  });

  test("an EXECUTED python heredoc that fetches is still caught", () => {
    const cmd = "python - <<'EOF'\nimport urllib.request\nurllib.request.urlopen('https://raw.githubusercontent.com/django/django/main/x.py')\nEOF";
    expect(detectEgressAttempt("bash", { command: cmd })?.category).toBe("upstream-source");
  });

  test("a source host mentioned without any fetch verb is not flagged", () => {
    expect(detectEgressAttempt("bash", { command: "grep -rn 'github.com' docs/ | head" })).toBeNull();
  });

  test("snippet is truncated", () => {
    const a = detectEgressAttempt("bash", { command: "pip download foo " + "x".repeat(1000) });
    expect(a!.snippet.length).toBeLessThanOrEqual(300);
  });
});
