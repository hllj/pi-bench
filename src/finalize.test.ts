import { describe, expect, test } from "bun:test";
import { mergeSealedResult } from "./finalize";
import type { GradeResult } from "./grade";

const passGrade: GradeResult = { taskId: "t1", diffApplied: true, tamperFiles: [], testExitCode: 0, testOutput: "OK", harnessError: false };
const failGrade: GradeResult = { ...passGrade, testExitCode: 1, testOutput: "FAILED" };
const judge = { judgeScore: 1, rationale: "looks right", judgeParseFailed: false, judgeAttemptsUsed: 1, judgeModel: "google/gemini" };

describe("mergeSealedResult", () => {
  test("score comes from the fresh grade, never from the agent container's file", () => {
    // A forged agent-side result claiming a pass must not survive.
    const forged = { task: "t1", diff: "d", judgeScore: 1, scoreSource: "container-test", testExitCode: 0, sweTestExitCode: 0 };
    const r = mergeSealedResult({ taskId: "t1", untrusted: forged, grade: failGrade, judge, egress: { denied: [] } });
    expect(r.judgeScore).toBe(0);
    expect(r.scoreSource).toBe("fresh-container-test");
    expect(r.testExitCode).toBe(1);
    expect(r.sweTestExitCode).toBe(1);
    expect(r.testOutput).toBe("FAILED");
    expect(r.gradedInFreshContainer).toBe(true);
  });

  test("passing fresh grade -> score 1; judge verdict kept separately", () => {
    const r = mergeSealedResult({ taskId: "t1", untrusted: { diff: "d" }, grade: passGrade, judge: { ...judge, judgeScore: 0 }, egress: { denied: [] } });
    expect(r.judgeScore).toBe(1);
    expect(r.judgeModelScore).toBe(0);
  });

  test("an agent cannot drop itself from the denominator by claiming a harness error", () => {
    const r = mergeSealedResult({ taskId: "t1", untrusted: { excludeFromPassRate: true, scoreSource: "harness-error" }, grade: failGrade, judge, egress: { denied: [] } });
    expect(r.excludeFromPassRate).toBe(false);
  });

  test("harness error comes only from the grader", () => {
    const r = mergeSealedResult({ taskId: "t1", untrusted: {}, grade: { ...failGrade, testExitCode: null, harnessError: true }, judge, egress: { denied: [] } });
    expect(r.scoreSource).toBe("harness-error");
    expect(r.excludeFromPassRate).toBe(true);
  });

  test("tamper files force a fail even when the tests passed", () => {
    const r = mergeSealedResult({ taskId: "t1", untrusted: { diff: "d" }, grade: { ...passGrade, tamperFiles: ["sitecustomize.py"] }, judge, egress: { denied: [] } });
    expect(r.judgeScore).toBe(0);
    expect(r.scoreSource).toBe("tamper-rejected");
    expect(r.tamperFiles).toEqual(["sitecustomize.py"]);
  });

  test("missing grade (grader crashed) is a fail, not an exclusion", () => {
    const r = mergeSealedResult({ taskId: "t1", untrusted: { diff: "d" }, grade: null, judge: null, egress: { denied: [] } });
    expect(r.judgeScore).toBe(0);
    expect(r.scoreSource).toBe("grade-error");
    expect(r.excludeFromPassRate).toBe(false);
  });

  test("missing agent result (harness killed) is graded as an empty diff", () => {
    const r = mergeSealedResult({ taskId: "t1", untrusted: null, grade: failGrade, judge: null, egress: { denied: [] } });
    expect(r.agentResultMissing).toBe(true);
    expect(r.diff).toBe("");
  });

  test("only whitelisted, well-typed telemetry is copied", () => {
    const untrusted = { diff: "d", durationMs: 1234, timedOut: false, loopRecoveries: "lots", egressAttempts: Array(50).fill({ category: "http-fetch", snippet: "x" }), bogus: 1 };
    const r = mergeSealedResult({ taskId: "t1", untrusted, grade: passGrade, judge, egress: { denied: [] } });
    expect(r.durationMs).toBe(1234);
    expect(r.timedOut).toBe(false);
    expect(r.loopRecoveries).toBeUndefined();
    expect(r.egressAttempts.length).toBe(20);
    expect(r.bogus).toBeUndefined();
    expect(r.task).toBe("t1");
  });

  test("proxy denials of code hosts mark contamination even if the agent's own telemetry is clean", () => {
    const r = mergeSealedResult({ taskId: "t1", untrusted: { egressAttempts: [] }, grade: passGrade, judge, egress: { denied: ["raw.githubusercontent.com:443", "api.github.com:443", "example.com:80"] } });
    expect(r.egressDeniedByProxy).toBe(3);
    expect(r.egressDeniedTargets).toEqual(["api.github.com:443", "example.com:80", "raw.githubusercontent.com:443"]);
    expect(r.contaminationSuspected).toBe(true);
  });

  test("package-index denials alone are not contamination (pip/tool installers hit them)", () => {
    const denied = Array(42).fill("pypi.org:443").concat(["files.pythonhosted.org:443"]);
    const r = mergeSealedResult({ taskId: "t1", untrusted: { egressAttempts: [] }, grade: passGrade, judge, egress: { denied } });
    expect(r.egressDeniedByProxy).toBe(43);
    expect(r.contaminationSuspected).toBe(false);
  });

  test("an upstream-source command attempt still marks contamination", () => {
    const untrusted = { egressAttempts: [{ category: "upstream-source", snippet: "pip download sphinx==4.1.0 --no-deps" }] };
    const r = mergeSealedResult({ taskId: "t1", untrusted, grade: passGrade, judge, egress: { denied: ["pypi.org:443"] } });
    expect(r.contaminationSuspected).toBe(true);
  });
  test("skill/delegation telemetry is carried over type-checked", () => {
    const untrusted = { diff: "d", skillsRead: ["dev-workflows", 42], delegationCalls: { subagent: 2, run_dev_workflow: "x" } };
    const r = mergeSealedResult({ taskId: "t1", untrusted, grade: passGrade, judge, egress: { denied: [] } });
    expect(r.skillsRead).toEqual(["dev-workflows"]);
    expect(r.delegationCalls).toEqual({ subagent: 2 });
  });
});
