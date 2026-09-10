#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { debugBug } from "./pipeline.js";
import { renderMarkdownReport } from "./report/markdown.js";
import { serveInvestigationBoard } from "./board/serve.js";
import type { DebuggingReport, InvestigatorKind } from "./types.js";

const HELP = `Usage: debug-copilot [options]
       debug-copilot board [--json <path>] [--port <n>]

Investigate a bug like an engineer: collect evidence, reproduce, rank root
causes, propose a fix, run tests, and write a debugging report.

Options:
  --repo <path>           Repository to investigate (default: cwd)
  --error <text>          Error message
  --stack <text>          Stack trace (or pass via stdin)
  --log <path>            Path to a log file
  --test <path>           Failing test file or name
  --context <text>        Extra runtime context
  --apply                 Apply the generated patch
  --run-tests             Reproduce and verify with the repo's test runner (default: true)
  --no-run-tests          Skip test execution
  --max-iterations <n>    Fix/verify loops (default: 2)
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
      apply: { type: "boolean", default: false },
      "run-tests": { type: "boolean", default: true },
      "no-run-tests": { type: "boolean", default: false },
      "max-iterations": { type: "string", default: "2" },
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

  const jsonPath = values.json ?? (values.board ? "debug-report.json" : undefined);

  const report = await debugBug(
    {
      repoPath: values.repo ?? process.cwd(),
      message: values.error,
      stackTrace: values.stack ?? stdin,
      logPath: values.log,
      failingTest: values.test,
      extraContext: values.context,
    },
    {
      repoPath: values.repo ?? process.cwd(),
      apply: values.apply,
      runTests: values["no-run-tests"] ? false : values["run-tests"],
      maxIterations: Number.parseInt(values["max-iterations"] ?? "2", 10) || 2,
      investigator,
      model: values.model,
      reportPath: values.report,
      jsonReportPath: jsonPath,
      onEvent: (event) => {
        const label = event.agent ?? event.stage;
        process.stderr.write(`[${label}] ${event.message}\n`);
      },
    },
  );

  process.stderr.write(`\n${report.rootCause.investigator} · confidence ${Math.round(report.rootCause.confidence * 100)}%\n`);
  process.stderr.write(`${report.rootCause.rootCause}\n`);
  process.stderr.write(`${report.verification.summary}\n`);
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
