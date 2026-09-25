// Stages a benchmark-safe copy of ~/.pi/agent/agents for run-swe-bench.sh:
// symlinks resolved, `model:` overrides dropped (children inherit the
// benchmarked model), excluded tools removed from `tools:` lists.
// See src/subagent-support.ts for why.
//
// Usage: bun run scripts/stage-agents.ts <src-agents-dir> <dst-dir> <excluded-tools-csv>

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeAgentDefinition } from "../src/subagent-support";

const [srcDir, dstDir, excludeCsv = ""] = process.argv.slice(2);
if (!srcDir || !dstDir) {
  console.error("Usage: bun run scripts/stage-agents.ts <src-agents-dir> <dst-dir> <excluded-tools-csv>");
  process.exit(1);
}
const exclude = excludeCsv.split(",").map((t) => t.trim()).filter(Boolean);

rmSync(dstDir, { recursive: true, force: true });
mkdirSync(dstDir, { recursive: true });

for (const name of readdirSync(srcDir).sort()) {
  const src = join(srcDir, name);
  let isFile = false;
  try {
    isFile = statSync(src).isFile(); // follows symlinks
  } catch {
    console.error(`[WARN] Agent ${name}: dangling symlink, skipped`);
    continue;
  }
  if (!isFile || !name.endsWith(".md")) continue;

  const out = sanitizeAgentDefinition(readFileSync(src, "utf-8"), exclude);
  writeFileSync(join(dstDir, name), out.content);

  const notes: string[] = [];
  if (out.removedModel) notes.push(`model ${out.removedModel} -> inherits benchmarked model`);
  if (out.removedTools.length > 0) notes.push(`removed tools ${out.removedTools.join(",")}`);
  if (!out.hasToolsList) notes.push("no tools list: the child gets every tool, --exclude-tools can't apply");
  console.error(`[INFO] Agent ${name}: ${notes.length > 0 ? notes.join("; ") : "unchanged"}`);
}
