import { describe, expect, test } from "bun:test";
import { diffPaths, findTamperFiles } from "./grade";

const fileDiff = (path: string, body = "+x = 1\n") =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n${body}`;

describe("diffPaths", () => {
  test("lists every file touched, including renames' destination", () => {
    const d = fileDiff("django/forms/fields.py") + "diff --git a/old.py b/new.py\nrename from old.py\nrename to new.py\n";
    expect(diffPaths(d)).toEqual(["django/forms/fields.py", "new.py", "old.py"]);
  });

  test("empty diff -> no paths", () => {
    expect(diffPaths("")).toEqual([]);
  });
});

describe("findTamperFiles", () => {
  test("a normal source fix is clean", () => {
    expect(findTamperFiles(fileDiff("django/contrib/auth/forms.py"))).toEqual([]);
  });

  test("sitecustomize/usercustomize anywhere are rejected (auto-imported at interpreter start)", () => {
    expect(findTamperFiles(fileDiff("sitecustomize.py"))).toEqual(["sitecustomize.py"]);
    expect(findTamperFiles(fileDiff("django/usercustomize.py"))).toEqual(["django/usercustomize.py"]);
  });

  test(".pth files are rejected", () => {
    expect(findTamperFiles(fileDiff("evil.pth"))).toEqual(["evil.pth"]);
  });

  test("conftest.py outside the reverted test dirs is rejected", () => {
    expect(findTamperFiles(fileDiff("conftest.py"))).toEqual(["conftest.py"]);
    expect(findTamperFiles(fileDiff("sphinx/conftest.py"))).toEqual(["sphinx/conftest.py"]);
  });

  test("conftest.py inside tests/ is fine -- the grader reverts those dirs anyway", () => {
    expect(findTamperFiles(fileDiff("tests/conftest.py"))).toEqual([]);
    expect(findTamperFiles(fileDiff("testing/conftest.py"))).toEqual([]);
  });
});
