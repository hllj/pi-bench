import { describe, expect, test } from "bun:test";
import { buildAgentPrompt, buildSweEnvInstruction } from "./prompts";

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
