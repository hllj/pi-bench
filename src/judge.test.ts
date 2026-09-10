import { describe, expect, test } from "bun:test";
import { parseJudgeOutput } from "./judge";

describe("parseJudgeOutput", () => {
  test("parses well-formed JSON", () => {
    const out = parseJudgeOutput('{"score": 1, "rationale": "Looks correct."}');
    expect(out).toEqual({ score: 1, rationale: "Looks correct.", parseFailed: false });
  });

  test("strips markdown code fences before parsing", () => {
    const out = parseJudgeOutput('```json\n{"score": 0, "rationale": "Missing edge case."}\n```');
    expect(out.score).toBe(0);
    expect(out.parseFailed).toBe(false);
  });

  test("treats empty output as a parse failure", () => {
    const out = parseJudgeOutput("");
    expect(out.score).toBeNull();
    expect(out.parseFailed).toBe(true);
  });

  test("catches degenerate repeated-token output even with varying punctuation", () => {
    // Reproduces the exact shape of sphinx-doc__sphinx-8035's judge output:
    // repeated "the" with different trailing punctuation defeated the old
    // exact-string-match uniqueness guard.
    const degenerate = 'the the", the "the". the, "the" is, the "the", "the", "the", "the", "the", "the", "the", "the", "the", "the", "the", "the", "the", "the", "the"';
    const out = parseJudgeOutput(degenerate);
    expect(out.score).toBeNull();
    expect(out.parseFailed).toBe(true);
  });

  test("does not misfire the degenerate guard on a real short rationale", () => {
    const out = parseJudgeOutput('{"score": 1, "rationale": "The fix adds the missing null check to the constructor, and the added test confirms the behavior."}');
    expect(out.parseFailed).toBe(false);
    expect(out.score).toBe(1);
  });

  test("salvages a score via regex when the JSON body has a stray unescaped quote", () => {
    const raw = '{"score": 1, "rationale": "Uses \'quotes\' oddly but is fine"}';
    const out = parseJudgeOutput(raw);
    expect(out.parseFailed).toBe(false);
    expect(out.score).toBe(1);
  });

  test("falls back to a truncated raw excerpt when nothing is salvageable", () => {
    const out = parseJudgeOutput("I refuse to answer in JSON today.");
    expect(out.score).toBeNull();
    expect(out.parseFailed).toBe(true);
    expect(out.rationale).toContain("I refuse to answer");
  });
});
