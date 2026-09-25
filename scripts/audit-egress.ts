// Audits existing benchmark runs for network-fetch contamination: agents that
// pulled upstream sources/history (pip download of a later release, curl on
// raw.githubusercontent.com, api.github.com PR search, git clone/fetch...)
// while running UNSEALED, i.e. before run-swe-bench.sh's sealed mode existed.
//
// Usage:
//   bun run scripts/audit-egress.ts [results-dir-or-root ...]   (default: benchmark_results)
//   bun run scripts/audit-egress.ts benchmark_results --mark     also write the flags into results-*.json
//   bun run scripts/audit-egress.ts benchmark_results --json     machine-readable report
//
// --mark adds `egressAttemptCount`, `egressAttempts`, `contaminationSuspected`
// to each audited results file (same fields a sealed run records live). It
// never changes judgeScore -- whether to exclude flagged passes from a
// leaderboard is a reporting decision, not something to bake into the data.

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { detectEgressAttempt, type EgressAttempt } from "../src/egress";

interface TaskAudit {
  run: string;
  task: string;
  passed: boolean;
  sealed: boolean;
  attempts: EgressAttempt[];
  contaminated: boolean;
}

async function* walkTranscripts(root: string): AsyncGenerator<string> {
  const s = await stat(root);
  if (s.isFile()) {
    if (basename(root).startsWith("transcript-") && root.endsWith(".json")) yield root;
    return;
  }
  for (const entry of await readdir(root)) {
    yield* walkTranscripts(join(root, entry));
  }
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    // Older transcripts store Python-repr-ish strings; the command text is
    // still in there, which is all the detector needs.
    const m = raw.match(/['"]command['"]\s*:\s*(['"])([\s\S]*)\1\s*[,}]/);
    return m ? { command: m[2] } : raw;
  }
}

export function auditTranscript(messages: any[]): EgressAttempt[] {
  const found: EgressAttempt[] = [];
  for (const m of messages) {
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const item of m.content) {
      if (item?.type !== "toolCall") continue;
      const a = detectEgressAttempt(item.name, parseArgs(item.arguments));
      if (a) found.push(a);
    }
  }
  return found;
}

async function main() {
  const argv = process.argv.slice(2);
  const mark = argv.includes("--mark");
  const asJson = argv.includes("--json");
  const roots = argv.filter((a) => !a.startsWith("--"));
  if (roots.length === 0) roots.push("benchmark_results");

  const audits: TaskAudit[] = [];
  for (const root of roots) {
    for await (const tpath of walkTranscripts(root)) {
      const file = basename(tpath);
      // Per-attempt transcripts are folded into the combined results file;
      // audit the combined transcript when there is one, else each attempt.
      const task = file.replace(/^transcript-/, "").replace(/\.json$/, "");
      const resultPath = join(dirname(tpath), `results-${task}.json`);
      let result: any = null;
      try {
        result = JSON.parse(await readFile(resultPath, "utf-8"));
      } catch {
        continue; // transcript without a result (aborted run) -- nothing to flag
      }
      let messages: any[];
      try {
        messages = JSON.parse(await readFile(tpath, "utf-8"));
      } catch {
        continue;
      }
      const attempts = auditTranscript(Array.isArray(messages) ? messages : []);
      const contaminated = attempts.some((a) => a.category === "upstream-source");
      audits.push({
        run: dirname(tpath),
        task,
        passed: result.judgeScore === 1,
        sealed: result.sealedNetwork === true,
        attempts,
        contaminated,
      });
      if (mark && !result.sealedNetwork) {
        result.egressAttemptCount = attempts.length;
        result.egressAttempts = attempts.slice(0, 20);
        result.contaminationSuspected = contaminated;
        await writeFile(resultPath, JSON.stringify(result, null, 2));
      }
    }
  }

  if (asJson) {
    console.log(JSON.stringify(audits.filter((a) => a.attempts.length > 0), null, 2));
    return;
  }

  const byRun = new Map<string, TaskAudit[]>();
  for (const a of audits) {
    if (!/-attempt\d+$/.test(a.task) || !audits.some((b) => b.run === a.run && b.task === a.task.replace(/-attempt\d+$/, ""))) {
      if (!byRun.has(a.run)) byRun.set(a.run, []);
      byRun.get(a.run)!.push(a);
    }
  }
  console.log(`run | tasks | upstream-fetch tasks | ...of which PASSED | pass rate | pass rate excl. contaminated passes`);
  for (const [run, tasks] of [...byRun.entries()].sort()) {
    const contaminated = tasks.filter((t) => t.contaminated);
    if (contaminated.length === 0) continue;
    const passed = tasks.filter((t) => t.passed).length;
    const contaminatedPasses = contaminated.filter((t) => t.passed);
    const cleanRate = (passed - contaminatedPasses.length) / tasks.length;
    console.log(
      `${run} | ${tasks.length} | ${contaminated.length} | ${contaminatedPasses.length} | ${((passed / tasks.length) * 100).toFixed(1)}% | ${(cleanRate * 100).toFixed(1)}%`
    );
    for (const t of contaminatedPasses) {
      const ex = t.attempts.find((a) => a.category === "upstream-source")!;
      console.log(`    PASS ${t.task}: ${ex.snippet.replace(/\s+/g, " ").slice(0, 140)}`);
    }
  }
  if (mark) console.log(`\n[INFO] --mark: wrote egress fields into unsealed results files.`);
}

if (import.meta.main) {
  await main();
}
