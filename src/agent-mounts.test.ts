import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HELPER = join(import.meta.dir, "..", "scripts", "agent-mounts.sh");

// Runs build_agent_mounts against a synthetic ~/.pi/agent and returns the
// resulting `docker run` mount flags (one per line) plus stderr warnings.
function mountsFor(agentDir: string) {
  const r = Bun.spawnSync(
    ["bash", "-c", `source "${HELPER}"; build_agent_mounts "$1"; printf '%s' "$RESOURCE_MOUNTS" | tr -s ' ' '\\n' | grep -v '^$' | paste -sd' ' -`, "_", agentDir],
    { stderr: "pipe" },
  );
  return { mounts: r.stdout.toString().trim(), stderr: r.stderr.toString() };
}

function layout() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-mounts-")));
  const agentDir = join(root, "agent");
  for (const d of ["skills", "prompts", "agents", "npm"]) mkdirSync(join(agentDir, d), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), "{}");
  writeFileSync(join(agentDir, "AGENTS.md"), "# ctx");
  return { root, agentDir };
}

describe("build_agent_mounts", () => {
  test("mounts the standard ~/.pi/agent resources read-only at /root/.pi/agent", () => {
    const { agentDir } = layout();
    const { mounts } = mountsFor(agentDir);
    for (const name of ["skills", "prompts", "agents", "settings.json", "AGENTS.md", "npm"]) {
      expect(mounts).toContain(`-v ${agentDir}/${name}:/root/.pi/agent/${name}:ro`);
    }
  });

  // Regression: skills/prompts/agents entries are absolute symlinks into a
  // config repo. Only the `extensions` symlink target used to be mounted, so
  // any skill/prompt linked into a DIFFERENT dir dangled in the container and
  // pi silently loaded zero skills/prompts.
  test("mounts each skills/prompts/agents symlink target at its identical host path", () => {
    const { root, agentDir } = layout();
    mkdirSync(join(root, "repo-a/skills/s1"), { recursive: true });
    mkdirSync(join(root, "repo-b/prompts"), { recursive: true });
    writeFileSync(join(root, "repo-b/prompts/p1.md"), "hi");
    mkdirSync(join(root, "repo-c"), { recursive: true });
    writeFileSync(join(root, "repo-c/reviewer.md"), "hi");
    symlinkSync(join(root, "repo-a/skills/s1"), join(agentDir, "skills/s1"));
    symlinkSync(join(root, "repo-b/prompts/p1.md"), join(agentDir, "prompts/p1.md"));
    symlinkSync(join(root, "repo-c/reviewer.md"), join(agentDir, "agents/reviewer.md"));
    const { mounts } = mountsFor(agentDir);
    expect(mounts).toContain(`-v ${root}/repo-a/skills/s1:${root}/repo-a/skills/s1:ro`);
    expect(mounts).toContain(`-v ${root}/repo-b/prompts/p1.md:${root}/repo-b/prompts/p1.md:ro`);
    expect(mounts).toContain(`-v ${root}/repo-c/reviewer.md:${root}/repo-c/reviewer.md:ro`);
  });

  test("keeps mounting a symlinked extensions dir's real target (previous behaviour)", () => {
    const { root, agentDir } = layout();
    mkdirSync(join(root, "pi-config"), { recursive: true });
    symlinkSync(join(root, "pi-config"), join(agentDir, "extensions"));
    const { mounts } = mountsFor(agentDir);
    expect(mounts).toContain(`-v ${agentDir}/extensions:/root/.pi/agent/extensions:ro`);
    expect(mounts).toContain(`-v ${root}/pi-config:${root}/pi-config:ro`);
  });

  test("does not add redundant mounts for targets already inside a mounted target", () => {
    const { root, agentDir } = layout();
    mkdirSync(join(root, "pi-config/skills/dev"), { recursive: true });
    mkdirSync(join(root, "pi-config/subagent/prompts"), { recursive: true });
    writeFileSync(join(root, "pi-config/subagent/prompts/impl.md"), "hi");
    symlinkSync(join(root, "pi-config"), join(agentDir, "extensions"));
    symlinkSync(join(root, "pi-config/skills/dev"), join(agentDir, "skills/dev"));
    symlinkSync(join(root, "pi-config/subagent/prompts/impl.md"), join(agentDir, "prompts/impl.md"));
    const { mounts } = mountsFor(agentDir);
    const targetMounts = mounts.split(" ").filter((a) => a.startsWith(`${root}/`) && !a.startsWith(`${agentDir}/`));
    expect(targetMounts).toEqual([`${root}/pi-config:${root}/pi-config:ro`]);
  });

  test("skips a symlink whose target is missing on the host too, and warns instead of failing", () => {
    const { root, agentDir } = layout();
    symlinkSync(join(root, "nowhere/skills/x"), join(agentDir, "skills/x"));
    const { mounts, stderr } = mountsFor(agentDir);
    expect(mounts).not.toContain("nowhere");
    expect(stderr).toContain("skills/x");
    expect(stderr).toMatch(/dangling|missing/i);
  });
});
