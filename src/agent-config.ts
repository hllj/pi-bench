// Visibility into what pi-coding-agent actually loaded from ~/.pi/agent.
//
// Why this exists: ~/.pi/agent/{skills,prompts,agents,extensions} are commonly
// full of ABSOLUTE symlinks into a separate config repo (e.g. ~/pi-config).
// Inside a container, a symlink whose target isn't bind-mounted at the same
// absolute path dangles, and pi's resource loader drops it SILENTLY -- no
// diagnostic, `[Skills] []` -- so a run looks healthy but the agent has no
// skills or prompt templates. Printing the loaded set (and flagging dangling
// links) at session start makes that failure visible in every run's log.
import { lstatSync, existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const LINKED_RESOURCE_DIRS = ["skills", "prompts", "agents", "extensions"];

// Returns every symlink under agentDir's resource dirs (the dir itself if it is
// a symlink, plus its immediate children) whose target does not exist.
export function findDanglingSymlinks(agentDir: string): string[] {
  const dangling: string[] = [];
  const isDangling = (p: string) => {
    try {
      return lstatSync(p).isSymbolicLink() && !existsSync(p);
    } catch {
      return false;
    }
  };
  for (const name of LINKED_RESOURCE_DIRS) {
    const dir = join(agentDir, name);
    if (isDangling(dir)) {
      dangling.push(dir);
      continue;
    }
    let children: string[];
    try {
      children = readdirSync(dir);
    } catch {
      continue; // missing dir, or not a directory
    }
    for (const child of children) {
      const p = join(dir, child);
      if (isDangling(p)) dangling.push(p);
    }
  }
  return dangling;
}

// Mirrors pi's own startup labels: `todo.ts`, `subagent` (for subagent/index.ts),
// `pi-lens:dist` (for an npm package's dist/index.js).
function extensionLabel(path: string): string {
  const file = basename(path);
  if (!/^index\.[cm]?[jt]s$/.test(file)) return file;
  const parent = dirname(path);
  const dirName = basename(parent);
  const pkg = parent.match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)(?:\/|$)/)?.[1];
  return pkg && pkg !== dirName ? `${pkg}:${dirName}` : dirName;
}

export interface ResourceSummaryInput {
  context: string[];
  skills: string[];
  prompts: string[];
  extensions: string[];
  excludedTools: string[];
}

export function formatResourceSummary(input: ResourceSummaryInput): string {
  const section = (title: string, items: string[]) =>
    `[${title}]\n  ${items.length > 0 ? items.join(", ") : "(none)"}`;
  return [
    section("Context", input.context),
    section("Skills", input.skills),
    section("Prompts", input.prompts.map((p) => `/${p}`)),
    section("Extensions", input.extensions.map(extensionLabel)),
    section("Excluded tools", input.excludedTools),
  ].join("\n\n");
}
