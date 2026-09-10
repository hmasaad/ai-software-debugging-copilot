import { describe, expect, it } from "vitest";
import { renderEvalDashboard, runEvalSuite } from "../src/evals/run.js";

describe("debugging evals", () => {
  it("runs the benchmark and prints a dashboard", async () => {
    const evals = await runEvalSuite();
    expect(evals.cases.every((item) => item.passed)).toBe(true);
    expect(evals.metrics.rootCauseAccuracy).toBeGreaterThan(0.9);
    expect(renderEvalDashboard(evals.metrics)).toContain("DEBUGGING COPILOT EVALS");
    expect(renderEvalDashboard(evals.metrics)).toContain("Root Cause Accuracy");
  });
});
