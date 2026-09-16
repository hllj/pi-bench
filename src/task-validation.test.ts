import { describe, expect, test } from "bun:test";
import {
  extractDjangoTestModules,
  hasBalancedBrackets,
  isValidDjangoTestId,
  isValidPytestNodeId,
  validateFailToPass,
} from "./task-validation";

describe("isValidDjangoTestId", () => {
  test("accepts well-formed django test ids", () => {
    expect(isValidDjangoTestId("test_foo (auth_tests.test_forms.AuthTest)")).toBe(true);
    expect(isValidDjangoTestId("test_pk_serializers (serializers.test_data.SerializerTests)")).toBe(true);
  });

  test("rejects the known-corrupt django-12209 docstring entry", () => {
    expect(
      isValidDjangoTestId("partial(func, *args, **keywords) - new function with partial application")
    ).toBe(false);
  });

  test("rejects entries missing the module parens", () => {
    expect(isValidDjangoTestId("test_foo")).toBe(false);
  });
});

describe("hasBalancedBrackets / isValidPytestNodeId", () => {
  test("accepts a balanced parametrized node id", () => {
    expect(hasBalancedBrackets("test_unparse[(1, 2)-(1, 2)]")).toBe(true);
    expect(isValidPytestNodeId("tests/test_pycode_ast.py::test_unparse[(1, 2)-(1, 2)]")).toBe(true);
  });

  test("rejects the known-corrupt sphinx-8265 truncated node id", () => {
    expect(hasBalancedBrackets("tests/test_pycode_ast.py::test_unparse[(1,")).toBe(false);
    expect(isValidPytestNodeId("tests/test_pycode_ast.py::test_unparse[(1,")).toBe(false);
  });

  test("rejects node ids without ::", () => {
    expect(isValidPytestNodeId("test_unparse[a]")).toBe(false);
  });

  test("accepts a plain node id with no brackets", () => {
    expect(isValidPytestNodeId("tests/test_foo.py::test_bar")).toBe(true);
  });
});

describe("validateFailToPass", () => {
  test("valid for a well-formed django list", () => {
    const result = validateFailToPass("django/django", ["test_foo (auth_tests.test_forms.AuthTest)"]);
    expect(result.valid).toBe(true);
    expect(result.invalidIds).toEqual([]);
  });

  test("invalid for the known-corrupt django-12209 case", () => {
    const result = validateFailToPass("django/django", [
      "partial(func, *args, **keywords) - new function with partial application",
    ]);
    expect(result.valid).toBe(false);
    expect(result.invalidIds).toHaveLength(1);
  });

  test("invalid for the known-corrupt sphinx-8265 case", () => {
    const result = validateFailToPass("sphinx-doc/sphinx", ["tests/test_pycode_ast.py::test_unparse[(1,"]);
    expect(result.valid).toBe(false);
    expect(result.invalidIds).toHaveLength(1);
  });

  test("invalid for an empty failToPass list", () => {
    expect(validateFailToPass("django/django", []).valid).toBe(false);
  });
});

describe("extractDjangoTestModules", () => {
  test("extracts the module path, dropping the class name", () => {
    expect(extractDjangoTestModules(["test_foo (auth_tests.test_forms.AuthTest)"])).toEqual([
      "auth_tests.test_forms",
    ]);
  });

  test("de-duplicates modules shared by multiple test ids", () => {
    expect(
      extractDjangoTestModules([
        "test_foo (auth_tests.test_forms.AuthTest)",
        "test_bar (auth_tests.test_forms.OtherTest)",
      ])
    ).toEqual(["auth_tests.test_forms"]);
  });
});
