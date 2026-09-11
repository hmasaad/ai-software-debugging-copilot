import { describe, expect, it } from "vitest";
import { KNOWN_BUGS } from "../src/evals/dataset.js";
import { evalsBelowSlo, renderEvalDashboard, renderEvalFooter, runEvalSuite } from "../src/evals/run.js";

describe("debugging evals", () => {
  it("scores 100 known bugs and prints the dashboard", async () => {
    expect(KNOWN_BUGS).toHaveLength(100);
    expect(new Set(KNOWN_BUGS.map((bug) => bug.id)).size).toBe(100);
    expect(KNOWN_BUGS[0]?.id).toBe("bug-001");
    expect(KNOWN_BUGS[99]?.id).toBe("bug-100");

    const evals = await runEvalSuite();
    expect(evals.cases).toHaveLength(100);
    expect(evals.metrics.caseCount).toBe(100);

    const dashboard = renderEvalDashboard(evals.metrics);
    expect(dashboard).toContain("DEBUGGING COPILOT EVALS");
    expect(dashboard).toContain("Root Cause Accuracy");
    expect(dashboard).toContain("Reproduction Rate");
    expect(dashboard).toContain("Fix Success Rate");
    expect(dashboard).toContain("Regression Test Rate");
    expect(dashboard).toContain("False Positive Rate");
    expect(dashboard).toContain("Avg. Debug Time");
    expect(dashboard).not.toContain("Avg. Iterations");

    expect(evals.metrics.rootCauseAccuracy).toBeGreaterThan(0.75);
    expect(evals.metrics.rootCauseAccuracy).toBeLessThan(1);
    expect(evals.metrics.reproductionRate).toBeGreaterThan(0.7);
    expect(evals.metrics.fixSuccessRate).toBeGreaterThan(0.6);
    expect(evals.metrics.fixSuccessRate).toBeLessThan(1);
    expect(evals.metrics.regressionTestRate).toBeGreaterThan(0.7);
    expect(evals.metrics.falsePositiveRate).toBeGreaterThan(0);
    expect(evals.metrics.falsePositiveRate).toBeLessThanOrEqual(0.25);
    expect(evals.metrics.passedCount).toBeLessThan(100);
    expect(evals.metrics.avgIterations).toBeGreaterThan(0);
    expect(evals.cases.filter((item) => item.required).every((item) => item.passed)).toBe(true);
    expect(evalsBelowSlo(evals)).toBe(false);
    expect(renderEvalFooter(evals)).toContain("100 known bugs");
  });
});
