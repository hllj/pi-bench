// Network-egress policy for benchmark runs.
//
// Agents with open network access were observed fetching the real upstream
// fix instead of solving the task: `pip download sphinx==8.0.2 --no-binary
// :all:`, `curl raw.githubusercontent.com/sphinx-doc/sphinx/v4.0.0/...`,
// `urllib` against api.github.com/search/issues to find the fixing PR (12-19
// of 50 tasks per deepseek-v4-flash-0731 run, most of them scored as
// passes). Scrubbing git history (src/git-scrub.ts) doesn't help once the
// agent can reach PyPI/GitHub directly.
//
// The enforcement is at the network layer (run-swe-bench.sh puts the task
// container on an --internal docker network whose only way out is
// scripts/egress-proxy.ts, which allows just the LLM endpoints). This module
// holds the pure pieces both sides share, plus a command-pattern detector
// used purely for audit/telemetry -- it is trivially bypassable on its own
// and is NOT the enforcement mechanism.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function defaultPort(protocol: string): number {
  return protocol === "https:" ? 443 : 80;
}

// "https://openrouter.ai/api/v1" -> "openrouter.ai:443". Local hosts are
// mapped to `localAlias` (host.docker.internal inside a sealed container).
export function egressTargetFromBaseUrl(baseUrl: string, localAlias = "localhost"): string | null {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return null;
  }
  const host = LOCAL_HOSTS.has(u.hostname) ? localAlias : u.hostname;
  const port = u.port ? Number(u.port) : defaultPort(u.protocol);
  return `${host.toLowerCase()}:${port}`;
}

// Points a localhost model endpoint at the docker host instead. A sealed
// container has no route to the host's loopback, so a local llama.cpp/vllm
// server is only reachable as host.docker.internal via the egress proxy.
export function rewriteLocalBaseUrl(baseUrl: string, localAlias: string): string {
  if (LOCAL_HOSTS.has(localAlias)) return baseUrl;
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return baseUrl;
  }
  if (!LOCAL_HOSTS.has(u.hostname)) return baseUrl;
  u.hostname = localAlias;
  // URL.toString() adds a trailing slash to a bare origin; keep the input shape.
  const out = u.toString();
  return baseUrl.endsWith("/") || !out.endsWith("/") ? out : out.slice(0, -1);
}

export function parseEgressAllowlist(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

// Exact host:port match. Deliberately no wildcard/subdomain matching -- the
// allowlist is a handful of LLM endpoints, nothing else.
export function isEgressAllowed(host: string, port: number, allow: Set<string>): boolean {
  return allow.has(`${host.toLowerCase()}:${port}`);
}

export type EgressCategory = "upstream-source" | "package-install" | "http-fetch";

export interface EgressAttempt {
  category: EgressCategory;
  snippet: string;
  // Set when a delegated child made the call, e.g. "subagent:reviewer".
  via?: string;
}

// Tools that run a shell command from args.command.
const COMMAND_TOOLS = new Set(["bash", "run_test"]);

// Anything that pulls a (possibly newer) copy of the project's source or its
// history: the reference fix is one `diff` away once this succeeds.
const UPSTREAM_COMMAND_RE = /\bpip3?\s+download\b|\bgit\s+(clone|fetch|pull|ls-remote|remote\s+add)\b/i;
const SOURCE_HOST_RE =
  /\b(github\.com|githubusercontent\.com|gitlab\.com|bitbucket\.org|pypi\.org|pythonhosted\.org|readthedocs\.(io|org))\b/i;
const PACKAGE_INSTALL_RE = /\b(pip3?|uv\s+pip)\s+install\b|\bconda\s+install\b|\bapt(-get)?\s+install\b|\bnpm\s+(install|i)\b|\beasy_install\b/i;
const HTTP_CLIENT_RE = /\b(curl|wget|urlopen|urlretrieve|urllib\.request|urllib2|requests\.(get|post|head)|httpx\.|http\.client|aiohttp)\b/i;
const URL_RE = /\bhttps?:\/\//i;
// `cat > file <<'EOF' ... EOF` / `tee file <<EOF` just WRITE text (often test
// code that mentions URLs or requests.get); only the header line is a
// command. `python - <<'EOF'` bodies are executed, so they're kept.
const FILE_HEREDOC_RE = /(\b(?:cat|tee)\b[^\n]*<<-?\s*['"]?(\w+)['"]?[^\n]*)\n[\s\S]*?\n\s*\2\b/g;

function stripFileHeredocs(command: string): string {
  return command.replace(FILE_HEREDOC_RE, "$1");
}

// Audit-only classifier over a tool call. Only shell commands count: an
// `edit` that writes `mock.patch('requests.get')` into test code is not a
// network access.
export function detectEgressAttempt(toolName: string, args: unknown): EgressAttempt | null {
  if (!COMMAND_TOOLS.has(toolName)) return null;
  const command =
    args && typeof args === "object" && typeof (args as any).command === "string"
      ? ((args as any).command as string)
      : typeof args === "string"
        ? args
        : "";
  if (!command) return null;

  const executed = stripFileHeredocs(command);
  const fetches = HTTP_CLIENT_RE.test(executed) && URL_RE.test(executed);
  let category: EgressCategory | null = null;
  if (UPSTREAM_COMMAND_RE.test(executed) || (fetches && SOURCE_HOST_RE.test(executed))) category = "upstream-source";
  else if (PACKAGE_INSTALL_RE.test(executed)) category = "package-install";
  else if (fetches) category = "http-fetch";
  if (!category) return null;

  return { category, snippet: command.length > 300 ? command.slice(0, 297) + "..." : command };
}

// Delegation tools (subagent, workflows) run their children as separate `pi`
// processes, so a child's tool calls never reach this session's
// tool_execution_start events -- a subagent's `pip download` would only show
// up as a proxy denial. The child's message history does come back in the
// delegation tool's result details (results[].messages[]), so walk it for
// tool calls, including those of nested delegations.
export function detectEgressAttemptsInDelegation(details: unknown, via: string): EgressAttempt[] {
  const found: EgressAttempt[] = [];
  const seen = new Set<object>();
  const walk = (node: unknown, label: string, depth: number) => {
    if (!node || typeof node !== "object" || depth > 24 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const x of node) walk(x, label, depth + 1);
      return;
    }
    const o = node as any;
    const here = typeof o.agent === "string" ? `${via}:${o.agent}` : label;
    if (o.type === "toolCall" && typeof o.name === "string") {
      const attempt = detectEgressAttempt(o.name, o.arguments);
      if (attempt) found.push({ ...attempt, via: here });
      return;
    }
    for (const v of Object.values(o)) walk(v, here, depth + 1);
  };
  walk(details, via, 0);
  return found;
}
