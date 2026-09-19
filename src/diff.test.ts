import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractAgentDiff } from "./diff";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "diff-"));
  sh(dir, "init", "-q");
  sh(dir, "config", "user.email", "t@t.t");
  sh(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "lib.js"), "if (escape) {}\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "base");
  return dir;
}

describe("extractAgentDiff", () => {
  test("returns the agent's edits, whether unstaged, staged, or newly created", async () => {
    const dir = repo();
    writeFileSync(join(dir, "lib.js"), "if (escape && typeof json === 'string') {}\n");
    writeFileSync(join(dir, "new.test.js"), "test()\n");
    const diff = await extractAgentDiff(dir);
    expect(diff).toContain("+if (escape && typeof json === 'string') {}");
    expect(diff).toContain("new.test.js");
  });

  test("returns an empty string when nothing changed", async () => {
    expect(await extractAgentDiff(repo())).toBe("");
  });

  // Regression: exec's default 1 MiB maxBuffer made a large diff reject, and the
  // old catch turned that into "" -- a correct fix scored as "no changes".
  test("returns a diff larger than exec's default 1 MiB buffer in full", async () => {
    const dir = repo();
    writeFileSync(join(dir, "big.txt"), "line of real agent output\n".repeat(120_000)); // ~3 MB
    const diff = await extractAgentDiff(dir);
    expect(diff.length).toBeGreaterThan(3_000_000);
    expect(diff.endsWith("\n")).toBe(true);
  });

  // Regression: the pi-lens extension writes .pi-lens-probe-home/ into the repo it
  // runs in; a subagent then `git add`s it. It is tooling noise, not the fix.
  test("excludes pi-lens tooling artifacts even when large and already staged", async () => {
    const dir = repo();
    writeFileSync(join(dir, "lib.js"), "if (escape && typeof json === 'string') {}\n");
    mkdirSync(join(dir, ".pi-lens-probe-home/logs"), { recursive: true });
    writeFileSync(join(dir, ".pi-lens-probe-home/logs/2026-09-19.jsonl"), '{"probe":1}\n'.repeat(250_000)); // ~3 MB
    sh(dir, "add", "-f", ".pi-lens-probe-home"); // worker staged it
    const diff = await extractAgentDiff(dir);
    expect(diff).toContain("typeof json === 'string'");
    expect(diff).not.toContain("pi-lens-probe-home");
    expect(diff.length).toBeLessThan(2_000);
  });

  test("throws instead of silently reporting 'no changes' when the diff cannot be produced", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "not-a-repo-"));
    await expect(extractAgentDiff(notARepo)).rejects.toThrow();
  });
});
