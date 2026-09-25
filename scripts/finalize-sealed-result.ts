// Host-side last step of a sealed SWE-bench task (see run-swe-bench.sh):
// fresh-container grade + host-side judge + proxy egress log
// -> authoritative results-<id>.json (src/finalize.ts).
//
// The judge runs HERE, not in the agent container, so that container never
// holds expectedDiff (the gold patch) or a judge API key.
//
// Usage:
//   bun run scripts/finalize-sealed-result.ts --task <task.json> --grade <grade.json> \
//     --agent-result <untrusted results.json> --egress-log <proxy.jsonl> --out <results.json> \
//     [--provider p] [--model id] [--judge-model provider/id] [--port n] [...other run flags ignored]

import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { mergeSealedResult, type JudgeSummary } from "../src/finalize";
import { buildJudgePrompt, resolveJudgeModel, runJudge } from "../src/judge-run";

async function readJson(path: string | undefined): Promise<any | null> {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: false,
    options: {
      task: { type: "string" },
      grade: { type: "string" },
      "agent-result": { type: "string" },
      "egress-log": { type: "string" },
      out: { type: "string" },
      provider: { type: "string" },
      engine: { type: "string" },
      model: { type: "string" },
      "judge-model": { type: "string" },
      port: { type: "string" },
    },
  });
  const task = await readJson(values.task as string);
  if (!task || !values.out) {
    console.error("[FINALIZE] --task and --out are required");
    process.exit(1);
  }
  const grade = await readJson(values.grade as string);
  const untrusted = await readJson(values["agent-result"] as string);

  const denied: string[] = [];
  if (values["egress-log"] && existsSync(values["egress-log"] as string)) {
    for (const line of (await readFile(values["egress-log"] as string, "utf-8")).split("\n")) {
      try {
        const e = JSON.parse(line);
        if (e.decision === "deny" && typeof e.target === "string") denied.push(e.target);
      } catch {}
    }
  }

  // Judge (explanation only -- the grade decides the score). Same model
  // resolution as src/index.ts: --judge-model, else the agent model.
  let judge: JudgeSummary | null = null;
  if (grade) {
    try {
      const provider = (values.provider || values.engine || "llama.cpp") as string;
      let agentReq: any;
      if (values.model) {
        const m = values.model as string;
        agentReq = m.includes("/") && !values.provider
          ? { provider: m.split("/")[0], id: m.split("/").slice(1).join("/") }
          : { provider, id: m };
      }
      let judgeReq: any;
      if (values["judge-model"]) {
        const parts = (values["judge-model"] as string).split("/");
        if (parts.length > 1) judgeReq = { provider: parts[0], id: parts.slice(1).join("/") };
      }
      let modelsPath: string | undefined = existsSync("models.json") ? "models.json" : undefined;
      if (modelsPath && values.port) {
        const data = JSON.parse(await readFile(modelsPath, "utf-8"));
        if (data.providers?.[provider]?.baseUrl) {
          data.providers[provider].baseUrl = data.providers[provider].baseUrl.replace(/:\d+/, `:${values.port}`);
        }
        modelsPath = join(tmpdir(), `pi-bench-finalize-models-${process.pid}.json`);
        await writeFile(modelsPath, JSON.stringify(data));
      }
      const modelRuntime = await ModelRuntime.create(modelsPath ? { modelsPath } : undefined);
      const modelRegistry = new ModelRegistry(modelRuntime);
      const agentModel = agentReq
        ? modelRegistry.find(agentReq.provider, agentReq.id)
        : modelRegistry.getAll().find((m: any) => m.provider === provider);
      const judgeModel = resolveJudgeModel(modelRegistry, judgeReq, agentModel);
      const judgePrompt = buildJudgePrompt({
        task,
        expectedDiff: task.expectedDiff || "",
        diff: typeof untrusted?.diff === "string" ? untrusted.diff : "",
        testExitCode: grade.testExitCode,
        testOutput: grade.testOutput || "",
        isSweContainer: true,
      });
      const outcome = await runJudge(modelRuntime, modelRegistry, judgeModel, judgePrompt);
      judge = { ...outcome, judgeModel: `${judgeModel.provider}/${judgeModel.id}` };
    } catch (e: any) {
      console.warn(`[FINALIZE] Judge failed (score is unaffected -- it comes from the grade): ${e?.message || e}`);
      judge = { judgeScore: null, rationale: `Judge error: ${e?.message || e}`, judgeParseFailed: true, judgeAttemptsUsed: 0 };
    }
  }

  const result = mergeSealedResult({ taskId: task.id, untrusted, grade, judge, egress: { denied } });
  await writeFile(values.out as string, JSON.stringify(result, null, 2));
  console.log(
    `[FINALIZE] ${task.id}: score=${result.judgeScore} source=${result.scoreSource}` +
      (result.tamperFiles?.length ? ` TAMPER=${JSON.stringify(result.tamperFiles)}` : "") +
      (result.egressDeniedByProxy ? ` egressDenied=${result.egressDeniedByProxy}` : "")
  );
}

await main();
