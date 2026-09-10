import { collectEvidence } from "./collectors/index.js";
import { reproduceBug } from "./analysis/reproduce.js";
import { applyEdits, restoreFiles, snapshotFiles } from "./analysis/patch.js";
import { verifyFix } from "./analysis/verify.js";
import { createInvestigator } from "./llm/index.js";
import { LogAnalyzerAgent } from "./agents/log-analyzer.js";
import { loadConfig, resolveRepoPath } from "./config.js";
import { renderMarkdownReport, writeReports } from "./report/markdown.js";
import type {
  AgentRun,
  BugInput,
  DebuggingReport,
  Investigator,
  IterationRecord,
  PipelineEvent,
  PipelineOptions,
} from "./types.js";

export async function debugBug(input: BugInput, options: PipelineOptions): Promise<DebuggingReport> {
  const repoPath = resolveRepoPath(options.repoPath || input.repoPath);
  const bug: BugInput = { ...input, repoPath };
  const emit = (event: PipelineEvent) => options.onEvent?.(event);
  const maxIterations = Math.max(1, options.maxIterations ?? 2);
  const runTests = options.runTests !== false;
  const apply = Boolean(options.apply);
  const config = loadConfig(options);
  const investigator: Investigator =
    options.investigatorInstance ?? createInvestigator({ ...options, repoPath }, config);
  const logAnalyzer = new LogAnalyzerAgent();
  const agentRuns: AgentRun[] = [];

  emit({
    stage: "log-analyzer",
    agent: logAnalyzer.name,
    message: `${logAnalyzer.responsibility}...`,
  });
  const { result: logAnalysis, run: logRun } = await logAnalyzer.run(bug);
  agentRuns.push(logRun);

  emit({ stage: "collect", message: "Collecting remaining evidence (source, git, PRs, tests, dependencies, runtime)..." });
  const evidence = await collectEvidence(bug, logAnalysis);

  emit({ stage: "reproduce", message: runTests ? "Attempting to reproduce the failure..." : "Skipping live reproduction." });
  const reproduction = await reproduceBug(bug, evidence, runTests);

  const iterations: IterationRecord[] = [];
  let lastFailure: string | undefined;

  for (let index = 0; index < maxIterations; index += 1) {
    emit({ stage: "analyze", message: `Root-cause analysis (${investigator.name}, pass ${index + 1}/${maxIterations})...` });
    const rootCause = await investigator.analyze(bug, evidence, reproduction);

    emit({ stage: "fix", message: "Generating a fix proposal..." });
    let fix = await investigator.proposeFix(bug, evidence, rootCause, lastFailure);

    let snapshot: Map<string, string> | undefined;
    if (apply && investigator.name !== "cursor") {
      snapshot = await snapshotFiles(repoPath, fix.edits);
      emit({ stage: "fix", message: `Applying ${fix.edits.length} edit(s)...` });
      fix = await applyEdits(repoPath, fix);
    }

    emit({
      stage: "test",
      message: apply && runTests ? "Running tests to verify the fix..." : "Skipping verification until a patch is applied.",
    });
    let verification = apply
      ? await verifyFix(repoPath, evidence, runTests)
      : {
          testsRan: false,
          passed: false,
          output: "",
          summary: "Patch not applied; verification skipped. Re-run with --apply to write the fix and run tests.",
        };

    if (apply && snapshot && verification.testsRan && !verification.passed && index < maxIterations - 1) {
      emit({ stage: "verify", message: "Verification failed; restoring files and iterating..." });
      await restoreFiles(snapshot);
      lastFailure = verification.output || verification.summary;
      verification = {
        ...verification,
        summary: `${verification.summary} Files restored; retrying with the new failure output.`,
      };
    }

    iterations.push({ index, rootCause, fix, verification });

    if (!apply || verification.passed || !verification.testsRan) {
      break;
    }
  }

  const last = iterations.at(-1);
  if (!last) {
    throw new Error("Investigation produced no iterations.");
  }

  const notes: string[] = [];
  if (investigator.name === "heuristic") {
    notes.push("Ran in heuristic mode (no LLM key). Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or CURSOR_API_KEY for generated patches.");
  }
  if (!apply) {
    notes.push("Edits were not applied. Re-run with --apply to write the patch and verify.");
  }
  if (apply && last.verification.testsRan && last.verification.passed) {
    notes.push("Fix applied and tests passed.");
  }

  const report: DebuggingReport = {
    title: `Debugging report: ${evidence.error.type ?? "Error"}: ${truncateTitle(evidence.error.message)}`,
    createdAt: new Date().toISOString(),
    repoPath,
    error: evidence.error,
    evidence,
    reproduction,
    rootCause: last.rootCause,
    proposedFix: last.fix,
    verification: last.verification,
    iterations,
    notes,
    agentRuns,
    logAnalysis,
  };

  emit({ stage: "report", message: "Writing debugging report..." });
  await writeReports(report, {
    markdownPath: options.reportPath,
    jsonPath: options.jsonReportPath,
  });

  return report;
}

function truncateTitle(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
}

export { renderMarkdownReport };
