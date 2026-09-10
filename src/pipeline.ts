import { collectEvidence } from "./collectors/index.js";
import { analyzeEnvironment, loadBaselineEnv } from "./collectors/runtime.js";
import { applyEdits, restoreFiles, snapshotFiles } from "./analysis/patch.js";
import { attemptOutcome, attemptSummary } from "./analysis/attempts.js";
import { buildBlastRadius } from "./analysis/blast-radius.js";
import { recallIncidents, rememberIncident } from "./analysis/memory.js";
import { buildProductionIncident } from "./analysis/production.js";
import { createInvestigator } from "./llm/index.js";
import { LogAnalyzerAgent } from "./agents/log-analyzer.js";
import { ClassifierAgent } from "./agents/classifier-agent.js";
import { CodeInvestigatorAgent } from "./agents/code-investigator.js";
import { GitInvestigatorAgent } from "./agents/git-investigator.js";
import { DependencyAnalystAgent } from "./agents/dependency-analyst.js";
import { ReproductionAgent } from "./agents/reproduction-agent.js";
import { RootCauseAgent } from "./agents/root-cause-agent.js";
import { FixAgent } from "./agents/fix-agent.js";
import { TestAgent } from "./agents/test-agent.js";
import { ValidationAgent } from "./agents/validation-agent.js";
import { IncidentAgent } from "./agents/incident-agent.js";
import { runRoutedSpecialists } from "./agents/specialists.js";
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
  const maxIterations = Math.max(1, options.maxIterations ?? 3);
  const runTests = options.runTests !== false;
  const apply = Boolean(options.apply);
  const config = loadConfig(options);
  const investigator: Investigator =
    options.investigatorInstance ?? createInvestigator({ ...options, repoPath }, config);
  const agentRuns: AgentRun[] = [];

  emit({
    stage: "log-analyzer",
    agent: "Log Analyzer",
    message: "Understand logs, exceptions and stack traces...",
  });
  const { result: logAnalysis, run: logRun } = await new LogAnalyzerAgent().run({ input: bug });
  agentRuns.push(logRun);

  emit({
    stage: "classifier",
    agent: "Failure Classifier",
    message: "Classify the failure before investigation...",
  });
  const { result: classification, run: classRun } = await new ClassifierAgent().run({ input: bug, logAnalysis });
  agentRuns.push(classRun);

  emit({
    stage: "environment",
    message: "Collect toolchain, OS, flavor, and git environment...",
  });
  const evidence = await collectEvidence(bug, logAnalysis);
  const baseline = await loadBaselineEnv(options.baselineEnvPath);
  const environment = analyzeEnvironment({
    local: evidence.runtime,
    extraContext: bug.extraContext,
    baseline,
  });
  evidence.classification = classification;
  evidence.environment = environment;

  emit({
    stage: "crash-agent",
    agent: "Debugging Orchestrator",
    message: `Routing ${classification.routedAgents.join(", ") || "core agents"}...`,
  });
  const { findings: specialists, runs: specialistRuns } = await runRoutedSpecialists(
    { input: bug, logAnalysis, classification, environment },
    classification.routedAgents,
  );
  agentRuns.push(...specialistRuns);
  evidence.specialists = specialists;

  emit({
    stage: "code-investigator",
    agent: "Code Investigator",
    message: "Trace the error through the codebase...",
  });
  const { result: codeInvestigation, run: codeRun } = await new CodeInvestigatorAgent().run({
    input: bug,
    logAnalysis,
    classification,
    specialists,
  });
  agentRuns.push(codeRun);

  emit({
    stage: "git-investigator",
    agent: "Git Investigator",
    message: "When did this bug appear? Blame, file changes, introducing commit...",
  });
  emit({
    stage: "dependency-analyst",
    agent: "Dependency Analyst",
    message: "Detect dependency/version-related issues...",
  });
  const [{ result: gitInvestigation, run: gitRun }, { result: dependencyAnalysis, run: depRun }] = await Promise.all([
    new GitInvestigatorAgent().run({ input: bug, logAnalysis, codeInvestigation }),
    new DependencyAnalystAgent().run({ input: bug, logAnalysis, codeInvestigation }),
  ]);
  agentRuns.push(gitRun, depRun);

  evidence.codeInvestigation = codeInvestigation;
  evidence.gitInvestigation = gitInvestigation;
  evidence.dependencyAnalysis = dependencyAnalysis;

  emit({
    stage: "memory",
    message: "Search previous incidents for the same pattern...",
  });
  let memory = await recallIncidents({
    repoPath,
    errorType: evidence.error.type,
    errorMessage: evidence.error.message,
    category: classification.category,
    files: codeInvestigation.origin ? [codeInvestigation.origin.file] : [],
  });
  evidence.memory = memory;

  emit({
    stage: "reproduction-agent",
    agent: "Reproduction Agent",
    message: runTests
      ? "Can I reproduce this bug? Understand symptoms, run the scenario, compare the failure..."
      : "Planning reproduction (live run skipped)...",
  });
  const { result: reproductionAnalysis, run: reproRun } = await new ReproductionAgent().run({
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
    message: "Build an evidence graph and rank possible causes...",
  });
  const { result: causeAnalysis, run: causeRun } = await new RootCauseAgent().run({
    input: bug,
    logAnalysis,
    codeInvestigation,
    gitInvestigation,
    dependencyAnalysis,
    evidence,
    reproduction: reproductionAnalysis,
    classification,
    specialists,
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
    const attempt = index + 1;
    const retryInput = lastFailure
      ? { ...bug, extraContext: [bug.extraContext, `Previous patch failed:\n${lastFailure}`].filter(Boolean).join("\n") }
      : bug;

    emit({
      stage: "analyze",
      message: lastFailure
        ? `Attempt ${attempt}: investigate failure and modify patch...`
        : `Diagnosis → patch (${investigator.name}, attempt ${attempt}/${maxIterations})...`,
    });
    const rootCause = await investigator.analyze(retryInput, evidence, reproduction);

    emit({
      stage: "fix-agent",
      agent: "Fix Agent",
      message: lastFailure ? "Modify patch from the failing test output..." : "Generate a minimal code fix...",
    });
    const { result: fixAnalysis, run: fixRun } = await fixAgent.run({
      input: retryInput,
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
      classification,
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
      message: apply && runTests ? "Run tests against the patch..." : "Planning tests (live run skipped until --apply)...",
    });
    const { result: testAnalysis, run: testRun } = await testAgent.run({
      input: retryInput,
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

    const outcome = attemptOutcome(verification);
    emit({
      stage: "verify",
      message: attemptSummary(attempt, outcome),
    });

    const canRetry =
      apply && Boolean(snapshot) && verification.testsRan && !verification.passed && index < maxIterations - 1;
    if (canRetry && snapshot) {
      emit({ stage: "verify", message: "Tests failed — restoring files and investigating..." });
      await restoreFiles(snapshot);
      lastFailure = verification.output || verification.summary;
      verification = {
        ...verification,
        summary: `${verification.summary} Files restored; retrying with the new failure output.`,
      };
    }

    if (outcome === "tests-passed") {
      emit({
        stage: "test-agent",
        agent: "Test Agent",
        message: testAnalysis.proposedTest
          ? `Regression test: ${testAnalysis.proposedTest.path}`
          : "Regression coverage already present.",
      });
    }

    emit({
      stage: "validation-agent",
      agent: "Validation Agent",
      message: outcome === "tests-passed" ? "Final verification..." : "Check whether the fix actually resolves the issue...",
    });
    const { result: validationAnalysis, run: validationRun } = await validationAgent.run({
      input: retryInput,
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

    iterations.push({
      index,
      attempt,
      outcome,
      summary: attemptSummary(attempt, outcome),
      rootCause,
      fix,
      verification,
    });

    if (!apply || verification.passed || !verification.testsRan) {
      break;
    }
  }

  const last = iterations.at(-1);
  if (!last || !lastFixAnalysis || !lastTestAnalysis || !lastValidationAnalysis) {
    throw new Error("Investigation produced no iterations.");
  }

  emit({
    stage: "blast-radius",
    message: "What else could this change break?",
  });
  const blastRadius = buildBlastRadius({
    codeInvestigation,
    affectedFiles: last.rootCause.affectedFiles,
  });
  evidence.blastRadius = blastRadius;

  memory = await rememberIncident({
    repoPath,
    errorType: evidence.error.type,
    errorMessage: evidence.error.message,
    category: classification.category,
    rootCause: last.rootCause.rootCause,
    fix: last.fix.summary,
    resolution: lastValidationAnalysis.summary,
    files: last.rootCause.affectedFiles,
  });
  evidence.memory = memory;

  const production = buildProductionIncident({
    bug,
    rootCause: last.rootCause,
    gitInvestigation,
    groupedCount: memory.matches.length || undefined,
    confidence: causeAnalysis.confidence,
  });

  emit({
    stage: "incident-agent",
    agent: "Incident Agent",
    message: production ? "Production incident mode: group crashes, version, first occurrence..." : "Produce an engineer-friendly incident report...",
  });
  const { result: incidentReport, run: incidentRun } = await new IncidentAgent().run({
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
  if (production) incidentReport.production = production;
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
  if (environment.mismatches.length) notes.push(environment.summary);
  if (memory.matches.length) notes.push(memory.summary);

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
    classification,
    environment,
    specialists,
    blastRadius,
    memory,
    production,
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
