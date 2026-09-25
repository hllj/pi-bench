import type { GradeResult } from "./grade";
import { decideScore } from "./judge-run";

// Builds the authoritative result for a sealed run, on the host.
//
// The results file written inside the agent container is UNTRUSTED: the
// agent had root there and could overwrite it (or kill the harness and plant
// one). So nothing score-bearing is read from it. Only the diff (the agent's
// submission -- whatever it contains is what gets graded) and a whitelist of
// type-checked telemetry fields are carried over; the score, test result and
// pass-rate exclusion come exclusively from the fresh-container grade
// (src/grade.ts), and egress evidence from the proxy's own log.

const SOURCE_HOST_RE = /(^|\.)(github\.com|githubusercontent\.com|gitlab\.com|bitbucket\.org|pypi\.org|pythonhosted\.org|readthedocs\.(io|org)):\d+$/i;

const NUMBER_FIELDS = ["durationMs", "loopRecoveries", "verificationRetries", "archaeologyNudges", "egressAttemptCount"];
const BOOLEAN_FIELDS = ["timedOut", "timeBudgetNudged"];

export interface JudgeSummary {
  judgeScore: number | null;
  rationale: string;
  judgeParseFailed: boolean;
  judgeAttemptsUsed: number;
  judgeModel?: string;
}

export interface MergeInput {
  taskId: string;
  untrusted: any | null;
  grade: GradeResult | null;
  judge: JudgeSummary | null;
  egress: { denied: string[] };
}

export function mergeSealedResult({ taskId, untrusted, grade, judge, egress }: MergeInput): any {
  const u = untrusted && typeof untrusted === "object" ? untrusted : {};
  const result: any = { task: taskId };

  result.diff = typeof u.diff === "string" ? u.diff : "";
  for (const k of NUMBER_FIELDS) if (typeof u[k] === "number" && Number.isFinite(u[k])) result[k] = u[k];
  for (const k of BOOLEAN_FIELDS) if (typeof u[k] === "boolean") result[k] = u[k];
  if (typeof u.inContainerTestExitCode === "number" || u.inContainerTestExitCode === null) {
    result.inContainerTestExitCode = u.inContainerTestExitCode;
  }
  const attempts = Array.isArray(u.egressAttempts)
    ? u.egressAttempts
        .filter((a: any) => a && typeof a.category === "string" && typeof a.snippet === "string")
        .slice(0, 20)
        .map((a: any) => ({ category: a.category, snippet: a.snippet.slice(0, 300) }))
    : [];
  result.egressAttempts = attempts;
  // Skill/delegation telemetry (src/subagent-support.ts). Informational only.
  result.skillsRead = Array.isArray(u.skillsRead)
    ? u.skillsRead.filter((x: any) => typeof x === "string").slice(0, 50).map((x: string) => x.slice(0, 100))
    : [];
  result.delegationCalls = {};
  if (u.delegationCalls && typeof u.delegationCalls === "object" && !Array.isArray(u.delegationCalls)) {
    for (const [k, v] of Object.entries(u.delegationCalls).slice(0, 10)) {
      if (typeof v === "number" && Number.isFinite(v)) result.delegationCalls[k.slice(0, 50)] = v;
    }
  }
  if (!untrusted) result.agentResultMissing = true;

  // Grade -> score.
  let scoreSource: string;
  let finalScore: number;
  if (!grade) {
    scoreSource = "grade-error";
    finalScore = 0;
    result.testExitCode = null;
    result.testOutput = "GRADE_ERROR: the fresh-container grader produced no result";
  } else {
    result.testExitCode = grade.testExitCode;
    result.testOutput = grade.testOutput;
    result.diffApplied = grade.diffApplied;
    if (grade.applyError) result.diffApplyError = grade.applyError;
    result.tamperFiles = grade.tamperFiles;
    result.unconfirmedTests = grade.unconfirmedTests ?? [];
    if (grade.tamperFiles.length > 0) {
      scoreSource = "tamper-rejected";
      finalScore = 0;
    } else {
      ({ scoreSource, finalScore } = decideScore({
        isSweTestTask: true,
        harnessError: grade.harnessError,
        testExitCode: grade.testExitCode,
        judgeScore: judge?.judgeScore ?? null,
        judgeParseFailed: judge?.judgeParseFailed ?? true,
        testSource: "fresh-container-test",
      }));
    }
  }
  result.judgeScore = finalScore;
  result.scoreSource = scoreSource;
  result.excludeFromPassRate = scoreSource === "harness-error";
  result.sweContainerTest = true;
  result.sweTestExitCode = result.testExitCode;
  result.gradedInFreshContainer = true;

  result.judgeRationale = judge?.rationale ?? "";
  result.judgeModelScore = judge?.judgeScore ?? null;
  result.judgeParseFailed = judge?.judgeParseFailed ?? true;
  result.judgeAttempts = judge?.judgeAttemptsUsed ?? 0;
  if (judge?.judgeModel) result.judgeModel = judge.judgeModel;

  result.egressDeniedByProxy = egress.denied.length;
  result.egressDeniedTargets = [...new Set(egress.denied)].sort();
  result.contaminationSuspected =
    attempts.some((a: any) => a.category === "upstream-source") || egress.denied.some((t) => SOURCE_HOST_RE.test(t));
  result.sealedNetwork = true;
  return result;
}
