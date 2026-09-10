import { collectEvidence } from "./collectors/index.js";
import { applyEdits, restoreFiles, snapshotFiles } from "./analysis/patch.js";
import { createInvestigator } from "./llm/index.js";
import { LogAnalyzerAgent } from "./agents/log-analyzer.js";
import { CodeInvestigatorAgent } from "./agents/code-investigator.js";
import { GitInvestigatorAgent } from "./agents/git-investigator.js";
import { DependencyAnalystAgent } from "./agents/dependency-analyst.js";
import { ReproductionAgent } from "./agents/reproduction-agent.js";
import { RootCauseAgent } from "./agents/root-cause-agent.js";
import { FixAgent } from "./agents/fix-agent.js";
import { TestAgent } from "./agents/test-agent.js";
import { ValidationAgent } from "./agents/validation-agent.js";
import { IncidentAgent } from "./agents/incident-agent.js";
import { loadConfig, resolveRepoPath } from "./config.js";
import { renderMarkdownReport, writeReports } from "./report/markdown.js";
import type {
  AgentRun,
  BugInput,
  DebuggingReport,
  FixAnalysis,
  Investigator,
  IterationRecord,
  PipelineEvent,
  PipelineOptions,
  TestAnalysis,
  ValidationAnalysis,
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
  const { result: logAnalysis, run: logRun } = await logAnalyzer.run({ input: bug });
  agentRuns.push(logRun);

  emit({
    stage: "code-investigator",
    agent: "Code Investigator",
    message: "Trace the error through the codebase...",
  });
  const codeInvestigator = new CodeInvestigatorAgent();
  const { result: codeInvestigation, run: codeRun } = await codeInvestigator.run({
    input: bug,
    logAnalysis,
  });
  agentRuns.push(codeRun);

  emit({
    stage: "git-investigator",
    agent: "Git Investigator",
    message: "Find commits/PRs that introduced the problem...",
  });
  emit({
    stage: "dependency-analyst",
    agent: "Dependency Analyst",
    message: "Detect dependency/version-related issues...",
  });
  const gitInvestigator = new GitInvestigatorAgent();
  const dependencyAnalyst = new DependencyAnalystAgent();
  const [{ result: gitInvestigation, run: gitRun }, { result: dependencyAnalysis, run: depRun }] = await Promise.all([
    gitInvestigator.run({ input: bug, logAnalysis, codeInvestigation }),
    dependencyAnalyst.run({ input: bug, logAnalysis, codeInvestigation }),
  ]);
  agentRuns.push(gitRun, depRun);

  emit({ stage: "collect", message: "Collecting remaining evidence (source, git, PRs, tests, dependencies, runtime)..." });
  const evidence = await collectEvidence(bug, logAnalysis);
  evidence.codeInvestigation = codeInvestigation;
  evidence.gitInvestigation = gitInvestigation;
  evidence.dependencyAnalysis = dependencyAnalysis;

  emit({
    stage: "reproduction-agent",
    agent: "Reproduction Agent",
    message: runTests ? "Determine how to reproduce the issue..." : "Planning reproduction (live run skipped)...",
  });
  const reproductionAgent = new ReproductionAgent();
  const { result: reproductionAnalysis, run: reproRun } = await reproductionAgent.run({
    input: bug,
    logAnalysis,
    codeInvestigation,
    gitInvestigation,
    dependencyAnalysis,
    evidence,
    runTests,
  });
  agentRuns.push(reproRun);
  evidence.reproductionAnalysis = reproductionAnalysis;
  const reproduction = reproductionAnalysis.result;

  emit({
    stage: "root-cause-agent",
    agent: "Root Cause Agent",
    message: "Build and rank possible causes...",
  });
  const rootCauseAgent = new RootCauseAgent();
  const { result: causeAnalysis, run: causeRun } = await rootCauseAgent.run({
    input: bug,
    logAnalysis,
    codeInvestigation,
    gitInvestigation,
    dependencyAnalysis,
    evidence,
    reproduction: reproductionAnalysis,
  });
  agentRuns.push(causeRun);
  evidence.causeAnalysis = causeAnalysis;

  const iterations: IterationRecord[] = [];
  let lastFailure: string | undefined;
  let lastFixAnalysis: FixAnalysis | undefined;
  let lastTestAnalysis: TestAnalysis | undefined;
  let lastValidationAnalysis: ValidationAnalysis | undefined;
  const fixAgent = new FixAgent();
  const testAgent = new TestAgent();
  const validationAgent = new ValidationAgent();

  for (let index = 0; index < maxIterations; index += 1) {
    emit({ stage: "analyze", message: `Root-cause analysis (${investigator.name}, pass ${index + 1}/${maxIterations})...` });
    const rootCause = await investigator.analyze(bug, evidence, reproduction);

    emit({
      stage: "fix-agent",
      agent: "Fix Agent",
      message: "Generate a minimal code fix...",
    });
    const { result: fixAnalysis, run: fixRun } = await fixAgent.run({
      input: bug,
      logAnalysis,
      codeInvestigation,
      gitInvestigation,
      dependencyAnalysis,
      evidence,
      reproduction: reproductionAnalysis,
      causeAnalysis,
      rootCause,
      investigator,
      previousFailure: lastFailure,
    });
    agentRuns.push(fixRun);

    let fix = fixAnalysis.proposal;
    let snapshot: Map<string, string> | undefined;
    if (apply && investigator.name !== "cursor") {
      snapshot = await snapshotFiles(repoPath, fix.edits);
      emit({ stage: "fix", message: `Applying ${fix.edits.length} edit(s)...` });
      fix = await applyEdits(repoPath, fix);
      fixAnalysis.proposal = fix;
    }
    evidence.fixAnalysis = fixAnalysis;
    lastFixAnalysis = fixAnalysis;

    emit({
      stage: "test-agent",
      agent: "Test Agent",
      message: apply && runTests ? "Create/run tests against the fix..." : "Planning tests (live run skipped until --apply)...",
    });
    const { result: testAnalysis, run: testRun } = await testAgent.run({
      input: bug,
      logAnalysis,
      codeInvestigation,
      evidence,
      reproduction: reproductionAnalysis,
      causeAnalysis,
      fixAnalysis,
      apply,
      runTests,
    });
    agentRuns.push(testRun);
    evidence.testAnalysis = testAnalysis;
    lastTestAnalysis = testAnalysis;
    let verification = testAnalysis.verification;

    emit({
      stage: "validation-agent",
      agent: "Validation Agent",
      message: "Check whether the fix actually resolves the issue...",
    });
    const { result: validationAnalysis, run: validationRun } = await validationAgent.run({
      input: bug,
      logAnalysis,
      codeInvestigation,
      dependencyAnalysis,
      evidence,
      reproduction: reproductionAnalysis,
      causeAnalysis,
      fixAnalysis,
      testAnalysis,
    });
    agentRuns.push(validationRun);
    evidence.validationAnalysis = validationAnalysis;
    lastValidationAnalysis = validationAnalysis;

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
  if (!last || !lastFixAnalysis || !lastTestAnalysis || !lastValidationAnalysis) {
    throw new Error("Investigation produced no iterations.");
  }

  emit({
    stage: "incident-agent",
    agent: "Incident Agent",
    message: "Produce an engineer-friendly incident report...",
  });
  const incidentAgent = new IncidentAgent();
  const { result: incidentReport, run: incidentRun } = await incidentAgent.run({
    input: bug,
    logAnalysis,
    codeInvestigation,
    gitInvestigation,
    dependencyAnalysis,
    evidence,
    reproduction: reproductionAnalysis,
    causeAnalysis,
    rootCause: last.rootCause,
    fixAnalysis: lastFixAnalysis,
    testAnalysis: lastTestAnalysis,
    validationAnalysis: lastValidationAnalysis,
  });
  agentRuns.push(incidentRun);
  evidence.incidentReport = incidentReport;

  const notes: string[] = [];
  if (investigator.name === "heuristic" && last.fix.edits.length === 0) {
    notes.push("Ran in heuristic mode (no LLM key). Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or CURSOR_API_KEY for generated patches.");
  }
  if (investigator.name === "heuristic" && last.fix.edits.length > 0) {
    notes.push("Heuristic Fix Agent produced a minimal patch. Set an LLM key for a more precise edit.");
  }
  if (!apply) {
    notes.push("Edits were not applied. Re-run with --apply to write the patch and verify.");
  }
  if (apply && lastValidationAnalysis.resolved) {
    notes.push("Validation Agent confirmed the original issue is resolved.");
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
    codeInvestigation,
    gitInvestigation,
    dependencyAnalysis,
    reproductionAnalysis,
    causeAnalysis,
    fixAnalysis: lastFixAnalysis,
    testAnalysis: lastTestAnalysis,
    validationAnalysis: lastValidationAnalysis,
    incidentReport,
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
