import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Runs git with an argv array (no shell) -- avoids a real bug this module
// shipped with: `git for-each-ref --format=%(refname)` run through
// node's exec() (which always goes via a shell) hits containers whose
// /bin/sh treats the unquoted `%(refname)` parens as shell grouping syntax
// ("Syntax error: \"(\" unexpected"). execFile sidesteps shell parsing
// entirely, the same fix applied to sphinx pytest node ids in src/index.ts.
function git(args: string[], cwd: string) {
  return execFileAsync("git", args, { cwd });
}

export const DEFAULT_BASELINE_BRANCH = "pi-bench-baseline";

// Collapses a repo's current working-tree state into a single ORPHAN commit
// and deletes every other ref/tag. Used on SWE-bench container checkouts,
// which ship the FULL upstream repo history -- including commits/tags
// authored AFTER the task's base commit. An agent that runs `git log`/`git
// show`/checks out a future tag can read off the real upstream fix instead
// of solving the task (observed on sphinx-doc__sphinx-9320 and
// sphinx-doc__sphinx-8548 -- 45 minutes burned chasing tags v4.1.0..v8.1.3
// with zero source edits; see plans/improvement-plan.md cross-cutting
// finding #1). An orphan commit has no parents, so `git log` can only ever
// show this one commit, and the working tree (including any pre-existing
// dirty image state, e.g. setup.py/tox.ini) is preserved into it exactly
// like the plain "benchmark-baseline" commit this replaces.
export async function scrubGitHistoryToOrphanBaseline(
  tmpDir: string,
  baselineBranch: string = DEFAULT_BASELINE_BRANCH
): Promise<{ staleRefsDropped: number }> {
  try {
    await git(["status"], tmpDir);
  } catch {
    await git(["init"], tmpDir);
  }

  // Detach HEAD before deleting baselineBranch: `git branch -D` refuses to
  // delete the currently checked-out branch, which this call itself left
  // HEAD on the last time it ran (e.g. a resumed/re-run container). Detach
  // is a harmless no-op if there are no commits yet or HEAD is already
  // detached.
  await git(["checkout", "--detach", "HEAD"], tmpDir).catch(() => {});
  await git(["branch", "-D", baselineBranch], tmpDir).catch(() => {});
  await git(["checkout", "--orphan", baselineBranch], tmpDir);
  await git(["add", "-A"], tmpDir);
  await git(
    ["-c", "user.email=bench@pi.local", "-c", "user.name=Pi Benchmarker", "commit", "-m", "benchmark-baseline", "--allow-empty"],
    tmpDir
  );

  const { stdout: refsOut } = await git(["for-each-ref", "--format=%(refname)"], tmpDir);
  const staleRefs = refsOut
    .split("\n")
    .map((r) => r.trim())
    .filter((r) => r && r !== `refs/heads/${baselineBranch}`);
  for (const ref of staleRefs) {
    await git(["update-ref", "-d", ref], tmpDir).catch(() => {});
  }
  await git(["reflog", "expire", "--expire=now", "--all"], tmpDir).catch(() => {});
  await git(["gc", "--prune=now"], tmpDir).catch(() => {});

  return { staleRefsDropped: staleRefs.length };
}
