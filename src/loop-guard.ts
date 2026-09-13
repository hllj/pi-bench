export interface ArchaeologyState {
  count: number;
}

const GIT_ARCHAEOLOGY_RE = /\bgit\s+(log|show|blame)\b/;
const MUTATING_TOOLS = new Set(["edit", "write"]);

// Tracks a streak of read-only git-history exploration (log/show/blame) with
// no file-mutating tool call in between - the "unnecessary git archaeology"
// pattern CRITICAL INSTRUCTION #10 already warns against but nothing
// enforced (see sphinx-doc__sphinx-9320, which burned its whole timeout
// budget this way and never edited a file). Returns true exactly once the
// streak crosses `threshold`; the caller must reset state.count afterward.
export function trackGitArchaeology(
  state: ArchaeologyState,
  toolName: string,
  argsStr: string,
  threshold = 3
): boolean {
  if (MUTATING_TOOLS.has(toolName)) {
    state.count = 0;
    return false;
  }
  if (toolName === "bash" && GIT_ARCHAEOLOGY_RE.test(argsStr)) {
    state.count++;
  }
  return state.count >= threshold;
}
