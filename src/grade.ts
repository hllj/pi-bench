// Authoritative SWE-bench grader. Runs in a FRESH container started from
// the task image (run-swe-bench.sh, sealed mode, `--network none`), never in
// the container the agent worked in.
//
// Why: the agent runs as root in its own container, so anything graded there
// can be rigged from outside the diff -- a sitecustomize.py or .pth file in
// site-packages (writable), a patched pytest/unittest, a doctored test log.
// None of that survives here: this container starts from the pristine image,
// the ONLY thing carried over is the agent's diff (repo-relative, applied
// with `git apply`, which refuses paths outside the repo and .git), and the
// hidden tests are installed exactly as in the harness.
//
// Usage (inside the fresh container):
//   bun run src/grade.ts <grade-input.json> <grade-output.json>
// grade-input.json: { task: { id, repo, failToPass, testPatch }, diff }

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { findUnconfirmedTests, revertAndApplySweTestPatch, runSweBenchTestCommand } from "./swe-tests";

const execAsync = promisify(exec);

// Files Python imports implicitly at interpreter/pytest start-up. A diff that
// adds or edits one can make every test "pass" without fixing anything, and
// no legitimate SWE-bench fix needs one. conftest.py is allowed only inside
// the test dirs, which the grader reverts to pristine before running anyway.
const TEST_DIRS = ["tests/", "test/", "testing/"];

export function diffPaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) {
      paths.add(m[1]);
      paths.add(m[2]);
    }
  }
  return [...paths].sort();
}

export function findTamperFiles(diff: string): string[] {
  return diffPaths(diff).filter((p) => {
    const base = p.split("/").pop() || "";
    if (base === "sitecustomize.py" || base === "usercustomize.py" || base.endsWith(".pth")) return true;
    if (base === "conftest.py" && !TEST_DIRS.some((d) => p.startsWith(d))) return true;
    return false;
  });
}

export interface GradeResult {
  taskId: string;
  diffApplied: boolean;
  applyError?: string;
  tamperFiles: string[];
  testExitCode: number | null;
  testOutput: string;
  harnessError: boolean;
  unconfirmedTests?: string[];
}

async function git(cmd: string, cwd: string) {
  return execAsync(`git -c user.email=bench@pi.local -c user.name=Pi-Grader ${cmd}`, { cwd, maxBuffer: 10 * 1024 * 1024 });
}

export async function gradeInFreshContainer(input: { task: any; diff: string }, testbed = "/testbed"): Promise<GradeResult> {
  const { task, diff } = input;
  const result: GradeResult = {
    taskId: task.id,
    diffApplied: false,
    tamperFiles: findTamperFiles(diff || ""),
    testExitCode: null,
    testOutput: "",
    harnessError: false,
  };

  // Same comparison base the agent's diff was taken against: the image's
  // working tree as shipped (including any pre-existing dirty files),
  // committed so `git checkout HEAD -- tests/` restores exactly it.
  if (!existsSync(`${testbed}/.git`)) await git("init -q", testbed);
  await git("add -A", testbed);
  await git("commit -q --allow-empty -m grade-baseline", testbed);

  if (diff && diff.trim()) {
    // Outside /testbed so the patch file itself can't end up under test.
    const diffPath = "/tmp/pi-bench-agent.diff";
    await writeFile(diffPath, diff.endsWith("\n") ? diff : diff + "\n");
    try {
      await git(`apply --whitespace=nowarn ${diffPath}`, testbed);
      result.diffApplied = true;
    } catch (e: any) {
      try {
        await git(`apply --whitespace=nowarn --recount ${diffPath}`, testbed);
        result.diffApplied = true;
      } catch (e2: any) {
        result.applyError = String(e2?.stderr || e2?.message || e?.message).slice(0, 2000);
        console.error(`[GRADE] Agent diff did not apply: ${result.applyError}`);
      }
    }
  } else {
    result.diffApplied = true; // nothing to apply; the tests decide
  }

  if (task.testPatch) {
    try {
      await revertAndApplySweTestPatch(testbed, task.testPatch);
    } catch (e) {
      console.warn(`[GRADE] Failed to apply test patch:`, e);
    }
  }

  const run = await runSweBenchTestCommand(testbed, task);
  result.testExitCode = run.testExitCode;
  result.testOutput = run.testOutput;
  result.harnessError = !!run.harnessError;

  // Exit 0 must be backed by every FAIL_TO_PASS test visibly passing -- a
  // diff that rigs the runner from an innocently-named module (not caught by
  // findTamperFiles) still can't make tests it never ran show up as passed.
  result.unconfirmedTests = [];
  if (result.testExitCode === 0) {
    result.unconfirmedTests = findUnconfirmedTests(task.repo, task.failToPass || [], run.testOutput);
    if (result.unconfirmedTests.length > 0) {
      console.error(`[GRADE] Exit 0 but ${result.unconfirmedTests.length} FAIL_TO_PASS test(s) not reported as passed -- scoring as a fail.`);
      result.testExitCode = 1;
    }
  }
  return result;
}

if (import.meta.main) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    console.error("Usage: bun run src/grade.ts <grade-input.json> <grade-output.json>");
    process.exit(1);
  }
  const input = JSON.parse(await readFile(inputPath, "utf-8"));
  const grade = await gradeInFreshContainer(input);
  await writeFile(outputPath, JSON.stringify(grade, null, 2));
  console.log(`[GRADE] ${grade.taskId}: diffApplied=${grade.diffApplied} tamperFiles=${JSON.stringify(grade.tamperFiles)} testExitCode=${grade.testExitCode} harnessError=${grade.harnessError}`);
}
