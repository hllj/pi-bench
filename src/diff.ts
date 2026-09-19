// Extracts the agent's work product from its working tree as a unified diff.
//
// Two ways the old inline version scored a correct fix as "no changes":
//  1. `exec`'s default 1 MiB maxBuffer: a bigger diff made `git diff --cached`
//     reject, and the catch-all turned that into "" -- silently.
//  2. The pi-lens extension writes .pi-lens-probe-home/ (large jsonl logs) into
//     whatever repo it runs in, and a subagent then `git add`s it. That is
//     tooling noise, not the agent's fix; it is what pushed the diff past 1 MiB
//     in the observed run (express-4744-easy under /implement).
// So: exclude known tooling artifacts, raise the buffer, and let real git
// failures propagate rather than masquerading as an empty diff.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_DIFF_BYTES = 64 * 1024 * 1024;

// Directories the agent's own tooling drops into the working tree.
export const TOOLING_ARTIFACT_DIRS = [".pi-lens-probe-home"];
const EXCLUDE_PATHSPECS = TOOLING_ARTIFACT_DIRS.map((d) => `:(exclude)${d}`);

export async function extractAgentDiff(cwd: string): Promise<string> {
  await execFileAsync("git", ["add", "-A", "--", ".", ...EXCLUDE_PATHSPECS], { cwd, maxBuffer: MAX_DIFF_BYTES });
  const { stdout } = await execFileAsync("git", ["diff", "--cached", "--", ".", ...EXCLUDE_PATHSPECS], {
    cwd,
    maxBuffer: MAX_DIFF_BYTES,
  });
  return stdout;
}
