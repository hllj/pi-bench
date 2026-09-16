import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { scrubGitHistoryToOrphanBaseline } from "./git-scrub";

const execFileAsync = promisify(execFile);
function git(args: string[], cwd: string) {
  return execFileAsync("git", args, { cwd });
}

// Regression test for a real bug this module shipped with: the ref-listing
// step ran `git for-each-ref --format=%(refname)` through node's exec()
// (shell-interpolated), and some containers' /bin/sh treats the unquoted
// `%(refname)` parens as shell grouping syntax ("Syntax error: \"(\"
// unexpected"). Caught by an actual SWE-bench container run against
// django__django-12209 -- this test exercises the exact same code path
// (execFile, no shell) against a real git repo so it can't regress silently.
describe("scrubGitHistoryToOrphanBaseline", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("collapses future commits/tags into a single orphan baseline commit", async () => {
    dir = await mkdtemp(join(tmpdir(), "git-scrub-test-"));

    await git(["init"], dir);
    await git(["-c", "user.email=a@a", "-c", "user.name=a", "commit", "--allow-empty", "-m", "root"], dir);
    await Bun.write(join(dir, "file.txt"), "base\n");
    await git(["add", "file.txt"], dir);
    await git(["-c", "user.email=a@a", "-c", "user.name=a", "commit", "-m", "base commit"], dir);
    const base = (await git(["rev-parse", "HEAD"], dir)).stdout.trim();

    // Simulate the SWE-bench image shape: full history past the base commit,
    // including a tag, that a checked-out-at-base agent shouldn't be able to see.
    await Bun.write(join(dir, "file.txt"), "future1\n");
    await git(["-c", "user.email=a@a", "-c", "user.name=a", "commit", "-am", "future fix commit"], dir);
    await git(["tag", "v9.9.9"], dir);
    await Bun.write(join(dir, "file.txt"), "future2\n");
    await git(["-c", "user.email=a@a", "-c", "user.name=a", "commit", "-am", "even more future"], dir);
    const future = (await git(["rev-parse", "HEAD"], dir)).stdout.trim();

    // Check out at the base commit, detached, with pre-existing "dirty" image
    // noise -- mirrors how a SWE-bench container is actually checked out.
    await git(["checkout", "-q", "--detach", base], dir);
    await Bun.write(join(dir, "setup.py"), "dirty\n");

    const { staleRefsDropped } = await scrubGitHistoryToOrphanBaseline(dir);
    expect(staleRefsDropped).toBeGreaterThanOrEqual(2); // the future branch tip's ref + the tag

    const { stdout: logOut } = await git(["log", "--oneline", "--all"], dir);
    expect(logOut.trim().split("\n")).toHaveLength(1); // only the orphan baseline commit is reachable

    const { stdout: tagOut } = await git(["tag", "-l"], dir);
    expect(tagOut.trim()).toBe("");

    await expect(git(["cat-file", "-e", future], dir)).rejects.toThrow(); // future commit object is gone

    const setupContent = await Bun.file(join(dir, "setup.py")).text();
    expect(setupContent.trim()).toBe("dirty"); // pre-existing dirty state is preserved into the baseline
  });

  test("is safe to call twice on the same repo (branch-exists collision)", async () => {
    dir = await mkdtemp(join(tmpdir(), "git-scrub-test-"));
    await git(["init"], dir);
    await Bun.write(join(dir, "file.txt"), "base\n");
    await git(["add", "file.txt"], dir);
    await git(["-c", "user.email=a@a", "-c", "user.name=a", "commit", "-m", "base"], dir);

    await scrubGitHistoryToOrphanBaseline(dir);
    await expect(scrubGitHistoryToOrphanBaseline(dir)).resolves.toBeDefined();
  });
});
