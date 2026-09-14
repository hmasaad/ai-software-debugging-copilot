#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { debugAutonomously } from "./autonomous/debug.js";
import { debugBug } from "./pipeline.js";
import { renderMarkdownReport } from "./report/markdown.js";
import { renderDebugResult } from "./report/result.js";
import { renderEvidenceGraphAscii } from "./analysis/evidence-graph.js";
import { renderGitRegressionAscii } from "./analysis/git-regression.js";
import { renderFirstBadVersionAscii } from "./analysis/first-bad-version.js";
import { renderGitBisectAscii } from "./analysis/git-bisect.js";
import { renderAttemptLog } from "./analysis/attempts.js";
import { renderClassificationAscii } from "./analysis/classify.js";
import { renderBlastRadiusAscii } from "./analysis/blast-radius.js";
import { renderFixRiskAscii } from "./analysis/fix-risk.js";
import { renderEnvironmentAscii } from "./collectors/runtime.js";
import { renderProductionIncidentAscii } from "./analysis/production.js";
import {
  parseProductionMetrics,
  renderProductionInvestigatorAscii,
} from "./analysis/incident-investigator.js";
import { renderRollbackIntelligenceAscii } from "./analysis/rollback-intelligence.js";
import { renderIncidentTimelineAscii } from "./analysis/incident-timeline.js";
import { renderIncidentResponseAscii } from "./analysis/incident-response.js";
import { renderMemoryAscii } from "./analysis/memory.js";
import { evalsBelowSlo, renderEvalFooter, runEvalSuite } from "./evals/run.js";
import { renderSpecialistsAscii } from "./agents/specialists.js";
import { serveInvestigationBoard } from "./board/serve.js";
import type { DebuggingReport, InvestigatorKind } from "./types.js";

const HELP = `Usage: debug-copilot [options]
       debug-copilot incident [options]
       debug-copilot board [--json <path>] [--port <n>]
       debug-copilot evals

Investigate a bug like an engineer: classify the failure, collect evidence,
reproduce, rank root causes, patch, run tests, and verify — iterating when
tests fail. \`incident\` runs the production investigator: detect, correlate
logs/crashes/metrics, rank root cause, blast radius, regression, rollback intelligence,
incident timeline, autonomous response with approval gates, validate, and write the incident report.

Commands:
  debug-copilot [options]     Investigate a bug
  debug-copilot incident      Investigate a production incident automatically
  debug-copilot board         Open the last investigation board
  debug-copilot evals         Run the 100-bug debugging benchmark

With --autonomous the agent works in an isolated git worktree: inspect,
search, git history, reproduce, patch, re-test, inspect the diff, and revert
if validation fails. Deploy, production rollback, and data mutation always
require human approval. Production code is never touched unless you also pass
--apply (promote a validated non-destructive patch).

Options:
  --repo <path>           Repository to investigate (default: cwd)
  --error <text>          Error message
  --stack <text>          Stack trace (or pass via stdin)
  --log <path>            Path to a log file
  --test <path>           Failing test file or name
  --context <text>        Extra runtime context (also used as env baseline)
  --version <id>          Production app version (incident mode)
  --affected-users <n>    Production crash user count
  --first-seen <text>     First occurrence timestamp
  --source <name>         crashlytics | sentry | logs
  --metrics <json>        Production metrics (errorRate, p95, crash-free users)
  --baseline-env <path>   JSON toolchain snapshot to compare against
  --autonomous            Investigate in an isolated sandbox
  --keep-sandbox          Leave the sandbox directory on disk
  --apply                 Apply the patch (promote from sandbox in --autonomous)
  --run-tests             Reproduce and verify with the repo's test runner (default: true)
  --no-run-tests          Skip test execution
  --max-iterations <n>    Patch/test/verify loops (default: 3)
  --investigator <name>   auto | heuristic | openai | anthropic | cursor
  --model <id>            Override model id
  --report <path>         Write markdown report (default: ./debug-report.md)
  --json <path>           Write JSON report
  --board                 Open the investigation board after the run
  --port <n>              Board port (default: 8787)
  --no-open               Serve the board without launching a browser
  --stdout                Print the markdown report to stdout
  -h, --help              Show this help
`;

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      error: { type: "string" },
      stack: { type: "string" },
      log: { type: "string" },
      test: { type: "string" },
      context: { type: "string" },
      version: { type: "string" },
      "affected-users": { type: "string" },
      "first-seen": { type: "string" },
      source: { type: "string" },
      metrics: { type: "string" },
      "baseline-env": { type: "string" },
      apply: { type: "boolean", default: false },
      autonomous: { type: "boolean", default: false },
      "keep-sandbox": { type: "boolean", default: false },
      "run-tests": { type: "boolean", default: true },
      "no-run-tests": { type: "boolean", default: false },
      "max-iterations": { type: "string", default: "3" },
      investigator: { type: "string" },
      model: { type: "string" },
      report: { type: "string", default: "debug-report.md" },
      json: { type: "string" },
      board: { type: "boolean", default: false },
      port: { type: "string", default: "8787" },
      "no-open": { type: "boolean", default: false },
      stdout: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const port = Number.parseInt(values.port ?? "8787", 10) || 8787;
  const open = !values["no-open"];

  if (positionals[0] === "evals") {
    const evals = await runEvalSuite();
    process.stdout.write(`${evals.summary}\n\n${renderEvalFooter(evals)}\n`);
    const failures = evals.cases.filter((item) => !item.passed);
    for (const testCase of failures) {
      process.stderr.write(`✗ ${testCase.id} ${testCase.title} — ${testCase.detail}\n`);
    }
    if (evalsBelowSlo(evals)) process.exitCode = 2;
    return;
  }

  if (positionals[0] === "board") {
    const jsonPath = values.json ?? "debug-report.json";
    const report = await loadReport(jsonPath);
    await serveInvestigationBoard(report, { port, open });
    return;
  }

  const stdin = await readStdinIfPiped();
  const investigator = values.investigator as InvestigatorKind | undefined;
  if (investigator && !["auto", "heuristic", "openai", "anthropic", "cursor"].includes(investigator)) {
    throw new Error(`Unknown investigator: ${investigator}`);
  }

  const source = values.source as "crashlytics" | "sentry" | "logs" | undefined;
  if (source && !["crashlytics", "sentry", "logs"].includes(source)) {
    throw new Error(`Unknown incident source: ${source}`);
  }

  const jsonPath = values.json ?? (values.board ? "debug-report.json" : undefined);
  const metrics = parseProductionMetrics(values.metrics);
  const bug = {
    repoPath: values.repo ?? process.cwd(),
    message: values.error,
    stackTrace: values.stack ?? stdin,
    logPath: values.log,
    failingTest: values.test,
    extraContext: values.context,
    version: values.version,
    affectedUsers: values["affected-users"] ? Number.parseInt(values["affected-users"], 10) : undefined,
    firstSeen: values["first-seen"],
    incidentSource: source,
    metrics,
  };
  const pipeline = {
    repoPath: values.repo ?? process.cwd(),
    apply: values.apply,
    autonomous: values.autonomous,
    keepSandbox: values["keep-sandbox"],
    runTests: values["no-run-tests"] ? false : values["run-tests"],
    maxIterations: Number.parseInt(values["max-iterations"] ?? "3", 10) || 3,
    investigator,
    model: values.model,
    reportPath: values.report,
    jsonReportPath: jsonPath,
    baselineEnvPath: values["baseline-env"],
    onEvent: (event: { agent?: string; stage: string; message: string }) => {
      const label = event.agent ?? event.stage;
      process.stderr.write(`[${label}] ${event.message}\n`);
    },
  };

  const report = values.autonomous
    ? (await debugAutonomously(bug, pipeline)).report
    : await debugBug(bug, pipeline);

  process.stderr.write(`\n${renderDebugResult(report)}\n`);
  process.stderr.write(`\n${renderEvidenceGraphAscii(report.causeAnalysis.graph)}\n`);
  if (report.gitInvestigation.regression) {
    process.stderr.write(`\n${renderGitRegressionAscii(report.gitInvestigation.regression)}\n`);
  }
  if (report.gitInvestigation.firstBadVersion) {
    process.stderr.write(`\n${report.gitInvestigation.firstBadVersion.summary}\n`);
    process.stderr.write(`${renderFirstBadVersionAscii(report.gitInvestigation.firstBadVersion)}\n`);
  }
  if (report.gitInvestigation.bisect) {
    process.stderr.write(`\n${renderGitBisectAscii(report.gitInvestigation.bisect)}\n`);
  }
  if (report.iterations.length) {
    process.stderr.write(`\n${renderAttemptLog(report.iterations)}\n`);
  }
  if (report.classification) {
    process.stderr.write(`\n${renderClassificationAscii(report.classification)}\n`);
  }
  if (report.specialists) {
    process.stderr.write(`\n${renderSpecialistsAscii(report.specialists)}\n`);
  }
  if (report.environment) {
    process.stderr.write(`\n${renderEnvironmentAscii(report.environment)}\n`);
  }
  if (report.blastRadius) {
    process.stderr.write(`\n${renderBlastRadiusAscii(report.blastRadius)}\n`);
  }
  if (report.fixAnalysis?.alternatives?.length) {
    process.stderr.write(`\n${renderFixRiskAscii(report.fixAnalysis.alternatives)}\n`);
  } else if (report.fixAnalysis?.risk) {
    process.stderr.write(`\n${renderFixRiskAscii([report.fixAnalysis.risk])}\n`);
  }
  if (report.rollbackIntelligence) {
    process.stderr.write(`\n${renderRollbackIntelligenceAscii(report.rollbackIntelligence)}\n`);
  }
  if (report.incidentTimeline) {
    process.stderr.write(`\n${renderIncidentTimelineAscii(report.incidentTimeline)}\n`);
  }
  if (report.incidentResponse) {
    process.stderr.write(`\n${renderIncidentResponseAscii(report.incidentResponse)}\n`);
  }
  if (report.productionInvestigation || positionals[0] === "incident") {
    process.stderr.write(`\n${renderProductionInvestigatorAscii(report.productionInvestigation)}\n`);
  }
  if (report.production) {
    process.stderr.write(`\n${renderProductionIncidentAscii(report.production)}\n`);
  }
  if (report.memory) {
    process.stderr.write(`\n${renderMemoryAscii(report.memory)}\n`);
  }
  if (values.report) process.stderr.write(`Report: ${values.report}\n`);
  if (jsonPath) process.stderr.write(`JSON: ${jsonPath}\n`);

  if (values.stdout) {
    process.stdout.write(renderMarkdownReport(report));
    process.stdout.write("\n");
  }

  if (report.verification.testsRan && !report.verification.passed && values.apply) {
    process.exitCode = 2;
  }

  if (values.board) {
    await serveInvestigationBoard(report, { port, open });
  }
}

async function loadReport(jsonPath: string): Promise<DebuggingReport> {
  try {
    return JSON.parse(await readFile(jsonPath, "utf8")) as DebuggingReport;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not load investigation JSON at ${jsonPath}: ${reason}`);
  }
}

async function readStdinIfPiped(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text || undefined;
}

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`debug-copilot: ${message}\n`);
  process.exitCode = 1;
});
