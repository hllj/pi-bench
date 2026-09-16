// Validates FAIL_TO_PASS test identifiers before they're trusted to build a
// test command. The verified-mini import (mariushobbhahn/SWE-bench-verified-mini
// on HuggingFace) ships at least two instances with corrupted FAIL_TO_PASS:
//   - django__django-12209: a functools.partial DOCSTRING, not a test id
//   - sphinx-doc__sphinx-8265: "tests/test_pycode_ast.py::test_unparse[(1,"
//     -- a parametrized pytest node id truncated at a comma inside `[...]`
// Both silently produced either an empty module list (Django ran the FULL
// suite and hit the 300s exec timeout) or a nonexistent pytest node id
// ("not found", exit 4) -- see plans/improvement-plan.md P0 items 1-2.
// These validators catch both shapes without needing to know the "correct"
// value, which the corrupted upstream data doesn't give us anyway.

// Django FAIL_TO_PASS entries look like "test_foo (app.tests.SomeTestCase)".
const DJANGO_TEST_ID_RE = /^test_\w+ \([\w.]+\)$/;

export function isValidDjangoTestId(id: string): boolean {
  return DJANGO_TEST_ID_RE.test(id.trim());
}

// pytest node ids look like "path/to/test_file.py::test_name[param]" and
// must contain "::". Parametrized ids add a bracketed suffix that can embed
// its own parens/brackets (e.g. "test_unparse[(1, 2)-(1, 2)]") -- truncation
// during upstream curation leaves those unbalanced.
export function hasBalancedBrackets(id: string): boolean {
  const pairs: Record<string, string> = { ")": "(", "]": "[" };
  const stack: string[] = [];
  for (const ch of id) {
    if (ch === "(" || ch === "[") {
      stack.push(ch);
    } else if (ch === ")" || ch === "]") {
      if (stack.pop() !== pairs[ch]) return false;
    }
  }
  return stack.length === 0;
}

export function isValidPytestNodeId(id: string): boolean {
  const trimmed = id.trim();
  return trimmed.includes("::") && hasBalancedBrackets(trimmed);
}

export type TestIdRepoKind = "django" | "pytest";

export function repoKindFor(repo: string): TestIdRepoKind {
  return repo === "django/django" ? "django" : "pytest";
}

export function isValidTestId(repo: string, id: string): boolean {
  return repoKindFor(repo) === "django" ? isValidDjangoTestId(id) : isValidPytestNodeId(id);
}

export interface FailToPassValidation {
  valid: boolean;
  invalidIds: string[];
}

// Validates every entry; any single malformed id fails the whole task's
// FAIL_TO_PASS (a partial run on garbage data isn't trustworthy either).
export function validateFailToPass(repo: string, failToPass: string[]): FailToPassValidation {
  const invalidIds = (failToPass || []).filter((id) => !isValidTestId(repo, id));
  return { valid: invalidIds.length === 0 && (failToPass || []).length > 0, invalidIds };
}

// Extracts Django test modules from FAIL_TO_PASS entries like
// "test_foo (auth_tests.test_forms.AuthTest)" -> "auth_tests.test_forms".
// Only ever called on already-validated ids (see validateFailToPass), so the
// regex match is guaranteed here -- an empty result plus a valid input list
// would be a bug in this function, not bad data.
export function extractDjangoTestModules(failToPass: string[]): string[] {
  const modules = new Set<string>();
  for (const id of failToPass) {
    const match = id.match(/\(([^)]+)\)/);
    if (!match) continue;
    const parts = match[1].split(".");
    modules.add(parts.slice(0, -1).join("."));
  }
  return [...modules].filter(Boolean);
}
