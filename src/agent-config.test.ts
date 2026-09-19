import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDanglingSymlinks, formatResourceSummary } from "./agent-config";

function makeAgentDir() {
  const root = mkdtempSync(join(tmpdir(), "agent-config-"));
  const agentDir = join(root, "agent");
  for (const d of ["skills", "prompts", "agents", "extensions"]) mkdirSync(join(agentDir, d), { recursive: true });
  return { root, agentDir };
}

describe("findDanglingSymlinks", () => {
  test("reports symlinks whose target is missing -- the silent skills/prompts drop in containers", () => {
    const { root, agentDir } = makeAgentDir();
    symlinkSync(join(root, "gone/skills/x"), join(agentDir, "skills/x"));
    expect(findDanglingSymlinks(agentDir)).toEqual([join(agentDir, "skills/x")]);
  });

  test("ignores symlinks that resolve and regular files", () => {
    const { root, agentDir } = makeAgentDir();
    mkdirSync(join(root, "repo/skills/ok"), { recursive: true });
    symlinkSync(join(root, "repo/skills/ok"), join(agentDir, "skills/ok"));
    writeFileSync(join(agentDir, "prompts/plain.md"), "hi");
    expect(findDanglingSymlinks(agentDir)).toEqual([]);
  });

  test("checks a top-level symlinked dir's children too, and tolerates missing subdirs", () => {
    const { root, agentDir } = makeAgentDir();
    mkdirSync(join(root, "repo/ext"), { recursive: true });
    symlinkSync(join(root, "nowhere"), join(root, "repo/ext/broken"));
    // extensions -> repo/ext (resolves); its child "broken" dangles
    const { agentDir: a2 } = makeAgentDir();
    require("node:fs").rmSync(join(a2, "extensions"), { recursive: true });
    symlinkSync(join(root, "repo/ext"), join(a2, "extensions"));
    expect(findDanglingSymlinks(a2)).toEqual([join(a2, "extensions/broken")]);
    require("node:fs").rmSync(join(agentDir, "agents"), { recursive: true });
    expect(findDanglingSymlinks(agentDir)).toEqual([]);
  });
});

describe("formatResourceSummary", () => {
  test("renders pi's [Context]/[Skills]/[Prompts]/[Extensions] header, with excluded tools", () => {
    const out = formatResourceSummary({
      context: ["/root/.pi/agent/AGENTS.md"],
      skills: ["dev-workflows", "subagents"],
      prompts: ["implement", "scout-and-plan"],
      extensions: ["/root/.pi/agent/extensions/todo.ts", "/root/.pi/agent/extensions/subagent/index.ts"],
      excludedTools: ["web_search", "question"],
    });
    expect(out).toContain("[Context]\n  /root/.pi/agent/AGENTS.md");
    expect(out).toContain("[Skills]\n  dev-workflows, subagents");
    expect(out).toContain("[Prompts]\n  /implement, /scout-and-plan");
    expect(out).toContain("[Extensions]\n  todo.ts, subagent");
    expect(out).toContain("[Excluded tools]\n  web_search, question");
  });

  test("labels npm-package extensions as pkg:dir, like pi's own startup header", () => {
    const out = formatResourceSummary({
      context: [], skills: [], prompts: [], excludedTools: [],
      extensions: ["/root/.pi/agent/npm/node_modules/pi-lens/dist/index.js"],
    });
    expect(out).toContain("[Extensions]\n  pi-lens:dist");
  });

  test("marks empty sections explicitly instead of omitting them", () => {
    const out = formatResourceSummary({ context: [], skills: [], prompts: [], extensions: [], excludedTools: [] });
    expect(out).toContain("[Skills]\n  (none)");
    expect(out).toContain("[Prompts]\n  (none)");
  });
});
