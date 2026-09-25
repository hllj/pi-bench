import {
  createAgentSession,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { buildJudgePrompt, decideScore, resolveJudgeModel, runJudge } from "./judge-run";
import { buildAgentPrompt, buildVerificationRetryPrompt } from "./prompts";
import { shouldIssueBudgetNudge, trackGitArchaeology, type ArchaeologyState } from "./loop-guard";
import { extractDjangoTestModules, validateFailToPass } from "./task-validation";
import { classifyConfigDiff, extractToolFilePath, isConfigArtifactFile } from "./config-guard";
import { scrubGitHistoryToOrphanBaseline } from "./git-scrub";
import { applySweTestPatch, revertAgentTestModifications, revertAndApplySweTestPatch, runSweBenchTestCommand } from "./swe-tests";
import { detectEgressAttempt, egressTargetFromBaseUrl, rewriteLocalBaseUrl, type EgressAttempt } from "./egress";
import { childModelsTarget, delegationKind, skillReadName } from "./subagent-support";
import { applyGatewayOverrides, GATEWAY_HOST, GATEWAY_PORT, parseGatewaySpec, type GatewayRoute } from "./gateway";

// Hostname that reaches the machine running the local inference server. A
// sealed SWE container (run-swe-bench.sh) has no route to the host's
// loopback, so it sets this to host.docker.internal and all localhost model
// URLs are rewritten to go through the egress proxy.
const LOCAL_HOST = process.env.PI_BENCH_LOCAL_HOST || "localhost";

// Providers reached through the key-holding gateway (src/gateway.ts) in a
// sealed container: their baseUrl is pointed at the gateway and the API key
// replaced with a placeholder -- the container never holds a real key.
const GATEWAYS = parseGatewaySpec(process.env.PI_BENCH_GATEWAY);

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

async function runTask(taskFile: string, agentModelReq: any, judgeModelReq: any, outputDir: string = ".", timeoutMin: number = 30, provider: string = "llama.cpp", port?: string, contextWindowOverride?: number, excludeTools?: string[], consumeTask = false, deferGrading = false) {
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
      if (port || LOCAL_HOST !== "localhost" || Object.keys(GATEWAYS).length > 0) {
        const modelsContent = await readFile(localModelsPath, "utf-8");
        const modelsData = JSON.parse(modelsContent);
        if (port && modelsData.providers && modelsData.providers[provider] && modelsData.providers[provider].baseUrl) {
          modelsData.providers[provider].baseUrl = modelsData.providers[provider].baseUrl.replace(/:\d+/, `:${port}`);
        }
        for (const p of Object.values<any>(modelsData.providers || {})) {
          if (p && typeof p.baseUrl === "string") p.baseUrl = rewriteLocalBaseUrl(p.baseUrl, LOCAL_HOST);
        }
        applyGatewayOverrides(modelsData, GATEWAYS);
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

    // Subagents are separate `pi` processes that read their own models.json,
    // not modelsPath -- hand them the same gateway/host-rewritten config (see
    // src/subagent-support.ts). Container only: on the host this path is the
    // user's real ~/.pi/agent/models.json.
    if (isSweContainer && modelsPath) {
      const childModels = childModelsTarget(process.env, homedir());
      try {
        await mkdir(dirname(childModels), { recursive: true });
        await writeFile(childModels, await readFile(modelsPath, "utf-8"));
        console.log(`[INFO] Subagent models config written to ${childModels}`);
      } catch (e: any) {
        console.warn(`[WARN] Could not write subagent models config to ${childModels}: ${e?.message ?? e}. Subagents may fail to reach the model.`);
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

    // The subagent extension spawns `pi` from PATH. `bun run` puts
    // node_modules/.bin on PATH (and a `node` shim for its #!/usr/bin/env node
    // shebang); check it actually resolves so a broken spawn shows up here,
    // not as silently failed dispatches mid-run.
    if (session.getAllTools().some((t) => t.name === "subagent")) {
      try {
        const { stdout } = await execAsync(`pi --version`, { timeout: 30000 });
        console.log(`[INFO] Subagent runtime: pi ${stdout.trim()} (${(await execAsync("command -v pi")).stdout.trim()})`);
      } catch (e: any) {
        console.warn(`[WARN] Subagent tool is active but \`pi\` can't be run from PATH: ${String(e?.message ?? e).split("\n")[0]}. Dispatches will fail.`);
      }
    }

    // Telemetry: did the agent load skills / delegate? (See ~/.pi/agent/AGENTS.md.)
    const skillsRead: string[] = [];
    const delegationCalls: Record<string, number> = {};

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

          const skill = skillReadName(event.toolName, event.args);
          if (skill && !skillsRead.includes(skill)) {
            skillsRead.push(skill);
            console.log(`\n[INFO] Agent loaded skill: ${skill}`);
          }
          const delegation = delegationKind(event.toolName);
          if (delegation) {
            delegationCalls[delegation] = (delegationCalls[delegation] ?? 0) + 1;
            console.log(`\n[INFO] Agent delegated via ${delegation}`);
          }

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

    // Sealed runs (--defer-grading): the score is decided later by
    // src/grade.ts in a FRESH container, and the judge runs on the host
    // (scripts/finalize-sealed-result.ts) -- the in-container test above is
    // advisory only (it feeds the verification retry), and this container
    // never needs expectedDiff or a judge API key.
    let judgeScore: number | null = null;
    let rationale = "";
    let judgeParseFailed = false;
    let judgeAttemptsUsed = 0;
    let judgeModel: any = undefined;
    let scoreSource: string;
    let finalScore: number | null;
    if (deferGrading) {
      console.log(`[INFO] Grading deferred to a fresh container (sealed mode) -- skipping in-container judge.`);
      scoreSource = "pending-fresh-grade";
      finalScore = null;
    } else {
      console.log(`[INFO] Running LLM judge...`);
      // The resolved agent model (what the agent session actually uses) is the
      // judge default here; keep a reference to detect self-grading correctly.
      judgeModel = resolveJudgeModel(modelRegistry, judgeModelReq, session.state.model as any);

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

      const judgePrompt = buildJudgePrompt({ task, expectedDiff, diff, testExitCode, testOutput, isSweContainer });
      ({ judgeScore, rationale, judgeParseFailed, judgeAttemptsUsed } = await runJudge(modelRuntime, modelRegistry, judgeModel, judgePrompt));

      const isSweTestTask = isSweContainer && !!task.failToPass && task.failToPass.length > 0;
      ({ scoreSource, finalScore } = decideScore({ isSweTestTask, harnessError, testExitCode, judgeScore, judgeParseFailed }));
      if (scoreSource === "harness-error") {
        console.log(`[INFO] Harness error -- malformed FAIL_TO_PASS data, no test could be run. Excluding ${task.id} from pass-rate.`);
      } else if (scoreSource === "container-test" && judgeScore !== null && judgeScore !== finalScore) {
        console.log(`[INFO] Judge raw score ${judgeScore} but container test ${testExitCode === 0 ? "PASSED" : "FAILED"} (exit ${testExitCode}) — final score decided by the test.`);
      }
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
      skillsRead,
      delegationCalls,
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
    if (deferGrading) {
      // Advisory only: this ran in the container the agent had root in. The
      // host replaces testExitCode/testOutput/score with the fresh-container
      // grade and never trusts any score-bearing field from this file.
      result.inContainerTestExitCode = testExitCode;
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
      "print-excluded-tools": { type: "boolean" },
      "write-gateway-config": { type: "string" },
      "output-dir": { type: "string" },
      "consume-task": { type: "boolean" },
      "defer-grading": { type: "boolean" },
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
  // run-swe-bench.sh applies the same exclusions to the staged subagent
  // definitions (scripts/stage-agents.ts) -- this list only covers the parent.
  if (values["print-excluded-tools"]) {
    console.log(excludeTools.join(","));
    process.exit(0);
  }
  // console.error, not console.log: --print-output-dir's only stdout contract
  // is the directory path (run-swe-bench.sh captures it via `$(...)`), and
  // this line runs before that check on every invocation.
  if (excludeTools.length > 0 && !values["print-output-dir"] && !values["print-egress-allowlist"] && !values["write-gateway-config"]) {
    console.error(`[INFO] Excluding tools: ${excludeTools.join(", ")}`);
  }

  // --provider takes precedence, --engine is a backward-compat alias
  const provider = (values.provider || values.engine || "llama.cpp") as string;

  const targetPath = positionals[0];
  if (!targetPath && !values["print-output-dir"] && !values["print-egress-allowlist"] && !values["write-gateway-config"]) {
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

  // Sealed-mode network plan for the AGENT model (the judge runs on the host
  // in sealed mode, so it needs nothing from the container):
  //  - a local server (llama.cpp/ds4/vllm) -> allow host.docker.internal:<port>
  //    through the egress proxy (no key involved);
  //  - a remote API (openrouter, ...) -> NOT allowlisted; reached only via the
  //    key-holding gateway, so the container never holds the real key.
  // --print-egress-allowlist prints the CONNECT/HTTP allowlist (may be empty);
  // --write-gateway-config <path> writes the gateway routes INCLUDING the real
  // key to <path> (mode 0600) and prints the PI_BENCH_GATEWAY spec.
  if (values["print-egress-allowlist"] || values["write-gateway-config"]) {
    const localModelsPath = join(process.cwd(), "models.json");
    const runtime = await ModelRuntime.create(existsSync(localModelsPath) ? { modelsPath: localModelsPath } : undefined);
    const registry = new ModelRegistry(runtime);
    const agentModel: any = agentModelReq
      ? registry.find(agentModelReq.provider, agentModelReq.id)
      : registry.getAll().find((x: any) => x.provider === provider);
    let baseUrl: string | undefined = agentModel?.baseUrl;
    if (baseUrl && values.port && agentModel.provider === provider) baseUrl = baseUrl.replace(/:\d+/, `:${values.port}`);
    const localTarget = baseUrl ? egressTargetFromBaseUrl(baseUrl, "host.docker.internal") : null;
    const isLocalEndpoint = !!localTarget && localTarget.startsWith("host.docker.internal:");

    if (values["print-egress-allowlist"]) {
      const targets: string[] = [];
      if (isLocalEndpoint) targets.push(localTarget!);
      else if (!agentModel && isLocalProvider) {
        targets.push(`host.docker.internal:${values.port || (provider === "ds4" || provider === "vllm" ? "8000" : "8080")}`);
      }
      console.log(targets.join(","));
      process.exit(0);
    }

    const routes: GatewayRoute[] = [];
    if (agentModel && baseUrl && !isLocalEndpoint) {
      const auth: any = await registry.getApiKeyAndHeaders(agentModel);
      if (!auth.ok || !auth.apiKey) {
        console.error(`[ERROR] No API key for ${agentModel.provider} -- cannot configure the sealed gateway.`);
        process.exit(1);
      }
      routes.push({ name: agentModel.provider, upstream: baseUrl, key: auth.apiKey, models: [agentModel.id] });
    }
    await writeFile(values["write-gateway-config"] as string, JSON.stringify({ routes }, null, 2), { mode: 0o600 });
    console.log(routes.map((r) => `${r.name}=http://${GATEWAY_HOST}:${GATEWAY_PORT}/${r.name}`).join(","));
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

    const res = await runTask(f, agentModelReq, judgeModelReq, outputDir, timeoutMin, provider, values.port as string, contextWindowOverride, excludeTools, !!values["consume-task"], !!values["defer-grading"]);
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
