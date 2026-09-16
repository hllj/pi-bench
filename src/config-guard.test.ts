import { describe, expect, test } from "bun:test";
import {
  classifyConfigDiff,
  extractDiffFileBasenames,
  extractToolFilePath,
  isConfigArtifactFile,
} from "./config-guard";

describe("isConfigArtifactFile", () => {
  test("matches known build/config artifact basenames", () => {
    expect(isConfigArtifactFile("setup.py")).toBe(true);
    expect(isConfigArtifactFile("django/setup.py")).toBe(true);
    expect(isConfigArtifactFile("tox.ini")).toBe(true);
  });

  test("does not match source files", () => {
    expect(isConfigArtifactFile("django/db/models/base.py")).toBe(false);
  });
});

describe("extractToolFilePath", () => {
  test("reads file_path", () => {
    expect(extractToolFilePath({ file_path: "setup.py", content: "x" })).toBe("setup.py");
  });

  test("falls back to path", () => {
    expect(extractToolFilePath({ path: "tox.ini" })).toBe("tox.ini");
  });

  test("returns null for missing/malformed args", () => {
    expect(extractToolFilePath({})).toBeNull();
    expect(extractToolFilePath(null)).toBeNull();
    expect(extractToolFilePath("not-an-object")).toBeNull();
  });
});

describe("classifyConfigDiff", () => {
  const diff = (files: string[]) =>
    files.map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-old\n+new`).join("\n");

  test("none for an empty diff", () => {
    expect(classifyConfigDiff("")).toBe("none");
  });

  test("none for a source-only diff", () => {
    expect(classifyConfigDiff(diff(["django/db/models/base.py"]))).toBe("none");
  });

  test("config-only when every changed file is a config artifact", () => {
    expect(classifyConfigDiff(diff(["setup.py", "tox.ini"]))).toBe("config-only");
  });

  test("mixed when config artifacts ride alongside real source changes", () => {
    expect(classifyConfigDiff(diff(["setup.py", "django/db/models/base.py"]))).toBe("mixed");
  });
});

describe("extractDiffFileBasenames", () => {
  test("extracts basenames from diff --git headers", () => {
    const diffText = "diff --git a/tests/test_foo.py b/tests/test_foo.py\n--- a/tests/test_foo.py\n+++ b/tests/test_foo.py";
    expect(extractDiffFileBasenames(diffText)).toEqual(["test_foo.py"]);
  });
});
