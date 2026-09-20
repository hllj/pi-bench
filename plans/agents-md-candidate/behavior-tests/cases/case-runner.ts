// Runs ONE behaviour case in a harness-equivalent pi session (same createAgentSession call, tool exclusions and
// active-tool resync as src/index.ts) against a fresh scratch repo, then dumps transcript + outcome as JSON.
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sdk: any = await import("/pi-bench/node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const { createAgentSession, SessionManager, ModelRuntime, ModelRegistry } = sdk;
const { buildAgentPrompt } = await import("/pi-bench/src/prompts.ts");

interface Case { repo: string; prompt: string; bench?: boolean; outcome?: string }
const TEST = "node test.js";
const CASES: Record<string, Case> = {
  // skill: dev-workflows should match a plain bug report
  S1: { repo: "A-slugify", outcome: TEST,
    prompt: "There's a bug in this repo: `slugify('Hello  World')` (two spaces) returns 'hello--world' but should return 'hello-world'. Can you fix it?" },
  // same, under the benchmark's autonomous framing
  S1b: { repo: "A-slugify", bench: true, outcome: TEST,
    prompt: "slugify('Hello  World') returns 'hello--world' but it should return 'hello-world'. Fix slugify in src/util.js." },
  // skill: pi-lens-ast-grep should match a codebase-wide rename
  S2: { repo: "B-rename", outcome: "node test.js && ! grep -rn --include=*.js legacyFetch src",
    prompt: "Rename the function legacyFetch to fetchJson everywhere in this repo: the definition, the export, every import and every call site (including aliased imports). Don't change anything else." },
  // subagent: an explicit natural-language ask to delegate
  S3: { repo: "A-slugify",
    prompt: "Please have a subagent review src/util.js for edge cases and report back what it finds. Don't change any files." },
  // negative control: read-only question, nothing should be delegated or edited
  S4: { repo: "A-slugify",
    prompt: "In two sentences, what does slugify in src/util.js do?" },
  // delegation trigger: the user does not know which files are involved
  S5: { repo: "C-cart", outcome: TEST,
    prompt: "Orders with a fixed-amount coupon sometimes come out with the wrong total. I don't know where the problem is — find it and fix it." },
  S5b: { repo: "C-cart", bench: true, outcome: TEST,
    prompt: "Orders with a fixed-amount coupon sometimes come out with the wrong total. Find the cause and fix it. Do not edit test.js." },
  // recursion guard: a child (prompt starts with `Task:`) must not delegate further
  S6: { repo: "C-cart", outcome: TEST,
    prompt: "Task: Audit this repository for bugs, fix every bug you find, and make sure `node test.js` passes." },
  // checkpoint & fork: three sequential bugs, so verification fails repeatedly
  S7: { repo: "D-price", outcome: TEST,
    prompt: "`node test.js` is failing because `priceLabel` gives wrong output. Please make the tests pass. Don't edit test.js." },
};

const CASE = process.env.CASE!, COND = process.env.COND!, REP = process.env.REP ?? "1";
const MAX_MS = Number(process.env.MAX_MS ?? 600_000);
const c = CASES[CASE];
if (!c) throw new Error(`unknown case ${CASE}`);

const sh = (cwd: string, cmd: string, timeout = 60_000) =>
  spawnSync("bash", ["-c", cmd], { cwd, timeout, encoding: "utf8" });

const cwd = mkdtempSync(join(tmpdir(), `case-${CASE}-`));
cpSync(`/diag/cases/repos/${c.repo}`, cwd, { recursive: true });
sh(cwd, "git init -q && git add -A && git -c user.email=t@t.t -c user.name=t commit -q -m init");

const modelRuntime = await ModelRuntime.create();
const model = new ModelRegistry(modelRuntime).find("openrouter", process.env.MODEL ?? "deepseek/deepseek-v4-flash-0731");
const excludeTools = ["web_search", "web_fetch", "question", "questionnaire"]; // benchmark defaults
const { session } = await createAgentSession({ cwd, sessionManager: SessionManager.inMemory(cwd), modelRuntime, model, excludeTools });
session.setActiveToolsByName(session.getAllTools().map((t: any) => t.name)); // as src/index.ts does

const text = c.bench ? buildAgentPrompt({ tmpDir: cwd, isSweContainer: false, taskPrompt: c.prompt }) : c.prompt;

const t0 = Date.now();
let timedOut = false;
let err = "";
await Promise.race([
  session.prompt(text).catch((e: any) => { err = String(e?.message ?? e); }),
  new Promise((r) => setTimeout(() => { timedOut = true; r(null); }, MAX_MS)),
]);
if (timedOut) await Promise.race([session.abort().catch(() => {}), new Promise((r) => setTimeout(r, 20_000))]);
const elapsedMs = Date.now() - t0;

let outcome: any = null;
if (c.outcome) {
  const r = sh(cwd, c.outcome);
  outcome = { exit: r.status, tail: ((r.stdout ?? "") + (r.stderr ?? "")).slice(-300) };
}
const changed = sh(cwd, "git status --short").stdout;

writeFileSync(`/out/${COND}-${CASE}-r${REP}.json`, JSON.stringify({
  case: CASE, cond: COND, rep: REP, elapsedMs, timedOut, err, outcome, changed, prompt: text.slice(0, 300),
  messages: session.messages,
}));
console.log(`[${COND}/${CASE}/r${REP}] done in ${(elapsedMs / 1000).toFixed(0)}s timedOut=${timedOut} outcome=${outcome ? outcome.exit : "n/a"}`);
process.exit(0);
