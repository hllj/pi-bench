import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeGroundTruthScore, rescoreResultsDir } from "./rescore-results";

describe("computeGroundTruthScore", () => {
  test("flips a stale 0 to 1 when the container test actually passed", () => {
    const result = {
      task: "sphinx-doc__sphinx-7985",
      judgeScore: 0,
      judgeRationale: "stale rationale",
      sweContainerTest: true,
      sweTestExitCode: 0,
      durationMs: 1000,
    };
    const out = computeGroundTruthScore(result as any);
    expect(out.judgeScore).toBe(1);
    expect(out.rescored).toBe(true);
  });

  test("leaves a genuinely-failed test at 0 and reports no change", () => {
    const result = {
      task: "django__django-12308",
      judgeScore: 0,
      sweContainerTest: true,
      sweTestExitCode: 1,
      durationMs: 1000,
    };
    const out = computeGroundTruthScore(result as any);
    expect(out.judgeScore).toBe(0);
    expect(out.rescored).toBe(false);
  });

  test("leaves non-container-test results untouched", () => {
    const result = {
      task: "curated-task-1",
      judgeScore: 1,
      sweContainerTest: false,
      sweTestExitCode: null,
      durationMs: 1000,
    };
    const out = computeGroundTruthScore(result as any);
    expect(out.judgeScore).toBe(1);
    expect(out.rescored).toBe(false);
  });

  test("already-correct score reports no change even though it's a container test", () => {
    const result = {
      task: "django__django-11964",
      judgeScore: 1,
      sweContainerTest: true,
      sweTestExitCode: 0,
      durationMs: 1000,
    };
    const out = computeGroundTruthScore(result as any);
    expect(out.judgeScore).toBe(1);
    expect(out.rescored).toBe(false);
  });
});

describe("rescoreResultsDir", () => {
  test("rewrites result files and summary.json, reporting the pass-rate delta", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rescore-test-"));
    try {
      const stale = {
        task: "sphinx-doc__sphinx-7985",
        judgeScore: 0,
        judgeRationale: "stale",
        sweContainerTest: true,
        sweTestExitCode: 0,
        durationMs: 500,
      };
      const correct = {
        task: "django__django-11964",
        judgeScore: 1,
        sweContainerTest: true,
        sweTestExitCode: 0,
        durationMs: 700,
      };
      await writeFile(join(dir, "results-sphinx-doc__sphinx-7985.json"), JSON.stringify(stale));
      await writeFile(join(dir, "results-django__django-11964.json"), JSON.stringify(correct));
      await writeFile(join(dir, "summary.json"), JSON.stringify({
        totalTasks: 2, passedTasks: 1, passRate: 0.5,
        totalDurationMs: 1200, averageDurationMs: 600,
        results: [stale, correct],
      }));

      const summary = await rescoreResultsDir(dir);

      expect(summary.totalFiles).toBe(2);
      expect(summary.rescoredFiles).toEqual(["sphinx-doc__sphinx-7985"]);
      expect(summary.oldPassRate).toBe(0.5);
      expect(summary.newPassRate).toBe(1);

      const rewritten = JSON.parse(
        await readFile(join(dir, "results-sphinx-doc__sphinx-7985.json"), "utf-8")
      );
      expect(rewritten.judgeScore).toBe(1);
      expect(rewritten.judgeRationale).toBe("stale"); // rationale text preserved, only score fixed

      const newSummary = JSON.parse(await readFile(join(dir, "summary.json"), "utf-8"));
      expect(newSummary.passedTasks).toBe(2);
      expect(newSummary.passRate).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
