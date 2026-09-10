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

  test("flips a false positive from 1 to 0 when the container test actually failed", () => {
    const result = {
      task: "sphinx-doc__sphinx-9461",
      judgeScore: 1,
      judgeRationale: "agent code looks good",
      sweContainerTest: true,
      sweTestExitCode: 1,
      durationMs: 1000,
    };
    const out = computeGroundTruthScore(result as any);
    expect(out.judgeScore).toBe(0);
    expect(out.rescored).toBe(true);
  });
});

describe("rescoreResultsDir", () => {
  test("rewrites result files and summary.json, reporting the pass-rate delta with direction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rescore-test-"));
    try {
      const falseNegative = {
        task: "sphinx-doc__sphinx-7985",
        judgeScore: 0,
        judgeRationale: "stale",
        sweContainerTest: true,
        sweTestExitCode: 0,
        durationMs: 500,
      };
      const falsePositive = {
        task: "sphinx-doc__sphinx-9461",
        judgeScore: 1,
        judgeRationale: "looks good",
        sweContainerTest: true,
        sweTestExitCode: 1,
        durationMs: 600,
      };
      const correct = {
        task: "django__django-11964",
        judgeScore: 1,
        sweContainerTest: true,
        sweTestExitCode: 0,
        durationMs: 700,
      };
      await writeFile(join(dir, "results-sphinx-doc__sphinx-7985.json"), JSON.stringify(falseNegative));
      await writeFile(join(dir, "results-sphinx-doc__sphinx-9461.json"), JSON.stringify(falsePositive));
      await writeFile(join(dir, "results-django__django-11964.json"), JSON.stringify(correct));
      await writeFile(join(dir, "summary.json"), JSON.stringify({
        totalTasks: 3, passedTasks: 2, passRate: 2 / 3,
        totalDurationMs: 1800, averageDurationMs: 600,
        results: [falseNegative, falsePositive, correct],
      }));

      const summary = await rescoreResultsDir(dir);

      expect(summary.totalFiles).toBe(3);
      // rescoredFiles are in file system order; just verify both expected items are present
      expect(summary.rescoredFiles).toContainEqual({ task: "sphinx-doc__sphinx-7985", from: 0, to: 1 });
      expect(summary.rescoredFiles).toContainEqual({ task: "sphinx-doc__sphinx-9461", from: 1, to: 0 });
      expect(summary.rescoredFiles.length).toBe(2);
      expect(summary.oldPassRate).toBeCloseTo(2 / 3, 5);
      expect(summary.newPassRate).toBeCloseTo(2 / 3, 5);

      const rewrittenFalseNeg = JSON.parse(
        await readFile(join(dir, "results-sphinx-doc__sphinx-7985.json"), "utf-8")
      );
      expect(rewrittenFalseNeg.judgeScore).toBe(1);
      expect(rewrittenFalseNeg.judgeRationale).toBe("stale");

      const rewrittenFalsePos = JSON.parse(
        await readFile(join(dir, "results-sphinx-doc__sphinx-9461.json"), "utf-8")
      );
      expect(rewrittenFalsePos.judgeScore).toBe(0);
      expect(rewrittenFalsePos.judgeRationale).toBe("looks good");

      const newSummary = JSON.parse(await readFile(join(dir, "summary.json"), "utf-8"));
      expect(newSummary.passedTasks).toBe(2);
      expect(newSummary.passRate).toBeCloseTo(2 / 3, 5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
