import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentRun,
  FileEdit,
  ValidationAnalysis,
  ValidationCheck,
  ValidationVerdict,
} from "../types.js";
import { VALIDATION_AGENT, type AgentContext, type SpecialistAgent } from "./types.js";

/**
 * Validation Agent — checks whether the fix actually resolves the original issue.
 */
export class ValidationAgent implements SpecialistAgent<ValidationAnalysis> {
  readonly id = VALIDATION_AGENT.id;
  readonly name = VALIDATION_AGENT.name;
  readonly responsibility = VALIDATION_AGENT.responsibility;

  async run(ctx: AgentContext): Promise<{ result: ValidationAnalysis; run: AgentRun }> {
    const started = Date.now();
    const result = await this.analyze(ctx);
    return {
      result,
      run: {
        id: this.id,
        name: this.name,
        responsibility: this.responsibility,
        status: "ok",
        summary: result.summary,
        durationMs: Date.now() - started,
      },
    };
  }

  async analyze(ctx: AgentContext): Promise<ValidationAnalysis> {
    const edits = ctx.fixAnalysis?.proposal.edits ?? [];
    const sourceUpdated = edits.length ? await filesContainEdits(ctx.input.repoPath, edits) : false;
    return judgeValidation({
      applied: Boolean(ctx.fixAnalysis?.proposal.applied),
      editsProposed: edits.length > 0,
      sourceUpdated,
      testsRan: Boolean(ctx.testAnalysis?.verification.testsRan),
      testsPassed: Boolean(ctx.testAnalysis?.verification.passed),
      originallyReproduced: ctx.reproduction?.result.reproduced,
      originalError: ctx.logAnalysis?.error.message ?? ctx.evidence?.error.message,
      testOutput: ctx.testAnalysis?.verification.output,
      dependencyBug: Boolean(ctx.dependencyAnalysis?.likelyDependencyBug),
    });
  }
}

export function judgeValidation(input: {
  applied: boolean;
  editsProposed: boolean;
  sourceUpdated: boolean;
  testsRan: boolean;
  testsPassed: boolean;
  originallyReproduced?: boolean;
  originalError?: string;
  testOutput?: string;
  dependencyBug?: boolean;
}): ValidationAnalysis {
  const errorStillPresent = Boolean(
    input.testsRan &&
      input.originalError &&
      input.testOutput &&
      input.testOutput.includes(input.originalError.replace(/\s+/g, " ").trim().slice(0, 80)),
  );

  const checks: ValidationCheck[] = [
    {
      id: "patch-applied",
      passed: input.applied,
      detail: input.applied ? "Patch is in the working tree." : "Patch was not applied.",
    },
    {
      id: "source-updated",
      passed: input.sourceUpdated,
      detail: input.sourceUpdated
        ? "Crash-site file contains the new edit."
        : input.editsProposed
          ? "Crash-site file does not yet contain the proposed edit."
          : "No source edit was proposed.",
    },
    {
      id: "tests-passed",
      passed: input.testsRan && input.testsPassed,
      detail: !input.testsRan
        ? "Tests were not run."
        : input.testsPassed
          ? "Verification tests passed."
          : "Verification tests still fail.",
    },
    {
      id: "original-error-gone",
      passed: input.testsRan ? !errorStillPresent : false,
      detail: !input.testsRan
        ? "Cannot confirm the original error is gone until tests run."
        : errorStillPresent
          ? "Original error text still appears in test output."
          : "Original error text is absent from test output.",
    },
    {
      id: "repro-flipped",
      passed: Boolean(input.originallyReproduced && input.testsRan && input.testsPassed),
      detail:
        input.originallyReproduced && input.testsRan && input.testsPassed
          ? "Failure reproduced before the patch and passing after it."
          : "Did not observe a failing-then-passing flip.",
    },
  ];

  const residualRisks: string[] = [];
  if (input.dependencyBug) residualRisks.push("Leading cause was a dependency/version issue; a source patch may not be the real fix.");
  if (!input.editsProposed) residualRisks.push("No code edit was generated.");
  if (input.applied && !input.testsRan) residualRisks.push("Patch applied without a live test run.");
  if (errorStillPresent) residualRisks.push("The original error signature is still in the output.");

  const verdict = decideVerdict({
    applied: input.applied,
    sourceUpdated: input.sourceUpdated,
    testsRan: input.testsRan,
    testsPassed: input.testsPassed,
    errorStillPresent,
    editsProposed: input.editsProposed,
    dependencyBug: Boolean(input.dependencyBug),
  });
  const resolved = verdict === "resolved";
  const summary = buildSummary(verdict, checks);
  const handoff = buildHandoff(verdict, residualRisks);

  return { verdict, resolved, checks, residualRisks, summary, handoff };
}

function decideVerdict(input: {
  applied: boolean;
  sourceUpdated: boolean;
  testsRan: boolean;
  testsPassed: boolean;
  errorStillPresent: boolean;
  editsProposed: boolean;
  dependencyBug: boolean;
}): ValidationVerdict {
  if (input.testsRan && (!input.testsPassed || input.errorStillPresent)) return "unresolved";
  if (input.dependencyBug && !input.testsPassed) return "inconclusive";
  if (input.testsRan && input.testsPassed && (input.applied || input.sourceUpdated) && !input.errorStillPresent) {
    return "resolved";
  }
  if (input.testsRan && input.testsPassed && !input.errorStillPresent) return "likely-resolved";
  if ((input.applied || input.sourceUpdated) && !input.testsRan) return "likely-resolved";
  if (!input.editsProposed && !input.testsRan) return "inconclusive";
  return "inconclusive";
}

function buildSummary(verdict: ValidationVerdict, checks: ValidationCheck[]): string {
  const passed = checks.filter((check) => check.passed).length;
  if (verdict === "resolved") return `Fix resolves the issue (${passed}/${checks.length} checks passed).`;
  if (verdict === "likely-resolved") {
    return `Fix likely resolves the issue (${passed}/${checks.length} checks); confirm with a live failing-then-passing run.`;
  }
  if (verdict === "unresolved") return `Fix does not resolve the issue (${passed}/${checks.length} checks passed).`;
  return `Cannot confirm the fix yet (${passed}/${checks.length} checks passed).`;
}

function buildHandoff(verdict: ValidationVerdict, risks: string[]): string[] {
  const notes: string[] = [];
  if (verdict === "resolved") notes.push("Safe to keep the patch; write up the incident.");
  if (verdict === "likely-resolved") notes.push("Treat as tentatively fixed; run the original failing command to confirm.");
  if (verdict === "unresolved") notes.push("Do not ship this patch; restore and iterate.");
  if (verdict === "inconclusive") notes.push("Apply the patch and re-run tests before calling the incident resolved.");
  notes.push(...risks);
  return notes;
}

async function filesContainEdits(repoPath: string, edits: FileEdit[]): Promise<boolean> {
  for (const edit of edits) {
    const abs = path.resolve(repoPath, edit.path);
    if (!abs.startsWith(path.resolve(repoPath)) || !existsSync(abs)) return false;
    const content = await readFile(abs, "utf8");
    if (!content.includes(edit.newString)) return false;
  }
  return edits.length > 0;
}
