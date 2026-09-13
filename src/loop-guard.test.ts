import { describe, expect, test } from "bun:test";
import { trackGitArchaeology, type ArchaeologyState } from "./loop-guard";

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
