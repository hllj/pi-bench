import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractDjangoTestModules, validateFailToPass } from "./task-validation";

// SWE-bench acceptance-test helpers, shared by the harness (in-container,
// advisory run that feeds the verification retry) and src/grade.ts (the
// authoritative run in a FRESH container that the agent never touched).

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Base test timeout, scaled up for tasks with many FAIL_TO_PASS entries: a
// fixed 300s cap regardless of F2P count either kills a large django
// multi-module run early or wastes 300s waiting on a single fast pytest node.
const BASE_TEST_TIMEOUT_MS = 300_000;
const PER_TEST_TIMEOUT_MS = 120_000;
const MAX_TEST_TIMEOUT_MS = 1_200_000; // 20 min hard cap regardless of F2P count

function scaledTestTimeoutMs(failToPassCount: number): number {
  return Math.min(MAX_TEST_TIMEOUT_MS, Math.max(BASE_TEST_TIMEOUT_MS, failToPassCount * PER_TEST_TIMEOUT_MS));
}

export type SweTestPlan =
  | { kind: "shell"; command: string; timeoutMs: number }
  | { kind: "execFile"; file: string; args: string[]; timeoutMs: number }
  | { kind: "invalid"; reason: string };

// SWE-bench container test command builder. Refuses to build a command at
// all when FAIL_TO_PASS is malformed (see src/task-validation.ts) rather
// than silently falling back to running the FULL test suite (django, empty
// module list) or handing pytest a nonexistent node id (sphinx) -- both
// observed on the verified-mini import (django__django-12209,
// sphinx-doc__sphinx-8265; see plans/improvement-plan.md P0 items 1-2). The
// caller must treat "invalid" as scoreSource: "harness-error", never run
// anything, and exclude the task from pass-rate.
export function buildSweTestPlan(task: any): SweTestPlan {
  const python = "/opt/miniconda3/envs/testbed/bin/python";
  const failToPass: string[] = task.failToPass || [];
  const validation = validateFailToPass(task.repo, failToPass);
  if (!validation.valid) {
    return {
      kind: "invalid",
      reason: `malformed FAIL_TO_PASS entr${validation.invalidIds.length === 1 ? "y" : "ies"}: ${JSON.stringify(validation.invalidIds)}`,
    };
  }
  const timeoutMs = scaledTestTimeoutMs(failToPass.length);

  if (task.repo === "django/django") {
    const modules = extractDjangoTestModules(failToPass);
    if (modules.length === 0) {
      // Should be unreachable now that failToPass is validated above, but
      // this is the exact condition that silently ran the full suite before
      // -- keep the guard so a future validator gap fails loudly instead.
      return { kind: "invalid", reason: "no test modules could be extracted from FAIL_TO_PASS" };
    }
    // Django's runtests.py returns exit 0 even on failures, so we wrap the
    // command to parse the output and return a proper exit code. --failfast
    // stops at the first failure instead of running every extracted module
    // to completion.
    return {
      kind: "shell",
      command: `${python} /testbed/tests/runtests.py ${modules.join(" ")} --verbosity 2 --failfast 2>&1 | tee /tmp/test_output.txt; grep -q "^OK" /tmp/test_output.txt`,
      timeoutMs,
    };
  }

  if (task.repo === "sphinx-doc/sphinx") {
    // Sphinx uses pytest; FAIL_TO_PASS entries are pytest node IDs. Passed as
    // an argv array (execFile, no shell) rather than interpolated into a
    // shell string -- node ids can contain quotes, brackets, commas and
    // parens (e.g. test_unparse[b'bytes'-b'bytes']) that a shell would
    // otherwise need fragile escaping for. -x stops at the first failure.
    // -rA adds the "PASSED <nodeid>" short summary findUnconfirmedTests reads.
    return { kind: "execFile", file: python, args: ["-m", "pytest", ...failToPass, "-x", "-vs", "-rA"], timeoutMs };
  }

  // Generic fallback: run pytest
  return { kind: "shell", command: `cd /testbed && ${python} -m pytest --tb=short`, timeoutMs };
}

// Restores the repo's standard test directories to HEAD and drops any
// untracked files the agent added there. Used before EVERY acceptance-test
// run so (a) the official SWE-bench test patch applies cleanly and (b) the
// agent can never force a pass by editing the tests it is scored against.
// IMPORTANT: Each directory MUST be reverted in its own command.
// Passing multiple paths (e.g. `git checkout -- tests/ test/ testing/`)
// causes git to abort the ENTIRE operation if ANY pathspec doesn't match,
// silently leaving all test files un-reverted.
export async function revertAgentTestModifications(tmpDir: string): Promise<void> {
  console.log(`[INFO] Reverting agent test modifications to avoid conflicts...`);
  for (const testDir of ['tests/', 'test/', 'testing/']) {
    try {
      // Single atomic operation: restores both index and working tree to HEAD
      await execAsync(`git checkout HEAD -- ${testDir}`, { cwd: tmpDir });
      console.log(`[INFO] Reverted ${testDir} to HEAD.`);
    } catch {
      // Directory doesn't exist in this repo — expected, not an error
    }
  }
  // Clean any untracked files the agent may have added in test directories
  await execAsync(`git clean -fd tests/ test/ testing/ 2>/dev/null || true`, { cwd: tmpDir });
}

// Writes and applies the official SWE-bench test patch. The patch file is
// always removed afterwards (even on failure) so that a later `git add .`
// (see getDiff) can never stage the official test patch into the agent's
// stored diff.
export async function applySweTestPatch(tmpDir: string, testPatch: string): Promise<void> {
  const patchPath = join(tmpDir, "swe_test.patch");
  await writeFile(patchPath, testPatch);
  try {
    try {
      await execAsync(`git apply swe_test.patch`, { cwd: tmpDir });
    } catch {
      console.log(`[INFO] Standard git apply failed, trying 3-way merge...`);
      await execAsync(`git apply --3way swe_test.patch`, { cwd: tmpDir });
    }
    console.log(`[INFO] Test patch applied successfully.`);
  } finally {
    await rm(patchPath, { force: true });
  }
}

// Full "make the acceptance tests pristine again, then install them" sequence.
export async function revertAndApplySweTestPatch(tmpDir: string, testPatch: string): Promise<void> {
  await revertAgentTestModifications(tmpDir);
  await applySweTestPatch(tmpDir, testPatch);
}

export async function runSweBenchTestCommand(tmpDir: string, task: any): Promise<{ testExitCode: number | null; testOutput: string; harnessError?: boolean }> {
  const plan = buildSweTestPlan(task);
  if (plan.kind === "invalid") {
    console.error(`[ERROR] Refusing to run SWE-bench test -- ${plan.reason}`);
    return { testExitCode: null, testOutput: `HARNESS_ERROR: ${plan.reason}`, harnessError: true };
  }
  console.log(`[INFO] SWE test command: ${plan.kind === "shell" ? plan.command : `${plan.file} ${plan.args.join(" ")}`}`);
  try {
    const { stdout, stderr } = plan.kind === "shell"
      ? await execAsync(plan.command, { cwd: tmpDir, maxBuffer: 10 * 1024 * 1024, timeout: plan.timeoutMs })
      : await execFileAsync(plan.file, plan.args, { cwd: tmpDir, maxBuffer: 10 * 1024 * 1024, timeout: plan.timeoutMs });
    console.log(`[INFO] SWE-bench test exit code: 0`);
    return { testExitCode: 0, testOutput: `STDOUT:\n${stdout}\nSTDERR:\n${stderr}` };
  } catch (error: any) {
    const testExitCode = error.code ?? 1;
    console.log(`[INFO] SWE-bench test exit code: ${testExitCode}`);
    return { testExitCode, testOutput: `STDOUT:\n${error.stdout || ""}\nSTDERR:\n${error.stderr || ""}\nERROR: ${error.message}` };
  }
}

// A zero exit code alone is not proof: a rigged runner (e.g. a patched
// unittest.TestCase.run) prints "Ran 0 tests ... OK" and exits 0 -- observed
// with a two-line sitecustomize.py in a live grade run. Returns the
// FAIL_TO_PASS ids the test output does NOT show as individually passed.
//  - django (runtests.py --verbosity 2): "<id> ... ok", or "<id>" followed by
//    a docstring line ending "... ok" for tests that have a docstring.
//  - sphinx (pytest -rA): a short-summary line "PASSED <nodeid>".
// Repos without a known per-test format are not checked (returns []).
export function findUnconfirmedTests(repo: string, failToPass: string[], output: string): string[] {
  const lines = output.split("\n").map((l) => l.replace(/\r$/, ""));
  if (repo === "django/django") {
    return failToPass.filter((id) => {
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith(id)) continue;
        if (lines[i] === `${id} ... ok`) return false;
        if (lines[i] === id && i + 1 < lines.length && lines[i + 1].endsWith(" ... ok")) return false;
      }
      return true;
    });
  }
  if (repo === "sphinx-doc/sphinx") {
    const passed = new Set(lines.filter((l) => l.startsWith("PASSED ")).map((l) => l.slice("PASSED ".length).trim()));
    return failToPass.filter((id) => !passed.has(id));
  }
  return [];
}
