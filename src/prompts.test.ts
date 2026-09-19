import { describe, expect, test } from "bun:test";
import { buildAgentPrompt, buildSweEnvInstruction, buildTemplateInvocation, buildVerificationRetryPrompt } from "./prompts";
// The SDK's own template expander is the oracle: it is exactly what
// session.prompt() runs on a "/name args" string. Not in the package's public
// exports map, hence the relative path.
import { expandPromptTemplate } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js";

describe("buildSweEnvInstruction", () => {
  test("returns empty string when not running in an SWE container", () => {
    expect(buildSweEnvInstruction(false)).toBe("");
  });

  test("no longer tells the agent to avoid the full relevant test file", () => {
    const instr = buildSweEnvInstruction(true);
    expect(instr).not.toContain("Avoid running the entire test suite though, if you can only focus on tests that are relevant");
  });

  test("instructs running the full test file/module containing the change, and warns about regressions", () => {
    const instr = buildSweEnvInstruction(true);
    expect(instr.toLowerCase()).toContain("full test");
    expect(instr.toLowerCase()).toContain("regression");
  });

  test("still tells the agent not to install packages or run the whole project suite", () => {
    const instr = buildSweEnvInstruction(true);
    expect(instr).toContain("Do NOT install packages");
    expect(instr.toLowerCase()).toMatch(/do not run the entire (project )?test suite|too slow/);
  });

  test("keeps the infinite-loop-prevention and git-archaeology instructions intact", () => {
    const instr = buildSweEnvInstruction(true);
    expect(instr).toContain("INFINITE LOOP PREVENTION");
    expect(instr).toContain("Unnecessary git archaeology");
  });
});

describe("buildAgentPrompt", () => {
  test("embeds the working directory, task prompt, and SWE env instruction", () => {
    const prompt = buildAgentPrompt({ tmpDir: "/testbed", isSweContainer: true, taskPrompt: "Fix bug X." });
    expect(prompt).toContain("/testbed");
    expect(prompt).toContain("Fix bug X.");
    expect(prompt.toLowerCase()).toContain("full test");
  });

  test("omits SWE-specific instructions for non-container runs", () => {
    const prompt = buildAgentPrompt({ tmpDir: "/tmp/x", isSweContainer: false, taskPrompt: "Fix bug Y." });
    expect(prompt).not.toContain("INFINITE LOOP PREVENTION");
  });
});

describe("buildVerificationRetryPrompt", () => {
  test("includes the truncated test output and the original failToPass list", () => {
    const prompt = buildVerificationRetryPrompt(
      "STDOUT:\nFAIL: test_foo (module.TestCase)\nAssertionError: expected 1, got 2\nSTDERR:\n",
      { failToPass: ["test_foo (module.TestCase)", "test_bar (module.TestCase)"] }
    );
    expect(prompt).toContain("test_foo (module.TestCase)");
    expect(prompt).toContain("AssertionError: expected 1, got 2");
    expect(prompt.toLowerCase()).toContain("still fail");
  });

  test("truncates very long test output to a bounded length", () => {
    const hugeOutput = "x".repeat(10000);
    const prompt = buildVerificationRetryPrompt(hugeOutput, { failToPass: ["test_foo"] });
    expect(prompt.length).toBeLessThan(6000);
  });
});

describe("buildTemplateInvocation", () => {
  // Mirrors ~/pi-config/subagent/prompts/*.md: the task text lands wherever $@ is.
  const templates = [{ name: "implement", description: "d", content: "Do this: $@ (end)", filePath: "/x", sourceInfo: {} }] as any;
  const expand = (text: string) => expandPromptTemplate(buildTemplateInvocation("implement", text), templates);

  test("prefixes the template name so pi expands it as a slash command", () => {
    expect(buildTemplateInvocation("implement", "fix it").startsWith("/implement ")).toBe(true);
  });

  test("delivers a plain single-line task through $@ unchanged", () => {
    expect(expand("fix the typo")).toBe("Do this: fix the typo (end)");
  });

  test("survives newlines, both quote types and backticks -- real task prompts contain all of them", () => {
    const task = "You are an expert.\n\nCRITICAL:\n1. Don't use \"clone\" -- it's already here.\n2. Fix `res.json(undefined)` in 'lib/response.js'.\n\nIssue: it says \"foo\" and 'bar'.";
    expect(expand(task)).toBe(`Do this: ${task} (end)`);
  });

  test("survives a task made only of quote characters, a leading slash, or edge whitespace", () => {
    for (const task of [`"`, `'`, `""'"'`, `/etc/passwd "x"`, `  leading and trailing  `]) {
      expect(expand(task)).toBe(`Do this: ${task} (end)`);
    }
  });

  test("rejects template names that could not be a single slash-command token", () => {
    for (const bad of ["", "has space", "../x", "a/b", "-x;rm"]) {
      expect(() => buildTemplateInvocation(bad, "t")).toThrow(/template name/i);
    }
  });
});
