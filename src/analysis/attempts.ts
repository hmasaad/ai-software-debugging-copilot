import type { AttemptOutcome, IterationRecord, VerificationResult } from "../types.js";

export function attemptOutcome(verification: VerificationResult): AttemptOutcome {
  if (!verification.testsRan) return "not-run";
  return verification.passed ? "tests-passed" : "tests-failed";
}

export function attemptSummary(attempt: number, outcome: AttemptOutcome): string {
  switch (outcome) {
    case "tests-passed":
      return `Attempt ${attempt} → Tests passed`;
    case "tests-failed":
      return `Attempt ${attempt} → Tests failed`;
    default:
      return `Attempt ${attempt} → Tests not run`;
  }
}

export function renderAttemptLog(iterations: IterationRecord[]): string {
  if (!iterations.length) return "No patch/test attempts.";
  return iterations.map((iteration) => iteration.summary || attemptSummary(iteration.attempt, iteration.outcome)).join("\n");
}
