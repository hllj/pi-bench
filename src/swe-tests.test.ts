import { describe, expect, test } from "bun:test";
import { buildSweTestPlan, findUnconfirmedTests } from "./swe-tests";

const DJ = [
  "test_username_field_max_length_defaults_to_254 (auth_tests.test_forms.AuthenticationFormTest)",
  "test_username_field_max_length_matches_user_model (auth_tests.test_forms.AuthenticationFormTest)",
];

describe("findUnconfirmedTests (django)", () => {
  test("all FAIL_TO_PASS ids reported '... ok' -> none unconfirmed (real gold-patch output)", () => {
    const out = `${DJ[0]} ... ok\n${DJ[1]} ... ok\ntest_cleaned_data (auth_tests.test_forms.PasswordResetFormTest) ... ok\n\nRan 3 tests in 0.2s\n\nOK\n`;
    expect(findUnconfirmedTests("django/django", DJ, out)).toEqual([]);
  });

  test("rigged runner: 'Ran 0 tests ... OK' with no per-test lines -> all unconfirmed (real sitecustomize cheat output)", () => {
    expect(findUnconfirmedTests("django/django", DJ, "Ran 0 tests in 0.131s\n\nOK\n")).toEqual(DJ);
  });

  test("a test with a docstring prints '... ok' on the following line", () => {
    const out = `${DJ[0]}\nChecks the default max length. ... ok\n${DJ[1]} ... ok\n`;
    expect(findUnconfirmedTests("django/django", DJ, out)).toEqual([]);
  });

  test("a failing F2P test stays unconfirmed", () => {
    const out = `${DJ[0]} ... FAIL\n${DJ[1]} ... ok\n`;
    expect(findUnconfirmedTests("django/django", DJ, out)).toEqual([DJ[0]]);
  });

  test("a merely printed id without ' ... ok' does not count", () => {
    expect(findUnconfirmedTests("django/django", [DJ[0]], `echo ${DJ[0]}\n`)).toEqual([DJ[0]]);
  });
});

describe("findUnconfirmedTests (sphinx / pytest -rA)", () => {
  const ids = ["tests/test_directive_code.py::test_LiteralIncludeReader_dedent_and_append_and_prepend", "tests/test_pycode_ast.py::test_unparse[(1, 2, 3)-(1, 2, 3)]"];

  test("short-summary PASSED lines confirm each node id", () => {
    const out = `== short test summary info ==\nPASSED ${ids[0]}\nPASSED ${ids[1]}\n== 2 passed ==\n`;
    expect(findUnconfirmedTests("sphinx-doc/sphinx", ids, out)).toEqual([]);
  });

  test("missing summary line -> unconfirmed", () => {
    expect(findUnconfirmedTests("sphinx-doc/sphinx", ids, `PASSED ${ids[0]}\n`)).toEqual([ids[1]]);
  });
});

test("other repos are not checked (no known per-test format)", () => {
  expect(findUnconfirmedTests("psf/requests", ["x"], "")).toEqual([]);
});

test("sphinx plan asks pytest for the -rA summary the check relies on", () => {
  const plan = buildSweTestPlan({ repo: "sphinx-doc/sphinx", failToPass: ["tests/test_x.py::test_y"] });
  expect(plan.kind).toBe("execFile");
  if (plan.kind === "execFile") expect(plan.args).toContain("-rA");
});
