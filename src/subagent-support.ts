// Subagents inside a benchmark container.
//
// pi-config's `subagent` extension runs each subagent as a separate `pi`
// process. Three things break that in a SWE-bench container unless the
// harness prepares for it:
//
//  1. Model access. The parent's gateway/local-host rewrite of models.json
//     happens in this process only; a child `pi` reads
//     $PI_CODING_AGENT_DIR/models.json (default ~/.pi/agent/models.json), which
//     doesn't exist in the container. In sealed mode the child then has no key
//     and no gateway route. The harness writes the effective models.json there.
//  2. Model identity. Agent files can pin their own model (planner/reviewer
//     on a different model than the one benchmarked). The sealed gateway only
//     forwards the benchmarked model, and in unsealed mode a second model would
//     silently contribute to the score. run-swe-bench.sh stages a copy of the
//     agent files with `model:` dropped, so children inherit the parent's model.
//  3. Tool exclusions. --exclude-tools applies to the parent session only; an
//     agent file listing web_search/web_fetch would hand them to the child.
//     The staged copy filters its `tools:` list with the same exclusions.

import { join } from "node:path";

export interface SanitizedAgent {
  content: string;
  removedModel?: string;
  removedTools: string[];
  hasToolsList: boolean;
}

export function sanitizeAgentDefinition(content: string, excludeTools: string[]): SanitizedAgent {
  const result: SanitizedAgent = { content, removedTools: [], hasToolsList: false };
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!m) return result;

  const exclude = new Set(excludeTools);
  const lines = m[1].split(/\r?\n/);
  const out: string[] = [];
  let inToolsBlock = false;
  for (const line of lines) {
    if (inToolsBlock) {
      const item = line.match(/^\s+-\s*(.+?)\s*$/);
      if (item) {
        if (exclude.has(item[1])) result.removedTools.push(item[1]);
        else out.push(line);
        continue;
      }
      inToolsBlock = false;
    }
    const model = line.match(/^model:\s*(.*?)\s*$/);
    if (model) {
      result.removedModel = model[1];
      continue;
    }
    const tools = line.match(/^tools:\s*(.*?)\s*$/);
    if (tools) {
      result.hasToolsList = true;
      if (tools[1] === "") {
        inToolsBlock = true;
        out.push(line);
        continue;
      }
      const kept: string[] = [];
      for (const t of tools[1].split(",").map((s) => s.trim()).filter(Boolean)) {
        if (exclude.has(t)) result.removedTools.push(t);
        else kept.push(t);
      }
      out.push(`tools: ${kept.join(", ")}`);
      continue;
    }
    out.push(line);
  }
  const frontmatter = `---\n${out.join("\n")}\n---${m[2]}`;
  result.content = frontmatter + content.slice(m[0].length);
  return result;
}

const SKILL_PATH_RE = /([A-Za-z0-9._-]+)\/SKILL\.md\b/;

// The skill name when a tool call reads a SKILL.md (via `read`, or `cat` & co.
// through `bash`), else null. Telemetry: shows whether the agent loaded skills.
export function skillReadName(toolName: string, args: any): string | null {
  let text: unknown;
  if (toolName === "read") text = args?.path;
  else if (toolName === "bash") text = args?.command;
  else return null;
  if (typeof text !== "string") return null;
  const m = text.match(SKILL_PATH_RE);
  return m ? m[1] : null;
}

const DELEGATION_TOOLS = new Set(["subagent", "run_dev_workflow", "run_workflow", "resume_workflow"]);

export function delegationKind(toolName: string): string | null {
  return DELEGATION_TOOLS.has(toolName) ? toolName : null;
}

export function childModelsTarget(env: Record<string, string | undefined>, home: string): string {
  return join(env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"), "models.json");
}
