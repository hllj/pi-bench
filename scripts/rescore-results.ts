import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface BenchResult {
  task: string;
  judgeScore: number;
  judgeRationale?: string;
  sweContainerTest?: boolean;
  sweTestExitCode?: number | null;
  durationMs: number;
  [key: string]: unknown;
}

export interface RescoreSummary {
  totalFiles: number;
  rescoredFiles: { task: string; from: number; to: number }[];
  oldPassRate: number;
  newPassRate: number;
}

// Mirrors the ground-truth-first logic in src/index.ts's runTask (the
// `scoreSource === "container-test"` branch): for SWE-container tasks the
// stored sweTestExitCode is authoritative, full stop. Historical result
// files written before that logic existed can disagree with it; this
// recomputes what judgeScore SHOULD be without re-running anything.
export function computeGroundTruthScore(
  result: BenchResult
): { judgeScore: number; rescored: boolean } {
  if (result.sweContainerTest !== true || typeof result.sweTestExitCode !== "number") {
    return { judgeScore: result.judgeScore, rescored: false };
  }
  const correct = result.sweTestExitCode === 0 ? 1 : 0;
  return { judgeScore: correct, rescored: correct !== result.judgeScore };
}

export async function rescoreResultsDir(dirPath: string): Promise<RescoreSummary> {
  const files = (await readdir(dirPath)).filter(
    (f) => f.startsWith("results-") && f.endsWith(".json")
  );

  const rescoredFiles: { task: string; from: number; to: number }[] = [];
  let oldPassed = 0;
  let newPassed = 0;

  for (const file of files) {
    const filePath = join(dirPath, file);
    const result: BenchResult = JSON.parse(await readFile(filePath, "utf-8"));
    if (result.judgeScore === 1) oldPassed++;

    const { judgeScore, rescored } = computeGroundTruthScore(result);
    if (rescored) {
      const oldScore = result.judgeScore;
      result.judgeScore = judgeScore;
      result.scoreSource = "container-test-rescore";
      await writeFile(filePath, JSON.stringify(result, null, 2));
      rescoredFiles.push({ task: result.task, from: oldScore, to: judgeScore });
    }
    if (judgeScore === 1) newPassed++;
  }

  const summaryPath = join(dirPath, "summary.json");
  try {
    const summary = JSON.parse(await readFile(summaryPath, "utf-8"));
    if (Array.isArray(summary.results)) {
      summary.results = summary.results.map((r: BenchResult) => {
        const { judgeScore } = computeGroundTruthScore(r);
        return { ...r, judgeScore };
      });
      summary.passedTasks = newPassed;
      summary.passRate = files.length > 0 ? newPassed / files.length : 0;
      await writeFile(summaryPath, JSON.stringify(summary, null, 2));
    }
  } catch {
    // No summary.json (e.g. a single-task run dir) — result files alone are fine.
  }

  return {
    totalFiles: files.length,
    rescoredFiles,
    oldPassRate: files.length > 0 ? oldPassed / files.length : 0,
    newPassRate: files.length > 0 ? newPassed / files.length : 0,
  };
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: bun run scripts/rescore-results.ts <results-dir>");
    process.exit(1);
  }
  const summary = await rescoreResultsDir(dir);
  console.log(`[INFO] Rescored ${summary.rescoredFiles.length}/${summary.totalFiles} result files in ${dir}`);
  for (const r of summary.rescoredFiles) console.log(`  - ${r.task}: ${r.from} -> ${r.to}`);
  console.log(`[INFO] Pass rate: ${(summary.oldPassRate * 100).toFixed(1)}% -> ${(summary.newPassRate * 100).toFixed(1)}%`);
}
