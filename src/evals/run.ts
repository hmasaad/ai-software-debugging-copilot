import type { EvalCaseResult, EvalMetrics, EvalRun } from "../types.js";
import { KNOWN_BUGS } from "./dataset.js";
import { evaluateKnownBug } from "./evaluate.js";

/** Autonomy bar: do not call the copilot autonomous until measured rates clear these. */
export const EVAL_TARGETS = {
  rootCauseAccuracy: { label: "Root-cause accuracy", target: ">90%", min: 0.9 },
  reproductionRate: { label: "Reproduction success", target: ">85%", min: 0.85 },
  fixSuccessRate: { label: "Fix success", target: ">80%", min: 0.8 },
  regressionTestRate: { label: "Regression-test success", target: ">90%", min: 0.9 },
  falsePositiveRate: { label: "False root causes", target: "<10%", max: 0.1 },
  avgDebugTimeMs: { label: "Mean investigation time", target: "↓" },
  humanInterventionRate: { label: "Human intervention", target: "↓" },
} as const;

const METRIC_COL = 28;
const MEASURED_COL = 12;

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
  const line = (label: string, measured: string, target: string) =>
    `${label.padEnd(METRIC_COL)}${measured.padEnd(MEASURED_COL)}${target}`;
  return [
    "DEBUGGING COPILOT EVALS",
    "",
    line("Metric", "Measured", "Target"),
    line(EVAL_TARGETS.rootCauseAccuracy.label, pct(metrics.rootCauseAccuracy), EVAL_TARGETS.rootCauseAccuracy.target),
    line(EVAL_TARGETS.reproductionRate.label, pct(metrics.reproductionRate), EVAL_TARGETS.reproductionRate.target),
    line(EVAL_TARGETS.fixSuccessRate.label, pct(metrics.fixSuccessRate), EVAL_TARGETS.fixSuccessRate.target),
    line(EVAL_TARGETS.regressionTestRate.label, pct(metrics.regressionTestRate), EVAL_TARGETS.regressionTestRate.target),
    line(EVAL_TARGETS.falsePositiveRate.label, pct(metrics.falsePositiveRate), EVAL_TARGETS.falsePositiveRate.target),
    line(EVAL_TARGETS.avgDebugTimeMs.label, formatDuration(metrics.avgDebugTimeMs), EVAL_TARGETS.avgDebugTimeMs.target),
    line(
      EVAL_TARGETS.humanInterventionRate.label,
      pct(metrics.humanInterventionRate),
      EVAL_TARGETS.humanInterventionRate.target,
    ),
    "",
    `Autonomy bar: ${evalsMeetTargets(metrics) ? "met" : "not met"}`,
  ].join("\n");
}

export function renderEvalFooter(run: EvalRun): string {
  const failed = run.metrics.caseCount - run.metrics.passedCount;
  const iterations = `Avg. iterations ${run.metrics.avgIterations.toFixed(1)}`;
  return `${run.metrics.caseCount} known bugs  ·  ${run.metrics.passedCount} passed  ·  ${failed} failed  ·  ${iterations}`;
}

export function evalsMeetTargets(metrics: EvalMetrics): boolean {
  return (
    metrics.rootCauseAccuracy > EVAL_TARGETS.rootCauseAccuracy.min &&
    metrics.reproductionRate > EVAL_TARGETS.reproductionRate.min &&
    metrics.fixSuccessRate > EVAL_TARGETS.fixSuccessRate.min &&
    metrics.regressionTestRate > EVAL_TARGETS.regressionTestRate.min &&
    metrics.falsePositiveRate < EVAL_TARGETS.falsePositiveRate.max
  );
}

export function evalsBelowSlo(run: EvalRun): boolean {
  const requiredFailed = run.cases.some((item) => item.required && !item.passed);
  return requiredFailed || run.metrics.caseCount !== 100 || !evalsMeetTargets(run.metrics);
}

function scoreMetrics(cases: EvalCaseResult[], elapsedMs: number): EvalMetrics {
  const rate = (key: "rootCause" | "reproduction" | "fix" | "test"): number => {
    const scored = cases.filter((item) => item.dimensions?.[key] !== undefined);
    if (!scored.length) return 0;
    return scored.filter((item) => item.dimensions?.[key]).length / scored.length;
  };
  const falsePositives = cases.filter((item) => item.dimensions?.falsePositive).length;
  const intervention = cases.filter((item) => item.dimensions?.humanIntervention).length;
  const iterations = cases
    .map((item) => item.dimensions?.iterations)
    .filter((value): value is number => typeof value === "number");
  const durations = cases.map((item) => item.durationMs);
  const avgIterations = iterations.length
    ? iterations.reduce((sum, value) => sum + value, 0) / iterations.length
    : 0;
  const avgDebugTimeMs = durations.length
    ? durations.reduce((sum, value) => sum + value, 0) / durations.length
    : elapsedMs / Math.max(1, cases.length);
  return {
    rootCauseAccuracy: rate("rootCause"),
    reproductionRate: rate("reproduction"),
    fixSuccessRate: rate("fix"),
    regressionTestRate: rate("test"),
    falsePositiveRate: falsePositives / Math.max(1, cases.length),
    avgDebugTimeMs,
    humanInterventionRate: intervention / Math.max(1, cases.length),
    avgIterations,
    caseCount: cases.length,
    passedCount: cases.filter((item) => item.passed).length,
  };
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
