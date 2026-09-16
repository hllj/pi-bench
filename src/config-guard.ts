// Detects build/environment "artifact" files that SWE-bench containers ship
// pre-modified (dev-state differs from the git baseline) -- an agent that
// edits these is very likely reacting to environment noise, not fixing the
// actual bug (see plans/improvement-plan.md cross-cutting finding #2: 8/15
// observed failures touched setup.py/tox.ini). Used both as an early-warning
// interceptor on edit/write tool calls and as an end-of-run diff classifier.
const CONFIG_ARTIFACT_FILES = new Set([
  "setup.py", "setup.cfg", "tox.ini", "pyproject.toml",
  "requirements.txt", ".pre-commit-config.yaml", "Makefile",
  "MANIFEST.in", "pytest.ini", ".flake8", ".pylintrc",
]);

export function basename(path: string): string {
  return path.split("/").pop() || path;
}

export function isConfigArtifactFile(path: string): boolean {
  return CONFIG_ARTIFACT_FILES.has(basename(path));
}

// The edit/write tools accept either `file_path` or `path` (see
// node_modules/@earendil-works/pi-coding-agent's edit.js).
export function extractToolFilePath(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  const p = a.file_path ?? a.path;
  return typeof p === "string" ? p : null;
}

export function extractDiffFileBasenames(diffText: string): string[] {
  const files: string[] = [];
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git")) {
      const parts = line.split(" ");
      if (parts.length >= 4) {
        const filePath = parts[3].replace(/^b\//, "");
        files.push(basename(filePath));
      }
    }
  }
  return files;
}

export type ConfigDiffClassification = "none" | "config-only" | "mixed";

// "config-only": every changed file is a build/config artifact -- the agent
// almost certainly never touched real source code.
// "mixed": some changed files are config artifacts alongside real source
// changes -- previously invisible to the (all-or-nothing) config-only check,
// but still likely unwanted environment noise riding along with a real fix.
export function classifyConfigDiff(diffText: string): ConfigDiffClassification {
  if (!diffText.trim()) return "none";
  const files = extractDiffFileBasenames(diffText);
  if (files.length === 0) return "none";
  const configFiles = files.filter(isConfigArtifactFile);
  if (configFiles.length === 0) return "none";
  return configFiles.length === files.length ? "config-only" : "mixed";
}
