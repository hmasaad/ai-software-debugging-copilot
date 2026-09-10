import { describe, expect, it } from "vitest";
import { judgeValidation, ValidationAgent } from "../src/agents/validation-agent.js";
import { VALIDATION_AGENT } from "../src/agents/types.js";

describe("Validation Agent", () => {
  it("exposes the core-agent contract", () => {
    const agent = new ValidationAgent();
    expect(agent.id).toBe("validation-agent");
    expect(agent.name).toBe(VALIDATION_AGENT.name);
    expect(agent.responsibility).toBe("Check whether the fix actually resolves the issue");
  });

  it("marks a failing-then-passing applied patch as resolved", () => {
    const result = judgeValidation({
      applied: true,
      editsProposed: true,
      sourceUpdated: true,
      testsRan: true,
      testsPassed: true,
      originallyReproduced: true,
      originalError: "Expected NaN to equal 10",
      testOutput: "ok 1 defaults missing quantity to 1",
    });
    expect(result.verdict).toBe("resolved");
    expect(result.resolved).toBe(true);
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });

  it("marks the issue unresolved when tests still fail", () => {
    const result = judgeValidation({
      applied: true,
      editsProposed: true,
      sourceUpdated: true,
      testsRan: true,
      testsPassed: false,
      originallyReproduced: true,
      originalError: "Expected NaN to equal 10",
      testOutput: "AssertionError [ERR_ASSERTION]: Expected NaN to equal 10",
    });
    expect(result.verdict).toBe("unresolved");
    expect(result.resolved).toBe(false);
    expect(result.checks.find((check) => check.id === "original-error-gone")?.passed).toBe(false);
  });

  it("is inconclusive when the patch was never applied", () => {
    const result = judgeValidation({
      applied: false,
      editsProposed: true,
      sourceUpdated: false,
      testsRan: false,
      testsPassed: false,
    });
    expect(result.verdict).toBe("inconclusive");
  });
});
