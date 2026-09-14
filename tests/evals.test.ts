import { describe, expect, it } from "vitest";
import { KNOWN_BUGS } from "../src/evals/dataset.js";
import {
  EVAL_TARGETS,
  evalsBelowSlo,
  evalsMeetTargets,
  renderEvalDashboard,
  renderEvalFooter,
  runEvalSuite,
} from "../src/evals/run.js";

describe("debugging evals", () => {
  it("scores 100 known bugs against the autonomy bar", async () => {
    expect(KNOWN_BUGS).toHaveLength(100);
    expect(new Set(KNOWN_BUGS.map((bug) => bug.id)).size).toBe(100);
    expect(KNOWN_BUGS[0]?.id).toBe("bug-001");
    expect(KNOWN_BUGS[99]?.id).toBe("bug-100");

    expect(EVAL_TARGETS.rootCauseAccuracy).toEqual({ label: "Root-cause accuracy", target: ">90%", min: 0.9 });
    expect(EVAL_TARGETS.reproductionRate).toEqual({ label: "Reproduction success", target: ">85%", min: 0.85 });
    expect(EVAL_TARGETS.fixSuccessRate).toEqual({ label: "Fix success", target: ">80%", min: 0.8 });
    expect(EVAL_TARGETS.regressionTestRate).toEqual({
      label: "Regression-test success",
      target: ">90%",
      min: 0.9,
    });
    expect(EVAL_TARGETS.falsePositiveRate).toEqual({ label: "False root causes", target: "<10%", max: 0.1 });
    expect(EVAL_TARGETS.avgDebugTimeMs.target).toBe("↓");
    expect(EVAL_TARGETS.humanInterventionRate.target).toBe("↓");

    const evals = await runEvalSuite();
    expect(evals.cases).toHaveLength(100);
    expect(evals.metrics.caseCount).toBe(100);

    const dashboard = renderEvalDashboard(evals.metrics);
    expect(dashboard).toContain("DEBUGGING COPILOT EVALS");
    expect(dashboard).toContain("Metric");
    expect(dashboard).toContain("Measured");
    expect(dashboard).toContain("Target");
    expect(dashboard).toContain("Root-cause accuracy");
    expect(dashboard).toContain("Reproduction success");
    expect(dashboard).toContain("Fix success");
    expect(dashboard).toContain("Regression-test success");
    expect(dashboard).toContain("False root causes");
    expect(dashboard).toContain("Mean investigation time");
    expect(dashboard).toContain("Human intervention");
    expect(dashboard).toContain(">90%");
    expect(dashboard).toContain(">85%");
    expect(dashboard).toContain(">80%");
    expect(dashboard).toContain("<10%");
    expect(dashboard).toMatch(/Mean investigation time\s+\S+\s+↓/);
    expect(dashboard).toMatch(/Human intervention\s+\d+%\s+↓/);
    expect(dashboard).toContain("Autonomy bar: met");
    expect(dashboard).not.toContain("Avg. Iterations");
    expect(dashboard).not.toContain("Avg. Debug Time");
    expect(dashboard).not.toContain("Root Cause Accuracy");

    expect(evals.metrics.rootCauseAccuracy).toBeGreaterThan(0.9);
    expect(evals.metrics.rootCauseAccuracy).toBeLessThan(1);
    expect(evals.metrics.reproductionRate).toBeGreaterThan(0.85);
    expect(evals.metrics.fixSuccessRate).toBeGreaterThan(0.8);
    expect(evals.metrics.regressionTestRate).toBeGreaterThan(0.9);
    expect(evals.metrics.falsePositiveRate).toBeGreaterThan(0);
    expect(evals.metrics.falsePositiveRate).toBeLessThan(0.1);
    expect(evals.metrics.humanInterventionRate).toBeGreaterThan(0);
    expect(evals.metrics.humanInterventionRate).toBeLessThan(0.5);
    expect(evals.metrics.passedCount).toBeLessThan(100);
    expect(evals.metrics.avgIterations).toBeGreaterThan(0);
    expect(evals.cases.filter((item) => item.required).every((item) => item.passed)).toBe(true);
    expect(evalsMeetTargets(evals.metrics)).toBe(true);
    expect(evalsBelowSlo(evals)).toBe(false);
    expect(renderEvalFooter(evals)).toContain("100 known bugs");
  });
});
