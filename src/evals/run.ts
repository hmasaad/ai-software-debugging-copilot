import type { EvalCaseResult, EvalMetrics, EvalRun } from "../types.js";
import { KNOWN_BUGS } from "./dataset.js";
import { evaluateKnownBug } from "./evaluate.js";

export async function runEvalSuite(): Promise<EvalRun> {
  const started = Date.now();
  const cases: EvalCaseResult[] = [];
  for (const bug of KNOWN_BUGS) {
    cases.push(await evaluateKnownBug(bug));
  }
  const metrics = scoreMetrics(cases, Date.now() - started);
  return {
    cases,
    metrics,
    summary: renderEvalDashboard(metrics),
  };
}

export function renderEvalDashboard(metrics: EvalMetrics): string {
  const line = (label: string, value: string) => `${label.padEnd(26)}${value}`;
  return [
    "DEBUGGING COPILOT EVALS",
    "",
    line("Root Cause Accuracy", pct(metrics.rootCauseAccuracy)),
    line("Reproduction Rate", pct(metrics.reproductionRate)),
    line("Fix Success Rate", pct(metrics.fixSuccessRate)),
    line("Regression Test Rate", pct(metrics.regressionTestRate)),
    line("False Positive Rate", pct(metrics.falsePositiveRate)),
    line("Avg. Debug Time", formatDuration(metrics.avgDebugTimeMs)),
  ].join("\n");
}

export function renderEvalFooter(run: EvalRun): string {
  const failed = run.metrics.caseCount - run.metrics.passedCount;
  const iterations = `Avg. iterations ${run.metrics.avgIterations.toFixed(1)}`;
  return `${run.metrics.caseCount} known bugs  ·  ${run.metrics.passedCount} passed  ·  ${failed} failed  ·  ${iterations}`;
}

export function evalsBelowSlo(run: EvalRun): boolean {
  const requiredFailed = run.cases.some((item) => item.required && !item.passed);
  return (
    requiredFailed ||
    run.metrics.caseCount !== 100 ||
    run.metrics.rootCauseAccuracy < 0.75 ||
    run.metrics.reproductionRate < 0.7 ||
    run.metrics.fixSuccessRate < 0.6
  );
}

function scoreMetrics(cases: EvalCaseResult[], elapsedMs: number): EvalMetrics {
  const rate = (key: "rootCause" | "reproduction" | "fix" | "test"): number => {
    const scored = cases.filter((item) => item.dimensions?.[key] !== undefined);
    if (!scored.length) return 0;
    return scored.filter((item) => item.dimensions?.[key]).length / scored.length;
  };
  const traps = cases.filter((item) => item.dimensions?.falsePositive !== undefined);
  const falsePositives = traps.filter((item) => item.dimensions?.falsePositive).length;
  const iterations = cases
    .map((item) => item.dimensions?.iterations)
    .filter((value): value is number => typeof value === "number");
  const avgIterations = iterations.length
    ? iterations.reduce((sum, value) => sum + value, 0) / iterations.length
    : 0;
  return {
    rootCauseAccuracy: rate("rootCause"),
    reproductionRate: rate("reproduction"),
    fixSuccessRate: rate("fix"),
    regressionTestRate: rate("test"),
    falsePositiveRate: falsePositives / Math.max(1, cases.length),
    avgDebugTimeMs: elapsedMs / Math.max(1, cases.length),
    avgIterations,
    caseCount: cases.length,
    passedCount: cases.filter((item) => item.passed).length,
  };
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
