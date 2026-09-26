import { describe, expect, test } from "bun:test";
import { shouldIssueBudgetNudge, trackGitArchaeology, verificationRetryBudgetMs, type ArchaeologyState } from "./loop-guard";

describe("trackGitArchaeology", () => {
  test("triggers after 3 git-history bash calls with no mutation in between", () => {
    const state: ArchaeologyState = { count: 0 };
    expect(trackGitArchaeology(state, "bash", 'git log -S "foo" -- bar.py')).toBe(false);
    expect(trackGitArchaeology(state, "bash", "git show abc123")).toBe(false);
    expect(trackGitArchaeology(state, "bash", "git log --oneline -- bar.py")).toBe(true);
  });

  test("resets the streak on an edit tool call", () => {
    const state: ArchaeologyState = { count: 0 };
    trackGitArchaeology(state, "bash", "git log -- bar.py");
    trackGitArchaeology(state, "bash", "git show abc123");
    expect(trackGitArchaeology(state, "edit", "bar.py")).toBe(false);
    expect(state.count).toBe(0);
    // needs a fresh streak of 3 after the reset
    expect(trackGitArchaeology(state, "bash", "git log -- bar.py")).toBe(false);
    expect(trackGitArchaeology(state, "bash", "git show abc123")).toBe(false);
  });

  test("resets the streak on a write tool call", () => {
    const state: ArchaeologyState = { count: 0 };
    trackGitArchaeology(state, "bash", "git blame bar.py");
    expect(trackGitArchaeology(state, "write", "bar.py")).toBe(false);
    expect(state.count).toBe(0);
  });

  test("does not count non-git bash calls or other read tools toward the streak", () => {
    const state: ArchaeologyState = { count: 0 };
    trackGitArchaeology(state, "bash", "git log -- bar.py");
    trackGitArchaeology(state, "read", "bar.py");
    trackGitArchaeology(state, "bash", "pytest tests/test_bar.py");
    expect(trackGitArchaeology(state, "bash", "git log -- bar.py")).toBe(false);
    expect(state.count).toBe(2);
  });

  test("respects a custom threshold", () => {
    const state: ArchaeologyState = { count: 0 };
    expect(trackGitArchaeology(state, "bash", "git show abc123", 2)).toBe(false);
    expect(trackGitArchaeology(state, "bash", "git log -- bar.py", 2)).toBe(true);
  });
});

describe("shouldIssueBudgetNudge", () => {
  test("false before crossing the threshold fraction", () => {
    expect(shouldIssueBudgetNudge(4 * 60_000, 10 * 60_000, false)).toBe(false);
  });

  test("true once elapsed time crosses the threshold fraction", () => {
    expect(shouldIssueBudgetNudge(5 * 60_000, 10 * 60_000, false)).toBe(true);
    expect(shouldIssueBudgetNudge(9 * 60_000, 10 * 60_000, false)).toBe(true);
  });

  test("false if already issued, even past the threshold", () => {
    expect(shouldIssueBudgetNudge(9 * 60_000, 10 * 60_000, true)).toBe(false);
  });

  test("respects a custom threshold fraction", () => {
    expect(shouldIssueBudgetNudge(2 * 60_000, 10 * 60_000, false, 0.25)).toBe(false);
    expect(shouldIssueBudgetNudge(3 * 60_000, 10 * 60_000, false, 0.25)).toBe(true);
  });

  test("false for a zero or negative timeout", () => {
    expect(shouldIssueBudgetNudge(1000, 0, false)).toBe(false);
  });
});

describe("verificationRetryBudgetMs", () => {
  const MIN = 60_000;

  test("keeps the rest of the main budget when that is more than the retry allowance", () => {
    expect(verificationRetryBudgetMs(8 * MIN, 30 * MIN, 10 * MIN)).toBe(22 * MIN);
  });

  test("gives at least the retry allowance when the main budget is nearly spent", () => {
    // 0925 run: agents finishing at 16-25 min got a retry with 5-14 min left
    // and were killed at 30 min.
    expect(verificationRetryBudgetMs(25 * MIN, 30 * MIN, 10 * MIN)).toBe(10 * MIN);
  });

  test("gives the retry allowance even if the main budget is already exceeded", () => {
    expect(verificationRetryBudgetMs(31 * MIN, 30 * MIN, 10 * MIN)).toBe(10 * MIN);
  });

  test("a zero allowance falls back to what is left of the main budget", () => {
    expect(verificationRetryBudgetMs(25 * MIN, 30 * MIN, 0)).toBe(5 * MIN);
    expect(verificationRetryBudgetMs(31 * MIN, 30 * MIN, 0)).toBe(0);
  });
});
