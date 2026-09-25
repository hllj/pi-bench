import {
  createAgentSession,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { parseJudgeOutput } from "./judge";
import { buildAgentPrompt, buildVerificationRetryPrompt } from "./prompts";
import { shouldIssueBudgetNudge, trackGitArchaeology, type ArchaeologyState } from "./loop-guard";
import { extractDjangoTestModules, validateFailToPass } from "./task-validation";
import { classifyConfigDiff, extractToolFilePath, isConfigArtifactFile } from "./config-guard";
import { scrubGitHistoryToOrphanBaseline } from "./git-scrub";
import { detectEgressAttempt, egressTargetFromBaseUrl, rewriteLocalBaseUrl, type EgressAttempt } from "./egress";

// Hostname that reaches the machine running the local inference server. A
// sealed SWE container (run-swe-bench.sh) has no route to the host's
// loopback, so it sets this to host.docker.internal and all localhost model
// URLs are rewritten to go through the egress proxy.
const LOCAL_HOST = process.env.PI_BENCH_LOCAL_HOST || "localhost";

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

type SweTestPlan =
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
function buildSweTestPlan(task: any): SweTestPlan {
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
    return { kind: "execFile", file: python, args: ["-m", "pytest", ...failToPass, "-x", "-vs"], timeoutMs };
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
async function revertAgentTestModifications(tmpDir: string): Promise<void> {
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
async function applySweTestPatch(tmpDir: string, testPatch: string): Promise<void> {
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
async function revertAndApplySweTestPatch(tmpDir: string, testPatch: string): Promise<void> {
  await revertAgentTestModifications(tmpDir);
  await applySweTestPatch(tmpDir, testPatch);
}

async function runSweBenchTestCommand(tmpDir: string, task: any): Promise<{ testExitCode: number | null; testOutput: string; harnessError?: boolean }> {
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

async function runTask(taskFile: string, agentModelReq: any, judgeModelReq: any, outputDir: string = ".", timeoutMin: number = 30, provider: string = "llama.cpp", port?: string, contextWindowOverride?: number, excludeTools?: string[], consumeTask = false) {
  const taskContent = await readFile(taskFile, "utf-8");
  const task = JSON.parse(taskContent);
  if (consumeTask) {
    // The task file carries the answer (expectedDiff = the gold patch,
    // testPatch = the hidden acceptance tests). In sealed mode it's a
    // per-task staged copy; delete it before the agent gets a shell so the
    // only copy left is in this process's memory.
    await rm(taskFile, { force: true });
    console.log(`[INFO] Consumed staged task file ${taskFile} (removed before agent start).`);
  }

  console.log(`\n======================================================`);
  console.log(`[INFO] Starting benchmark for task file: ${taskFile}`);
  console.log(`======================================================\n`);

  const sweTestbed = "/testbed";
  const isSweContainer = existsSync(sweTestbed);
  const tmpDir = isSweContainer ? sweTestbed : await mkdtemp(join(tmpdir(), "pi-bench-"));
  console.log(`[INFO] Working directory: ${tmpDir} (SWE container: ${isSweContainer})`);

  try {
    if (isSweContainer) {
      console.log(`[INFO] Using pre-configured SWE-bench testbed at ${sweTestbed}`);
      // Ensure git is initialized, then collapse to a single ORPHAN baseline
      // commit. This does two things at once:
      // (a) pre-existing image noise (e.g. setup.py/tox.ini/CHANGES shipped
      //     dirty) is NOT attributed to the agent's diff -- the agent's
      //     changes are diffed against this baseline exactly (same as the
      //     old plain "benchmark-baseline" commit); and
      // (b) SWE-bench images ship the FULL upstream repo history, including
      //     commits/tags authored AFTER this task's base commit. An agent
      //     that runs `git log`/`git show`/checks out a future tag can read
      //     off the real upstream fix instead of solving the task (observed
      //     on sphinx-doc__sphinx-9320 and sphinx-doc__sphinx-8548 --
      //     45 minutes burned chasing tags v4.1.0..v8.1.3 with zero source
      //     edits; see plans/improvement-plan.md cross-cutting finding #1).
      //     An orphan commit has no parents, so `git log` can only ever show
      //     this one commit -- and deleting every other ref/tag below drops
      //     the loose future-commit objects entirely.
      // Note: only the individual ref/tag/gc cleanup steps inside this call
      // are best-effort (each swallows its own error) -- a failure to create
      // the orphan branch or the baseline commit itself still throws here,
      // aborting the task exactly as the old unwrapped git init/commit calls
      // did, rather than silently proceeding with a dirty comparison base.
      const { staleRefsDropped } = await scrubGitHistoryToOrphanBaseline(tmpDir);
      console.log(`[INFO] Baseline commit created on an orphan branch (pre-existing image changes AND future git history/tags excluded, ${staleRefsDropped} stale ref(s) dropped).`);
    } else {
      console.log(`[INFO] Cloning ${task.repo} at commit ${task.commit}...`);
      await execAsync(`git init`, { cwd: tmpDir });
      await execAsync(`git remote add origin https://github.com/${task.repo}.git`, { cwd: tmpDir });
      await execAsync(`git fetch --depth 1 origin ${task.commit}`, { cwd: tmpDir });
      await execAsync(`git checkout --detach FETCH_HEAD`, { cwd: tmpDir });
      await execAsync(`git reset --hard FETCH_HEAD`, { cwd: tmpDir });
    }

    console.log(`[INFO] Initializing agent session...`);

    const localModelsPath = join(process.cwd(), "models.json");
    let modelsPath: string | undefined;
    if (existsSync(localModelsPath)) {
      console.log(`[INFO] Using local models.json configuration`);
      if (port || LOCAL_HOST !== "localhost") {
        const modelsContent = await readFile(localModelsPath, "utf-8");
        const modelsData = JSON.parse(modelsContent);
        if (port && modelsData.providers && modelsData.providers[provider] && modelsData.providers[provider].baseUrl) {
          modelsData.providers[provider].baseUrl = modelsData.providers[provider].baseUrl.replace(/:\d+/, `:${port}`);
        }
        for (const p of Object.values<any>(modelsData.providers || {})) {
          if (p && typeof p.baseUrl === "string") p.baseUrl = rewriteLocalBaseUrl(p.baseUrl, LOCAL_HOST);
        }
        const tmpModelsPath = tmpDir + "-models.json";
        await writeFile(tmpModelsPath, JSON.stringify(modelsData));
        modelsPath = tmpModelsPath;
      } else {
        modelsPath = localModelsPath;
      }
    } else {
      if (port) {
        const modelsData = {
          providers: {
            [provider]: {
              baseUrl: `http://${LOCAL_HOST}:${port}/v1`,
              api: "openai-completions",
              apiKey: "none",
              models: [{ id: "local-model", contextWindow: contextWindowOverride || 128000, maxTokens: 65536 }]
            }
          }
        };
        const tmpModelsPath = tmpDir + "-models.json";
        await writeFile(tmpModelsPath, JSON.stringify(modelsData));
        modelsPath = tmpModelsPath;
      }
    }

    const modelRuntime = await ModelRuntime.create(modelsPath ? { modelsPath } : undefined);
    const modelRegistry = new ModelRegistry(modelRuntime);

    let resolvedAgentModel;
    if (agentModelReq) {
      resolvedAgentModel = modelRegistry.find(agentModelReq.provider, agentModelReq.id);
      if (!resolvedAgentModel) {
        throw new Error(`Could not find model ${agentModelReq.provider}/${agentModelReq.id} in registry`);
      }
    } else {
      const providerModels = modelRegistry.getAll().filter((m: any) => m.provider === provider);
      if (providerModels.length > 0) {
        resolvedAgentModel = providerModels[0];
        console.log(`[INFO] No agent model specified, defaulting to ${resolvedAgentModel.provider}/${resolvedAgentModel.id}`);
      }
    }

    // Apply --context override to the resolved model (wins over models.json)
    if (contextWindowOverride && resolvedAgentModel) {
      resolvedAgentModel = { ...resolvedAgentModel, contextWindow: contextWindowOverride };
      console.log(`[INFO] Context window overridden to ${contextWindowOverride} tokens`);
    }

    const { session } = await createAgentSession({
      cwd: tmpDir,
      sessionManager: SessionManager.inMemory(tmpDir),
      modelRuntime,
      model: resolvedAgentModel,
      excludeTools: excludeTools && excludeTools.length > 0 ? excludeTools : undefined,
    });

    // createAgentSession() activates extension tools via a synchronous snapshot
    // taken during construction, racing against async extension loading (jiti
    // dynamic imports). Large extensions like pi-config's `subagent` can lose
    // that race and end up registered but not active - the model then sees no
    // subagent/run_workflow tool at all. Re-sync from the full registry now
    // that extension loading has settled; this only adds tools, it can't
    // reintroduce anything excludeTools already filtered out of the registry.
    session.setActiveToolsByName(session.getAllTools().map((t) => t.name));

    console.log(`[INFO] Agent resolved to model: ${session.model?.provider}/${session.model?.id}`);

    let lastToolName = "";
    let lastToolArgs = "";
    let repeatedToolCount = 0;
    let loopDetected = false;
    let loopRecoveries = 0;

    let archaeologyState: ArchaeologyState = { count: 0 };
    let archaeologyNudgeNeeded = false;
    let archaeologyNudgesUsed = 0;
    const maxArchaeologyNudges = 2;

    // Config-file early-warning: catches the agent editing a build/env
    // artifact (setup.py, tox.ini, ...) THE MOMENT it happens, rather than
    // only at the very end via the diff-based check below (see
    // plans/improvement-plan.md cross-cutting finding #2 -- by the time the
    // end-of-run check fires, the time budget is already spent). One-shot:
    // a single nudge per task, mirroring the archaeology-nudge budget.
    let configFileWarningNeeded = false;
    let configFileWarningIssued = false;
    let lastTouchedConfigFile = "";

    // Time-budget nudge: fires once at 50% of the time budget so the agent
    // can be steered to stop broad exploration and finish up, instead of the
    // only prior time-based signal being a hard abort at 100% (too late to
    // recover any of the wasted time -- see plans/improvement-plan.md P0
    // item 6 and sphinx-doc__sphinx-9320: 45 min, zero source edits).
    // Declared here (before the timeout/start below are assigned) but only
    // ever read inside the subscribe callback, which can't fire until
    // session.prompt() runs further down -- by then both are set.
    let budgetNudgeNeeded = false;
    let budgetNudgeIssued = false;

    // Audit trail of network-fetch attempts (pip download, git clone, curl
    // github/pypi, ...). Enforcement is the sealed network, not this -- see
    // src/egress.ts -- but a result that passed while the agent was reaching
    // for upstream sources must be visible in the JSON, not just the logs.
    const egressAttempts: EgressAttempt[] = [];
    const MAX_RECORDED_EGRESS_ATTEMPTS = 20;
    let egressAttemptCount = 0;
    const start = Date.now();
    const timeoutMs = timeoutMin * 60 * 1000;

    session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent) {
        if (event.assistantMessageEvent.type === "text_delta") {
          process.stdout.write(event.assistantMessageEvent.delta);
        } else if (event.assistantMessageEvent.type === "error") {
          console.error(`\n[ERROR] Agent LLM Error:`, event.assistantMessageEvent.error);
        }
      } else if (event.type === "tool_execution_start") {
        let argsStr = "";
        try {
          argsStr = JSON.stringify(event.args);

          if (argsStr === lastToolArgs && event.toolName === lastToolName) {
            repeatedToolCount++;
          } else {
            repeatedToolCount = 1;
            lastToolName = event.toolName;
            lastToolArgs = argsStr;
          }

          if (repeatedToolCount >= 3) {
            console.warn(`\n[WARN] Loop detected! Tool ${event.toolName} called ${repeatedToolCount} times with same arguments.`);
            loopDetected = true;
            session.abort();
          }

          if (!loopDetected && !archaeologyNudgeNeeded && trackGitArchaeology(archaeologyState, event.toolName, argsStr)) {
            console.warn(`\n[WARN] Git-archaeology streak detected (${archaeologyState.count} history calls, no edits). Nudging agent to make a change.`);
            archaeologyNudgeNeeded = true;
            session.abort();
          }

          if (
            isSweContainer &&
            !loopDetected &&
            !archaeologyNudgeNeeded &&
            !configFileWarningNeeded &&
            !configFileWarningIssued &&
            (event.toolName === "edit" || event.toolName === "write")
          ) {
            const filePath = extractToolFilePath(event.args);
            if (filePath && isConfigArtifactFile(filePath)) {
              console.warn(`\n[WARN] Agent is editing a build/config artifact (${filePath}) inside the SWE container. Nudging it to revert and focus on source code.`);
              lastTouchedConfigFile = filePath;
              configFileWarningNeeded = true;
              session.abort();
            }
          }

          if (
            !loopDetected &&
            !archaeologyNudgeNeeded &&
            !configFileWarningNeeded &&
            shouldIssueBudgetNudge(Date.now() - start, timeoutMs, budgetNudgeIssued)
          ) {
            console.warn(`\n[WARN] 50% of the ${timeoutMin}-minute time budget used. Nudging agent to focus on finishing.`);
            budgetNudgeNeeded = true;
            session.abort();
          }

          const egressAttempt = detectEgressAttempt(event.toolName, event.args);
          if (egressAttempt) {
            egressAttemptCount++;
            if (egressAttempts.length < MAX_RECORDED_EGRESS_ATTEMPTS) egressAttempts.push(egressAttempt);
            console.warn(`\n[WARN] Network-fetch attempt (${egressAttempt.category}): ${egressAttempt.snippet.slice(0, 120)}`);
          }

          if (argsStr.length > 200) argsStr = argsStr.substring(0, 200) + "...";
        } catch (e) { }
        console.log(`\n[AGENT] Started using tool: ${event.toolName} with args: ${argsStr}`);
      } else if (event.type === "tool_execution_end") {
        console.log(`[AGENT] Finished tool: ${event.toolName}`);
        if (event.result) {
          try {
            let resStr = typeof event.result === 'string' ? event.result : JSON.stringify(event.result);
            if (resStr.length > 500) resStr = resStr.substring(0, 500) + "... [TRUNCATED]";
            console.log(`[AGENT] Tool result: ${resStr}`);
          } catch (e) { }
        }
      } else if (event.type === "auto_retry_start") {
        console.warn(`\n[WARN] Agent retrying (${event.attempt}/${event.maxAttempts}): ${event.errorMessage}`);
      }
    });

    console.log(`\n--- Agent output ---`);
    const agentPrompt = buildAgentPrompt({ tmpDir, isSweContainer, taskPrompt: task.prompt });
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("AGENT_TIMEOUT")), timeoutMs);
    });

    let timedOut = false;

    const runPromptWithLoopDetection = async (promptText: string) => {
      let currentPrompt = promptText;
      let maxLoops = 3;

      while (!timedOut && maxLoops > 0) {
        try {
          await Promise.race([
            session.prompt(currentPrompt),
            timeoutPromise
          ]);
          if (loopDetected) throw new Error("LOOP_DETECTED");
          if (archaeologyNudgeNeeded) throw new Error("ARCHAEOLOGY_NUDGE");
          if (configFileWarningNeeded) throw new Error("CONFIG_FILE_WARNING");
          if (budgetNudgeNeeded) throw new Error("BUDGET_NUDGE");
          break; // Finished successfully
        } catch (err: any) {
          if (err.message === "AGENT_TIMEOUT") {
            console.error(`\n[ERROR] Agent execution timed out after ${timeoutMin} minutes. Aborting...`);
            await session.abort();
            timedOut = true;
          } else if (budgetNudgeNeeded || err.message === "BUDGET_NUDGE") {
            // Same ordering requirement as the other nudge branches: this also
            // calls session.abort(), so it MUST be checked before the generic
            // loop-detected fallback swallows it as a plain abort. One-shot:
            // budgetNudgeIssued is never cleared, unlike the archaeology/
            // config-file nudges' per-trigger reset.
            budgetNudgeNeeded = false;
            budgetNudgeIssued = true;
            const elapsedMin = Math.round((Date.now() - start) / 60000);
            console.log(`\n[INFO] Time-budget nudge (${elapsedMin}/${timeoutMin} min elapsed)... Prompting agent to focus on finishing.`);
            currentPrompt = `SYSTEM WARNING: You have used over half of your allotted time (${elapsedMin} of ${timeoutMin} minutes). Stop broad exploration now. If you haven't implemented the source-code fix yet, do so immediately. Verify ONLY against the specific failing test(s) described in the task -- do not re-run the full suite or continue investigating tangents.\n\n[Tool results are returned. If the result is sufficient, answer now.]`;
            maxLoops--;
          } else if (configFileWarningNeeded || err.message === "CONFIG_FILE_WARNING") {
            // Same ordering requirement as the archaeology branch below: this
            // also calls session.abort(), so it MUST be checked before the
            // generic loop-detected fallback swallows it as a plain abort.
            configFileWarningNeeded = false;
            configFileWarningIssued = true;
            console.log(`\n[INFO] Config-file nudge... Prompting agent to revert ${lastTouchedConfigFile} and focus on source code.`);
            currentPrompt = `SYSTEM WARNING: You just modified \`${lastTouchedConfigFile}\`, a build/configuration file. In this container, files like setup.py/setup.cfg/tox.ini/pyproject.toml/requirements.txt ship ALREADY MODIFIED as environment noise unrelated to the bug -- editing them almost never fixes the actual issue and is very likely a mistake. Revert that change and focus exclusively on the real Python source code that causes the bug described in the task.\n\n[Tool results are returned. If the result is sufficient, answer now.]`;
            maxLoops--;
          } else if (archaeologyNudgeNeeded || err.message === "ARCHAEOLOGY_NUDGE") {
            // MUST be checked BEFORE the loop-detection branch: the archaeology
            // detector also calls session.abort(), and the loop branch's generic
            // `AbortError` / "abort" clauses would otherwise swallow an
            // archaeology abort (corrupting loopRecoveries, sending the wrong
            // steer message, and leaving archaeologyNudgeNeeded set so the next
            // prompt throws immediately). This branch has no catch-all clauses,
            // so a genuine loop abort (loopDetected === true, set synchronously
            // before the abort) still falls through to the loop branch below.
            archaeologyNudgeNeeded = false;
            archaeologyState.count = 0;
            if (archaeologyNudgesUsed >= maxArchaeologyNudges) {
              console.log(`\n[INFO] Archaeology nudge budget exhausted (${archaeologyNudgesUsed}/${maxArchaeologyNudges}) — letting normal flow continue.`);
              break;
            }
            archaeologyNudgesUsed++;
            console.log(`\n[INFO] Recovering from git-archaeology streak (${archaeologyNudgesUsed}/${maxArchaeologyNudges})... Prompting agent to stop investigating history.`);
            currentPrompt = `SYSTEM WARNING: You have spent several tool calls exploring git history (log/show/blame) without editing any file. Per your instructions, git archaeology should only be used if essential - stop investigating history now and make the code change based on what you already know. If you are genuinely blocked, make your best-effort fix now rather than continuing to investigate.\n\n[Tool results are returned. If the result is sufficient, answer now.]`;
            maxLoops--;
          } else if (loopDetected || err.message === "LOOP_DETECTED" || err.name === "AbortError" || err.message?.includes("abort")) {
            console.log(`\n[INFO] Recovering from tool loop... Prompting agent to try something else.`);
            loopRecoveries++;
            currentPrompt = `SYSTEM WARNING: You are repeatedly calling the tool \`${lastToolName}\` with the exact same arguments: \`${lastToolArgs}\`. This is an infinite loop. The last execution was aborted. You MUST try a completely different approach, use different arguments, or implement the fix now.\n\n[Tool results are returned. If the result is sufficient, answer now.]`;
            loopDetected = false;
            repeatedToolCount = 0;
            lastToolName = "";
            lastToolArgs = "";
            maxLoops--;
          } else {
            throw err;
          }
        }
      }
    };

    await runPromptWithLoopDetection(agentPrompt);

    let lastAssistant = [...session.messages].reverse().find(m => m.role === "assistant") as any;
    if (lastAssistant && lastAssistant.stopReason === "error") {
      const errorMsg = lastAssistant.errorMessage || "Unknown error";
      const isConnectionError = /connection|fetch failed|socket|refused|lost|connect|timeout|timed out|500|502|503|504/i.test(errorMsg);
      if (isConnectionError) {
        throw new Error(`Inference backend is unreachable or crashed: ${errorMsg}`);
      }
    }

    const getDiff = async () => {
      await execAsync(`git add .`, { cwd: tmpDir });
      try {
        const { stdout } = await execAsync(`git diff --cached`, { cwd: tmpDir });
        return stdout;
      } catch (e) {
        return "";
      }
    };

    console.log(`[INFO] Extracting diff...`);
    let diff = await getDiff();

    if (!diff.trim() && !timedOut && (!lastAssistant || lastAssistant.stopReason !== "error")) {
      console.log(`\n[INFO] Agent finished with no changes. Prompting to continue...`);
      const reminderPrompt = `You are running as part of an automated pipeline, as such you MUST complete the task you have been assigned and fully implement it now by editing all the required files in the workspace, autonomously and without any further interaction.\n\nReminder of your task:\n${task.prompt}\n\n[Tool results are returned. If the result is sufficient, answer now.]`;

      try {
        await runPromptWithLoopDetection(reminderPrompt);
      } catch (err: any) {
        if (err.message === "AGENT_TIMEOUT") {
          // Already handled in runPromptWithLoopDetection, but just in case
        } else {
          throw err;
        }
      }

      lastAssistant = [...session.messages].reverse().find(m => m.role === "assistant") as any;
      if (lastAssistant && lastAssistant.stopReason === "error") {
        const errorMsg = lastAssistant.errorMessage || "Unknown error";
        const isConnectionError = /connection|fetch failed|socket|refused|lost|connect|timeout|timed out|500|502|503|504/i.test(errorMsg);
        if (isConnectionError) {
          throw new Error(`Inference backend is unreachable or crashed: ${errorMsg}`);
        }
      }

      console.log(`[INFO] Re-extracting diff...`);
      diff = await getDiff();
    }

    // Check whether the diff touches config/environment artifact files (see
    // src/config-guard.ts). Two shapes matter: "config-only" (no real source
    // edits at all -- the original check) and "mixed" (config artifacts
    // riding alongside a real fix -- previously invisible to the all-or-
    // nothing check, see plans/improvement-plan.md cross-cutting finding #2).
    const configDiffClass = classifyConfigDiff(diff);

    if (
      configDiffClass !== "none" &&
      !timedOut &&
      (!lastAssistant || lastAssistant.stopReason !== "error")
    ) {
      const configOnlyPrompt = `IMPORTANT: You have only modified build/configuration files (such as setup.py, tox.ini, pyproject.toml) but have NOT made any actual source code changes. These config file changes are likely environment artifacts and do NOT address the issue.\n\nYou MUST edit the actual source code files to fix the bug described in the task. Go back to investigating the issue and implement the fix in the relevant Python source files.\n\nReminder of your task:\n${task.prompt}`;
      const mixedDiffPrompt = `IMPORTANT: Alongside your source code fix, your diff also modifies build/configuration files (such as setup.py, tox.ini, pyproject.toml). These are very likely pre-existing environment artifacts in this container, not part of the actual fix.\n\nRevert ONLY the changes to those build/configuration files (keep your source code fix intact), then stop.`;

      if (configDiffClass === "config-only") {
        console.log(`\n[INFO] Agent only modified config/build files (no source code edits). Prompting to make actual changes...`);
      } else {
        console.log(`\n[INFO] Agent's diff mixes config/build files with real source changes. Prompting it to revert just the config files...`);
      }

      try {
        await runPromptWithLoopDetection(configDiffClass === "config-only" ? configOnlyPrompt : mixedDiffPrompt);
      } catch (err: any) {
        if (err.message === "AGENT_TIMEOUT") {
          // handled
        } else {
          throw err;
        }
      }

      lastAssistant = [...session.messages]
        .reverse()
        .find((m) => m.role === "assistant") as any;
      if (lastAssistant && lastAssistant.stopReason === "error") {
        const errorMsg = lastAssistant.errorMessage || "Unknown error";
        const isConnectionError =
          /connection|fetch failed|socket|refused|lost|connect|timeout|timed out|500|502|503|504/i.test(
            errorMsg
          );
        if (isConnectionError) {
          throw new Error(
            `Inference backend is unreachable or crashed: ${errorMsg}`
          );
        }
      }

      console.log(`[INFO] Re-extracting diff after config-diff re-prompt...`);
      diff = await getDiff();
    }

    const duration = Date.now() - start;
    console.log(`\n--- Agent finished in ${duration}ms ---\n`);

    console.log(`[INFO] Generated diff length: ${diff.length} characters`);

    let testOutput = "";
    let testExitCode: number | null = null;
    let verificationRetries = 0;
    let harnessError = false;

    // SWE-bench container test evaluation: apply test patch and run FAIL_TO_PASS tests
    if (isSweContainer && task.failToPass && task.failToPass.length > 0) {
      console.log(`[INFO] Running SWE-bench FAIL_TO_PASS tests (${task.failToPass.length} tests)...`);

      // Apply the test patch
      if (task.testPatch) {
        console.log(`[INFO] Applying SWE-bench test patch...`);
        try {
          await revertAndApplySweTestPatch(tmpDir, task.testPatch);
        } catch (e) {
          console.warn(`[WARN] Failed to apply test patch:`, e);
        }
      }

      // Run the test command appropriate for this repo
      ({ testExitCode, testOutput, harnessError = false } = await runSweBenchTestCommand(tmpDir, task));

      // One-shot verification retry: if the REAL acceptance tests failed, give
      // the agent exactly one more corrective pass with the actual failure
      // output (instead of only discovering it post-hoc via the judge), then
      // re-run the tests once more before finalizing the result. Skipped on a
      // harness error (malformed FAIL_TO_PASS) -- there is no valid test to
      // retry against, and re-running it would only reproduce the same error.
      if (testExitCode !== 0 && !harnessError && !timedOut && (!lastAssistant || lastAssistant.stopReason !== "error")) {
        console.log(`\n[INFO] Fix failed the real acceptance tests. Giving the agent one corrective pass with the actual failure output...`);
        const retryPrompt = buildVerificationRetryPrompt(testOutput, task);
        // Fresh phase: a git-archaeology streak left over from the main prompt
        // phase must not abort this focused corrective turn on its very first
        // history call. (archaeologyNudgesUsed is deliberately NOT reset — it
        // is an intentional whole-task budget, not a per-phase one.)
        archaeologyState.count = 0;
        try {
          await runPromptWithLoopDetection(retryPrompt);
        } catch (err: any) {
          if (err.message !== "AGENT_TIMEOUT") throw err;
        }

        lastAssistant = [...session.messages].reverse().find(m => m.role === "assistant") as any;
        if (lastAssistant && lastAssistant.stopReason === "error") {
          const errorMsg = lastAssistant.errorMessage || "Unknown error";
          const isConnectionError = /connection|fetch failed|socket|refused|lost|connect|timeout|timed out|500|502|503|504/i.test(errorMsg);
          if (isConnectionError) {
            throw new Error(`Inference backend is unreachable or crashed: ${errorMsg}`);
          }
        }

        verificationRetries = 1;

        // The retry turn had full bash/edit/write access AND was handed the
        // exact failing test names, so restore the acceptance tests to HEAD
        // BEFORE the diff is captured: (a) the agent must not be able to force
        // a pass by editing the tests (testExitCode is the sole scoring
        // authority), and (b) the stored diff must reflect only the agent's
        // real change. Diff-then-apply mirrors the initial run's ordering
        // (diff captured with no test patch applied).
        if (task.testPatch) {
          try {
            await revertAgentTestModifications(tmpDir);
          } catch (e) {
            console.warn(`[WARN] Failed to revert agent test modifications:`, e);
          }
        }

        console.log(`[INFO] Re-extracting diff after verification retry...`);
        diff = await getDiff();

        if (task.testPatch) {
          console.log(`[INFO] Re-applying SWE-bench test patch before re-running tests...`);
          try {
            await applySweTestPatch(tmpDir, task.testPatch);
          } catch (e) {
            console.warn(`[WARN] Failed to apply test patch:`, e);
          }
        }

        console.log(`[INFO] Re-running SWE-bench FAIL_TO_PASS tests after retry...`);
        ({ testExitCode, testOutput, harnessError = false } = await runSweBenchTestCommand(tmpDir, task));
      }
    } else {
      // Original flow for non-SWE tasks
      if (task.testPatch) {
        console.log(`[INFO] Applying test patch...`);
        try {
          const patchPath = join(tmpDir, "test.patch");
          await writeFile(patchPath, task.testPatch);
          await execAsync(`git apply test.patch`, { cwd: tmpDir });
        } catch (e) {
          console.warn(`[WARN] Failed to apply test patch:`, e);
        }
      }

      if (task.testCommand) {
        console.log(`[INFO] Running test command: ${task.testCommand}...`);
        try {
          const { stdout, stderr } = await execAsync(task.testCommand, { cwd: tmpDir, maxBuffer: 10 * 1024 * 1024 });
          testExitCode = 0;
          testOutput = `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`;
        } catch (error: any) {
          testExitCode = error.code ?? 1;
          testOutput = `STDOUT:\n${error.stdout}\nSTDERR:\n${error.stderr}\nERROR: ${error.message}`;
        }
        console.log(`[INFO] Test command finished with exit code ${testExitCode}`);
      }
    }

    console.log(`[INFO] Running LLM judge...`);
    // The resolved agent model (what the agent session actually uses) is the
    // judge default here; keep a reference to detect self-grading correctly.
    const defaultJudgeModel = session.state.model as any;
    let judgeModel = defaultJudgeModel;
    if (judgeModelReq) {
      const resolvedJudgeModel = modelRegistry.find(judgeModelReq.provider, judgeModelReq.id);
      if (resolvedJudgeModel) {
        judgeModel = resolvedJudgeModel;
      } else {
        console.warn(`[WARN] Could not resolve judge model ${judgeModelReq.provider}/${judgeModelReq.id}. Using default.`);
      }
    }
    if (!judgeModel) throw new Error("Judge model not found");
    // Self-grading check: compare against the RESOLVED agent model, on BOTH
    // provider and id. Same id on a different provider (e.g. local ds4 vs
    // openrouter both exposing "deepseek-v4-flash") is NOT self-grading, and
    // comparing the raw CLI request would silently miss local-provider runs.
    if (
      defaultJudgeModel &&
      judgeModel.provider === defaultJudgeModel.provider &&
      judgeModel.id === defaultJudgeModel.id
    ) {
      console.warn(`\n[WARN] Judge model is the SAME as the agent model (${judgeModel.provider}/${judgeModel.id}) — the model is grading its own output.
For SWE-bench tasks the container test now decides the score, so this only affects the rationale.
Pass --judge-model (e.g. openrouter/deepseek/deepseek-v4-pro) for an independent judge.\n`);
    }
    console.log(`[INFO] Judge model: ${judgeModel.provider}/${judgeModel.id}`);
    const auth = await modelRegistry.getApiKeyAndHeaders(judgeModel);
    if (!auth.ok) throw new Error("Judge auth failed: " + auth.error);

    let expectedDiff = task.expectedDiff || "";
    if (task.solutionCommit) {
      console.log(`[INFO] Fetching solution commit ${task.solutionCommit} to generate expected diff...`);
      await execAsync(`git fetch --depth 1 origin ${task.solutionCommit}`, { cwd: tmpDir });
      try {
        const { stdout } = await execAsync(`git diff ${task.commit} ${task.solutionCommit}`, { cwd: tmpDir });
        expectedDiff = stdout;
      } catch (e) {
        console.warn(`[WARN] Failed to generate diff for solution commit:`, e);
      }
    }

    const judgeSystemPrompt = `You are an expert software engineer reviewing the output of an AI coding agent.
You will be provided with the task prompt, the expected behavior, the git diff generated by the agent, and optionally a known correct "solution diff" and automated test output.
Your job is to determine if the diff successfully accomplishes the task and explain why (or why not).
- If automated tests were run and PASSED, the patch is accepted: score 1 with a concise explanation.
- If automated tests were run and FAILED, the patch did NOT satisfy the acceptance tests: score 0 unless you have a compelling reason the failure is unrelated to the change (e.g. a pre-existing/environment failure), which you must explain in the rationale.
- If no automated tests were run, judge the diff on its own merits against the expected behavior and the known correct solution.
Respond ONLY with a JSON object in this exact format, with no markdown wrapping:
{
  "score": 0 or 1,
  "rationale": "Explanation for the score"
}`;

    let truncatedTestOutput = testOutput;
    if (truncatedTestOutput.length > 15000) {
      truncatedTestOutput = truncatedTestOutput.substring(0, 5000) + "\n\n...[TRUNCATED]...\n\n" + truncatedTestOutput.substring(truncatedTestOutput.length - 10000);
    }

    // Build the test results section for the judge
    let testResultsSection = "";
    if (testExitCode !== null) {
      const testSource = isSweContainer ? "SWE-bench Container" : "Local";
      testResultsSection = `Automated Test Execution (${testSource}):\nExit Code: ${testExitCode}\nTests: ${isSweContainer && task.failToPass ? task.failToPass.join(", ") : (task.testCommand || "N/A")}\nOutput:\n${truncatedTestOutput}\n`;
    }

    const judgePrompt = `Task Prompt:
${task.prompt}

Expected Behavior:
${task.expectedBehavior || "Not specified."}

${expectedDiff ? `Known Correct Solution Diff:\n${expectedDiff}\n` : ""}
Agent Diff:
${diff ? diff : "(No changes made)"}

${testResultsSection}
`;

    let judgeOutput = "";
    let judgeScore: number | null = null;
    let rationale = "Failed to parse judge output";
    let judgeParseFailed = true;
    let judgeAttemptsUsed = 0;
    const maxJudgeAttempts = 3;
    for (let attempt = 1; attempt <= maxJudgeAttempts; attempt++) {
      judgeAttemptsUsed = attempt;
      judgeOutput = "";
      const stream = modelRuntime.streamSimple(judgeModel, {
        systemPrompt: judgeSystemPrompt,
        messages: [{ role: "user", content: judgePrompt, timestamp: Date.now() }]
      }, { apiKey: auth.apiKey, headers: auth.headers });

      for await (const chunk of stream) {
        if (chunk.type === "text_delta") {
          judgeOutput += chunk.delta;
        }
        if (chunk.type === "error") {
          console.error("[DEBUG] streamSimple error:", chunk.error);
        }
      }
      const preview = judgeOutput.length > 500 ? judgeOutput.slice(0, 500) + "... [TRUNCATED]" : judgeOutput;
      console.log(`[DEBUG] Raw judge output (attempt ${attempt}/${maxJudgeAttempts}):`, preview);

      const parsed = parseJudgeOutput(judgeOutput);
      if (!parsed.parseFailed) {
        judgeScore = parsed.score;
        rationale = parsed.rationale;
        judgeParseFailed = false;
        break;
      }
      console.error(`[ERROR] Failed to parse judge output (attempt ${attempt}/${maxJudgeAttempts}): ${parsed.rationale.slice(0, 300)}`);
      rationale = parsed.rationale;
      if (attempt < maxJudgeAttempts) {
        console.log(`[INFO] Retrying LLM judge...`);
      }
    }

    // #1 Ground-truth-first scoring: for SWE-bench container tasks the
    // FAIL_TO_PASS test result DECIDES the score; the LLM judge only explains
    // (its raw verdict is recorded as judgeModelScore for later comparison).
    // For other tasks the judge decides; unparseable judge output defaults to 0.
    // A harness error (malformed FAIL_TO_PASS -- see task-validation.ts) is
    // checked FIRST: it also has testExitCode === null, but must never fall
    // through to the judge, which never saw a real test result either.
    let scoreSource: "container-test" | "judge" | "judge-parse-failed" | "harness-error" = "judge";
    let finalScore: number = 0;
    if (isSweContainer && task.failToPass && task.failToPass.length > 0 && harnessError) {
      scoreSource = "harness-error";
      finalScore = 0;
      console.log(`[INFO] Harness error -- malformed FAIL_TO_PASS data, no test could be run. Excluding ${task.id} from pass-rate.`);
    } else if (isSweContainer && task.failToPass && task.failToPass.length > 0 && testExitCode !== null) {
      scoreSource = "container-test";
      finalScore = testExitCode === 0 ? 1 : 0;
      if (judgeScore !== null && judgeScore !== finalScore) {
        console.log(`[INFO] Judge raw score ${judgeScore} but container test ${testExitCode === 0 ? "PASSED" : "FAILED"} (exit ${testExitCode}) — final score decided by the test.`);
      }
    } else if (judgeScore !== null && !judgeParseFailed) {
      scoreSource = "judge";
      finalScore = judgeScore === 1 ? 1 : 0;
    } else {
      scoreSource = "judge-parse-failed";
      finalScore = 0;
    }
    const result: any = {
      task: task.id,
      durationMs: duration,
      diff,
      testExitCode,
      testOutput,
      judgeScore: finalScore,
      judgeRationale: rationale,
      judgeModelScore: judgeScore,   // raw LLM judge verdict (null if unparseable)
      judgeParseFailed,
      judgeAttempts: judgeAttemptsUsed,
      scoreSource,                   // "container-test" (SWE ground truth) | "judge" | "judge-parse-failed" | "harness-error"
      excludeFromPassRate: scoreSource === "harness-error",
      judgeModel: judgeModel ? `${judgeModel.provider}/${judgeModel.id}` : undefined,
      timedOut,
      loopRecoveries,
      verificationRetries,
      archaeologyNudges: archaeologyNudgesUsed,
      timeBudgetNudged: budgetNudgeIssued,
      egressAttemptCount,
      egressAttempts,
      // True when the agent tried to pull upstream source/history. Under the
      // sealed network these attempts fail, so this is informational; on an
      // --unsealed run a passing result with this set should be treated as
      // contaminated.
      contaminationSuspected: egressAttempts.some((a) => a.category === "upstream-source"),
      sealedNetwork: process.env.PI_BENCH_SEALED === "1",
    };
    if (isSweContainer) {
      result.sweContainerTest = true;
      result.sweTestExitCode = testExitCode;
    }

    const resultPath = join(outputDir, `results-${task.id}.json`);
    await writeFile(resultPath, JSON.stringify(result, null, 2));
    console.log(`\n[INFO] Task Complete! Result saved to ${resultPath}`);

    const transcriptPath = join(outputDir, `transcript-${task.id}.json`);
    try {
      await writeFile(transcriptPath, JSON.stringify([...session.messages], null, 2));
      console.log(`[INFO] Agent transcript saved to ${transcriptPath}`);
    } catch (e) {
      console.warn(`[WARN] Could not save transcript to ${transcriptPath}`, e);
    }
    console.log(`[INFO] Score: ${result.judgeScore}`);
    console.log(`[INFO] Rationale: ${result.judgeRationale}`);

    return result;

  } finally {
    if (!isSweContainer) {
      await rm(tmpDir, { recursive: true, force: true });
      console.log(`[INFO] Cleaned up ${tmpDir}`);
    } else {
      console.log(`[INFO] SWE-bench container — skipping /testbed cleanup.`);
    }
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      model: { type: "string" },
      "judge-model": { type: "string" },
      "model-tag": { type: "string" },
      timeout: { type: "string", default: "30" },
      context: { type: "string" },
      platform: { type: "string" },
      provider: { type: "string" },
      engine: { type: "string" }, // backward compat alias for --provider
      "rocm-version": { type: "string", default: "7.2.4" },
      port: { type: "string" },
      "inference-profile": { type: "string" },
      "print-output-dir": { type: "boolean" },
      "print-egress-allowlist": { type: "boolean" },
      "output-dir": { type: "string" },
      "consume-task": { type: "boolean" },
      "exclude-tools": { type: "string" },
    },
    allowPositionals: true,
  });

  // Tools disabled by default. web_search/web_fetch: benchmark integrity - an
  // agent that can search or fetch the web could just look up the real
  // upstream fix instead of solving the task. question/questionnaire: these
  // always fail here (no human is ever attached to a benchmark run - they
  // return a clean "UI not available" error rather than hanging, but a task
  // reaching for one still burns a turn on something that can never succeed).
  // Pass --exclude-tools with a comma-separated list to override (e.g. "none"
  // to allow everything, or a different tool list).
  const DEFAULT_EXCLUDED_TOOLS = ["web_search", "web_fetch", "question", "questionnaire"];
  let excludeTools: string[];
  if (values["exclude-tools"] !== undefined) {
    const raw = (values["exclude-tools"] as string).trim();
    excludeTools = raw === "" || raw.toLowerCase() === "none"
      ? []
      : raw.split(",").map((t) => t.trim()).filter(Boolean);
  } else {
    excludeTools = DEFAULT_EXCLUDED_TOOLS;
  }
  // console.error, not console.log: --print-output-dir's only stdout contract
  // is the directory path (run-swe-bench.sh captures it via `$(...)`), and
  // this line runs before that check on every invocation.
  if (excludeTools.length > 0 && !values["print-output-dir"] && !values["print-egress-allowlist"]) {
    console.error(`[INFO] Excluding tools: ${excludeTools.join(", ")}`);
  }

  // --provider takes precedence, --engine is a backward-compat alias
  const provider = (values.provider || values.engine || "llama.cpp") as string;

  const targetPath = positionals[0];
  if (!targetPath && !values["print-output-dir"] && !values["print-egress-allowlist"]) {
    console.error("Usage: bun run src/index.ts <task-file-or-dir> [--provider llama.cpp|ds4|openrouter] [--model model-id] [--judge-model provider/model-id] [--model-tag tag] [--platform platform-id] [--rocm-version 7.2.4] [--port 8080] [--context tokens] [--inference-profile params] [--exclude-tools web_search,web_fetch|none]");
    process.exit(1);
  }

  let agentModelReq;
  if (values.model) {
    const modelVal = values.model;
    // If --model contains a slash AND --provider is set, treat --model as just the model ID
    // Otherwise, parse provider/model from --model (backward compat: --model openrouter/deepseek/deepseek-v4-flash)
    if (modelVal.includes("/") && !values.provider) {
      const parts = modelVal.split("/");
      agentModelReq = { provider: parts[0] as any, id: parts.slice(1).join("/") };
    } else {
      // --model is just the model ID, use --provider for the provider
      agentModelReq = { provider: provider as any, id: modelVal };
    }
  }

  let judgeModelReq;
  if (values["judge-model"]) {
    const parts = values["judge-model"].split("/");
    judgeModelReq = parts.length > 1 ? { provider: parts[0] as any, id: parts.slice(1).join("/") } : undefined;
    if (!judgeModelReq && !values["print-output-dir"]) console.warn(`[WARN] Could not parse judge model ${values["judge-model"]} (expected provider/model-id). Using default.`);
  }

  const modelTag = values["model-tag"] as string | undefined;
  const isLocalProvider = provider === "llama.cpp" || provider === "ds4" || provider === "vllm";
  let outputDir = "results";
  let exactModelId = agentModelReq ? agentModelReq.id : "unknown";

  if (isLocalProvider) {
    try {
      const fetchPort = values.port || (provider === "ds4" || provider === "vllm" ? "8000" : "8080");
      const res = await fetch(`http://${LOCAL_HOST}:${fetchPort}/v1/models`);
      const data = await res.json();
      if (data && data.data && data.data.length > 0) {
        exactModelId = data.data[0].id;
        const quantName = exactModelId.replace(/[^a-zA-Z0-9_-]/g, "_");
        outputDir = `${quantName}_results`;
      } else if (agentModelReq) {
        outputDir = `${agentModelReq.id.replace(/\\\//g, "_")}_results`;
      }
    } catch (e) {
      if (agentModelReq) {
        outputDir = `${agentModelReq.id.replace(/\\\//g, "_")}_results`;
      }
    }
  } else if (agentModelReq) {
    outputDir = `${agentModelReq.id.replace(/\//g, "_")}_results`;
  }

  // Append model tag to directory name for filesystem uniqueness
  if (modelTag) {
    outputDir = outputDir.replace(/_results$/, `-${modelTag}_results`);
  }

  if (values.platform) {
    outputDir = join("benchmark_results", values.platform as string, outputDir);
  }

  // Explicit override: sealed runs write into a per-task staging directory
  // (not the shared results dir, which holds earlier attempts' hidden-test
  // output) and the host moves the files into place afterwards.
  if (values["output-dir"]) {
    outputDir = values["output-dir"] as string;
  }

  if (values["print-output-dir"]) {
    console.log(outputDir);
    process.exit(0);
  }

  // Prints the host:port pairs a sealed container must be able to reach:
  // the agent's and the judge's model endpoints, with localhost mapped to
  // host.docker.internal. run-swe-bench.sh feeds this to the egress proxy.
  if (values["print-egress-allowlist"]) {
    const localModelsPath = join(process.cwd(), "models.json");
    const runtime = await ModelRuntime.create(existsSync(localModelsPath) ? { modelsPath: localModelsPath } : undefined);
    const registry = new ModelRegistry(runtime);
    const targets = new Set<string>();
    const addModel = (req: any, fallbackProvider?: string) => {
      const m: any = req
        ? registry.find(req.provider, req.id)
        : registry.getAll().find((x: any) => x.provider === fallbackProvider);
      if (!m?.baseUrl) return;
      let baseUrl: string = m.baseUrl;
      if (values.port && m.provider === provider) baseUrl = baseUrl.replace(/:\d+/, `:${values.port}`);
      const t = egressTargetFromBaseUrl(baseUrl, "host.docker.internal");
      if (t) targets.add(t);
    };
    addModel(agentModelReq, provider);
    // No --judge-model means the judge is the agent model (already added).
    if (judgeModelReq) addModel(judgeModelReq);
    if (isLocalProvider && targets.size === 0) {
      targets.add(`host.docker.internal:${values.port || (provider === "ds4" || provider === "vllm" ? "8000" : "8080")}`);
    }
    console.log([...targets].join(","));
    process.exit(0);
  }

  const s = await stat(targetPath);
  const taskFiles: string[] = [];
  if (s.isDirectory()) {
    const files = await readdir(targetPath);
    for (const f of files) {
      if (f.endsWith(".json")) {
        taskFiles.push(join(targetPath, f));
      }
    }
  } else {
    taskFiles.push(targetPath);
  }

  if (taskFiles.length === 0) {
    console.log(`[INFO] No task JSON files found in ${targetPath}`);
    return;
  }

  console.log(`[INFO] Found ${taskFiles.length} tasks to run.`);
  const timeoutMin = parseInt(values.timeout as string, 10) || 30;
  const contextWindowOverride = values.context ? parseInt(values.context as string, 10) : undefined;
  if (contextWindowOverride) {
    console.log(`[INFO] Context window override: ${contextWindowOverride} tokens`);
  }

  await mkdir(outputDir, { recursive: true });
  const runMeta: any = {
    modelTag,
    backend: provider,
    rocm: values["rocm-version"],
    exactModelId,
    agentModel: agentModelReq ? `${agentModelReq.provider}/${agentModelReq.id}` : undefined,
    judgeModel: judgeModelReq ? `${judgeModelReq.provider}/${judgeModelReq.id}` : "default (same as agent)",
    timeoutMin,
    excludeTools: excludeTools.length > 0 ? excludeTools : undefined,
  };
  if (values["inference-profile"]) {
    runMeta.inferenceProfile = values["inference-profile"];
  }
  if (contextWindowOverride) {
    runMeta.contextWindowOverride = contextWindowOverride;
  }
  await writeFile(join(outputDir, "run-meta.json"), JSON.stringify(runMeta, null, 2));
  console.log(`[INFO] Saving results to directory: ${outputDir}`);

  const results = [];
  let passed = 0;
  let harnessErrors = 0;
  let totalDuration = 0;

  for (const f of taskFiles) {
    try {
      const content = await readFile(f, "utf-8");
      const task = JSON.parse(content);
      const resultFile = join(outputDir, `results-${task.id}.json`);

      try {
        const existing = await readFile(resultFile, "utf-8");
        const res = JSON.parse(existing);
        console.log(`[INFO] Skipping ${task.id}, result already exists.`);
        results.push(res);
        if (res.excludeFromPassRate) harnessErrors++;
        else if (res.judgeScore === 1) passed++;
        totalDuration += res.durationMs;
        continue;
      } catch (e) {
        // file doesn't exist, proceed
      }
    } catch (e) {
      console.warn(`[WARN] Could not pre-parse task file ${f} for resume check.`);
    }

    const res = await runTask(f, agentModelReq, judgeModelReq, outputDir, timeoutMin, provider, values.port as string, contextWindowOverride, excludeTools, !!values["consume-task"]);
    results.push(res);
    if (res.excludeFromPassRate) harnessErrors++;
    else if (res.judgeScore === 1) passed++;
    totalDuration += res.durationMs;
  }

  // Tasks with a harness error (malformed FAIL_TO_PASS data -- no test could
  // be run) are excluded from the pass-rate denominator entirely rather than
  // counted as fails: they say nothing about the agent's fix quality.
  const scorableTasks = results.length - harnessErrors;
  const summary = {
    totalTasks: results.length,
    harnessErrorTasks: harnessErrors,
    passedTasks: passed,
    passRate: scorableTasks > 0 ? passed / scorableTasks : 0,
    totalDurationMs: totalDuration,
    averageDurationMs: results.length > 0 ? totalDuration / results.length : 0,
    results
  };

  const summaryPath = join(outputDir, "summary.json");
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\n======================================================`);
  console.log(`[INFO] Benchmark Suite Complete!`);
  console.log(`[INFO] Pass Rate: ${(summary.passRate * 100).toFixed(2)}% (${passed}/${scorableTasks})${harnessErrors > 0 ? ` [${harnessErrors} excluded: harness-error]` : ""}`);
  console.log(`[INFO] Summary saved to ${summaryPath}`);
  console.log(`======================================================\n`);
}

main().catch((e) => {
  console.error(e);
  if (e instanceof Error && e.message.includes("Inference backend is unreachable")) {
    process.exit(2);
  }
  process.exit(1);
}).then(() => process.exit(0));
