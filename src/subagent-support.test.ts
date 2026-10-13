import { describe, expect, test } from "bun:test";
import {
  childModelsTarget,
  delegationKind,
  isAgentExcluded,
  resolveExcludedAgents,
  sanitizeAgentDefinition,
  skillReadName,
} from "./subagent-support";

const EXCLUDE = ["web_search", "web_fetch", "question", "questionnaire"];

describe("sanitizeAgentDefinition", () => {
  test("drops the model override so the child inherits the benchmarked model", () => {
    const src = "---\nname: planner\ntools: read, web_search, todo\nmodel: openrouter/z-ai/glm-5.3\n---\nYou plan.\nmodel: not frontmatter\n";
    const out = sanitizeAgentDefinition(src, EXCLUDE);
    expect(out.removedModel).toBe("openrouter/z-ai/glm-5.3");
    expect(out.content).not.toContain("glm-5.3");
    // Body text is untouched, even when it looks like a frontmatter key.
    expect(out.content).toContain("You plan.\nmodel: not frontmatter\n");
  });

  test("strips excluded tools from an inline tools list", () => {
    const src = "---\nname: scout\ntools: read, bash, web_search, web_fetch, symbol_search\n---\nbody\n";
    const out = sanitizeAgentDefinition(src, EXCLUDE);
    expect(out.content).toContain("tools: read, bash, symbol_search\n");
    expect(out.removedTools).toEqual(["web_search", "web_fetch"]);
    expect(out.hasToolsList).toBe(true);
  });

  test("strips excluded tools from a block tools list", () => {
    const src = "---\nname: x\ntools:\n  - read\n  - question\n  - bash\n---\nbody\n";
    const out = sanitizeAgentDefinition(src, EXCLUDE);
    expect(out.content).toBe("---\nname: x\ntools:\n  - read\n  - bash\n---\nbody\n");
    expect(out.removedTools).toEqual(["question"]);
  });

  test("reports an agent with no tools list (the child would get every tool)", () => {
    const out = sanitizeAgentDefinition("---\nname: open\n---\nbody\n", EXCLUDE);
    expect(out.hasToolsList).toBe(false);
    expect(out.content).toBe("---\nname: open\n---\nbody\n");
  });

  test("leaves a file without frontmatter alone", () => {
    const out = sanitizeAgentDefinition("just text\nmodel: x\n", EXCLUDE);
    expect(out.content).toBe("just text\nmodel: x\n");
    expect(out.removedModel).toBeUndefined();
  });
});

describe("skillReadName", () => {
  test("names the skill when a SKILL.md is read", () => {
    expect(skillReadName("read", { path: "/root/.pi/agent/skills/dev-workflows/SKILL.md" })).toBe("dev-workflows");
    expect(skillReadName("read", { path: "~/.pi/agent/npm/node_modules/pi-lens/skills/pi-lens-ast-grep/SKILL.md" })).toBe("pi-lens-ast-grep");
  });

  test("ignores other reads and other tools", () => {
    expect(skillReadName("read", { path: "/testbed/django/db/models/deletion.py" })).toBeNull();
    expect(skillReadName("bash", { command: "cat /root/.pi/agent/skills/subagents/SKILL.md" })).toBe("subagents");
    expect(skillReadName("bash", { command: "ls /testbed" })).toBeNull();
    expect(skillReadName("edit", { path: "/x/SKILL.md" })).toBeNull();
  });
});

describe("delegationKind", () => {
  test("recognises dispatch tools", () => {
    expect(delegationKind("subagent")).toBe("subagent");
    expect(delegationKind("run_dev_workflow")).toBe("run_dev_workflow");
    expect(delegationKind("run_workflow")).toBe("run_workflow");
    expect(delegationKind("bash")).toBeNull();
  });
});

describe("resolveExcludedAgents", () => {
  test("defaults to keeping every agent (reviewer included)", () => {
    expect(resolveExcludedAgents(undefined)).toEqual([]);
  });

  test("'none' or an empty value keeps every agent", () => {
    expect(resolveExcludedAgents("none")).toEqual([]);
    expect(resolveExcludedAgents("NONE")).toEqual([]);
    expect(resolveExcludedAgents("  ")).toEqual([]);
  });

  test("parses a comma-separated list", () => {
    expect(resolveExcludedAgents("reviewer, planner,,")).toEqual(["reviewer", "planner"]);
  });
});

describe("isAgentExcluded", () => {
  const reviewer = "---\nname: reviewer\ndescription: x\n---\nbody";

  test("matches the frontmatter name", () => {
    expect(isAgentExcluded("code-review.md", reviewer, ["reviewer"])).toBe(true);
  });

  test("matches the file name when the frontmatter has no name", () => {
    expect(isAgentExcluded("reviewer.md", "no frontmatter", ["reviewer"])).toBe(true);
  });

  test("keeps agents that are not listed", () => {
    expect(isAgentExcluded("scout.md", "---\nname: scout\n---\n", ["reviewer"])).toBe(false);
    expect(isAgentExcluded("reviewer.md", reviewer, [])).toBe(false);
  });
});

describe("childModelsTarget", () => {
  test("follows PI_CODING_AGENT_DIR, else ~/.pi/agent", () => {
    expect(childModelsTarget({ PI_CODING_AGENT_DIR: "/cfg" }, "/root")).toBe("/cfg/models.json");
    expect(childModelsTarget({}, "/root")).toBe("/root/.pi/agent/models.json");
  });
});
