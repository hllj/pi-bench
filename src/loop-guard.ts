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

// Fires exactly once, when the agent crosses `thresholdFraction` of its time
// budget, so it can be nudged to stop broad exploration and finish
// implementing/verifying the fix (see plans/improvement-plan.md P0 item 6 --
// previously the only time-based signal was a hard abort at 100%, too late
// to recover any of the wasted time on slow failures like sphinx-doc__sphinx-9320,
// 45 minutes with zero source edits).
export function shouldIssueBudgetNudge(
  elapsedMs: number,
  timeoutMs: number,
  alreadyIssued: boolean,
  thresholdFraction = 0.5
): boolean {
  if (alreadyIssued || timeoutMs <= 0) return false;
  return elapsedMs >= timeoutMs * thresholdFraction;
}

// Time the one-shot verification retry may run: what is left of the main
// budget, but never less than `retryAllowanceMs`. The retry used to share the
// main timer, so an agent that finished at 16-25 of 30 minutes got a corrective
// pass with only minutes left and was killed mid-fix (5 of the 10 timeouts in
// the 0925 sealed run).
export function verificationRetryBudgetMs(elapsedMs: number, timeoutMs: number, retryAllowanceMs: number): number {
  return Math.max(timeoutMs - elapsedMs, retryAllowanceMs, 0);
}
