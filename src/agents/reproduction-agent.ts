import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectTests } from "../collectors/tests.js";
import { reproduceBug, selectTestCommand } from "../analysis/reproduce.js";
import {
  buildScenario,
  captureFailure,
  compareFailures,
  proposeReproductionTest,
  understandSymptoms,
} from "../analysis/repro-scenario.js";
import { tryCommand } from "../exec.js";
import type {
  AgentRun,
  BugInput,
  ParsedError,
  ProposedTest,
  ReproductionAnalysis,
  ReproductionMethod,
  StackFrame,
  TestEvidence,
} from "../types.js";
import { LogAnalyzerAgent } from "./log-analyzer.js";
import { REPRODUCTION_AGENT, type AgentContext, type SpecialistAgent } from "./types.js";

/**
 * Reproduction Agent — does not stop at the stack trace.
 * Understands symptoms, builds a scenario, runs tests (or generates a
 * regression), captures the failure, and compares it to the report.
 */
export class ReproductionAgent implements SpecialistAgent<ReproductionAnalysis> {
  readonly id = REPRODUCTION_AGENT.id;
  readonly name = REPRODUCTION_AGENT.name;
  readonly responsibility = REPRODUCTION_AGENT.responsibility;

  async run(ctx: AgentContext): Promise<{ result: ReproductionAnalysis; run: AgentRun }> {
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

  async analyze(ctx: AgentContext): Promise<ReproductionAnalysis> {
    const logAnalysis = ctx.logAnalysis ?? (await new LogAnalyzerAgent().analyze(ctx.input));
    const frames = logAnalysis.error.frames;
    const crashSite = logAnalysis.crashSite ?? ctx.codeInvestigation?.origin;
    const tests = ctx.evidence?.tests ?? (await collectTests(ctx.input.repoPath, frames));
    const symptoms = understandSymptoms({
      error: logAnalysis.error,
      crashSite,
      extraContext: ctx.input.extraContext,
      message: ctx.input.message,
    });

    const generated =
      shouldProposeGeneratedTest(logAnalysis.error, crashSite, ctx.input.failingTest, tests)
        ? proposeReproductionTest({
            repoPath: ctx.input.repoPath,
            error: logAnalysis.error,
            crashSite,
            symptoms,
            tests,
          })
        : undefined;

    const plan = planReproduction({
      failingTest: ctx.input.failingTest,
      tests,
      crashSite,
      error: logAnalysis.error,
      introducing: ctx.gitInvestigation?.introducing,
      generatedTest: generated,
    });

    const evidence = ctx.evidence ?? {
      collectedAt: new Date().toISOString(),
      repoPath: ctx.input.repoPath,
      error: logAnalysis.error,
      logs: logAnalysis.logs,
      sourceSnippets: ctx.codeInvestigation?.snippets ?? [],
      git: ctx.gitInvestigation?.evidence ?? {
        available: false,
        recentCommits: [],
        commitsTouchingSuspects: [],
        blame: [],
      },
      pullRequests: ctx.gitInvestigation?.pullRequests ?? [],
      tests,
      dependencies: ctx.dependencyAnalysis?.evidence ?? { hits: [] },
      runtime: {
        os: process.platform,
        arch: process.arch,
        cwd: ctx.input.repoPath,
        ci: false,
        envHints: [],
      },
    };

    const shouldRun = ctx.runTests === true || (ctx.runTests !== false && Boolean(ctx.evidence));
    let generatedTest = generated;
    let command = plan.command;
    let wrote: string | undefined;
    let execute = shouldRun;

    try {
      if (generated && plan.method === "generated-test") {
        const executable = await generatedTestIsRunnable(generated.path, tests.runner);
        if (shouldRun && executable) {
          const written = await writeGeneratedTest(ctx.input.repoPath, generated);
          if (written) {
            wrote = written;
            generatedTest = { ...generated, created: true };
            command = commandForGeneratedTest(tests.runner, generated.path) ?? command;
          }
        } else if (!executable) {
          plan.steps.push("Test SDK not on PATH; generated the regression test without executing it.");
          execute = shouldRun && Boolean(plan.command && plan.method !== "generated-test");
        }
      }

      const result = await reproduceBug(ctx.input, { ...evidence, tests }, execute, command);
      const captured = result.attempted ? captureFailure(result.output, ctx.input.repoPath) : undefined;
      const compared = compareFailures({
        reported: logAnalysis.error,
        crashSite,
        captured,
        output: result.output,
        attempted: result.attempted,
        reproduced: result.reproduced,
      });
      const scenario = buildScenario({
        symptoms,
        crashSite,
        method: plan.method,
        command: result.command ?? command,
        generatedTest,
      });
      const steps = buildFlowSteps(symptoms, scenario, plan.steps, compared.match);
      const summary = buildReproSummary(plan, result, compared.match, generatedTest);
      const handoff = buildReproHandoff(plan, result, logAnalysis.error, compared, generatedTest);
      const confidence =
        compared.match === "matched"
          ? Math.max(compared.confidence, 0.9)
          : generatedTest && compared.match === "not-run"
            ? 0.55
            : compared.confidence;

      return {
        result,
        method: plan.method,
        command: result.command ?? command,
        runner: tests.runner,
        relatedTests: tests.relatedTests,
        steps,
        symptoms,
        scenario,
        generatedTest,
        capturedFailure: captured,
        match: compared.match,
        matchDetail: compared.detail,
        confidence,
        summary,
        handoff,
      };
    } finally {
      if (wrote && !ctx.apply) {
        await unlink(wrote).catch(() => undefined);
        if (generatedTest) generatedTest.created = false;
      }
    }
  }
}

export function classifyReproductionMethod(
  input: Pick<BugInput, "failingTest">,
  tests: TestEvidence,
  generated = false,
): ReproductionMethod {
  if (input.failingTest) return "failing-test";
  const related = tests.relatedTests[0]?.file;
  if (related && (tests.runner === "vitest" || tests.runner === "jest" || tests.runner === "flutter-test")) {
    return "related-test";
  }
  if (!related && generated) return "generated-test";
  if (tests.testCommand) return "test-suite";
  if (generated) return "generated-test";
  return "error-as-repro";
}

export function planReproduction(input: {
  failingTest?: string;
  tests: TestEvidence;
  crashSite?: StackFrame;
  error?: ParsedError;
  introducing?: { sha: string; subject: string };
  generatedTest?: ProposedTest;
}): { method: ReproductionMethod; command?: string; steps: string[] } {
  const method = classifyReproductionMethod({ failingTest: input.failingTest }, input.tests, Boolean(input.generatedTest));
  let command = selectTestCommand({ failingTest: input.failingTest }, input.tests);
  if (method === "generated-test" && input.generatedTest) {
    command = commandForGeneratedTest(input.tests.runner, input.generatedTest.path) ?? command;
  }
  const steps: string[] = [];

  if (command) steps.push(`Run \`${command}\`.`);
  else steps.push("Replay the failing request or command that produced the stack trace.");

  if (input.failingTest) steps.push(`Focus on failing test \`${input.failingTest}\`.`);
  for (const test of input.tests.relatedTests.slice(0, 3)) {
    steps.push(`Related test \`${test.file}\` — ${test.reason}.`);
  }
  if (input.generatedTest) {
    steps.push(`Generated repro test \`${input.generatedTest.path}\`.`);
  }
  if (input.crashSite) {
    const loc = `${input.crashSite.file}${input.crashSite.line ? `:${input.crashSite.line}` : ""}`;
    const fn = input.crashSite.functionName ? ` in ${input.crashSite.functionName}` : "";
    steps.push(`Confirm the crash at \`${loc}\`${fn}.`);
  }
  if (input.error?.message) {
    steps.push(`Expect ${input.error.type ?? "Error"}: ${input.error.message.replace(/\s+/g, " ").trim()}.`);
  }
  if (input.introducing) {
    steps.push(`Optional: inspect introducing commit ${input.introducing.sha.slice(0, 8)} — ${input.introducing.subject}.`);
  }

  return { method, command, steps };
}

function buildFlowSteps(
  symptoms: ReproductionAnalysis["symptoms"],
  scenario: ReproductionAnalysis["scenario"],
  planned: string[],
  match: ReproductionAnalysis["match"],
): string[] {
  return [
    `Understand symptoms: ${symptoms.summary}`,
    `Create scenario: ${scenario.title}`,
    ...planned,
    "Capture the live failure output.",
    `Compare with the reported failure — ${match}.`,
  ];
}

function buildReproSummary(
  plan: { method: ReproductionMethod; command?: string },
  result: ReproductionAnalysis["result"],
  match: ReproductionAnalysis["match"],
  generated?: ProposedTest,
): string {
  const via = plan.command ? ` via \`${plan.command}\`` : "";
  const gen = generated ? ` Generated \`${generated.path}\`.` : "";
  if (result.attempted && result.reproduced && match === "matched") {
    return `Issue reproduced${via} and matches the report (${plan.method}).${gen}`;
  }
  if (result.attempted && result.reproduced) {
    return `A failure reproduced${via}, but it only partly matches the report (${plan.method}).${gen}`;
  }
  if (result.attempted && !result.reproduced) {
    return `Could not reproduce${via}; the failure may be environmental or already fixed.`;
  }
  if (plan.method === "generated-test") {
    return `Generated a reproduction test${generated ? ` at \`${generated.path}\`` : ""} but did not execute it.`;
  }
  if (plan.method === "error-as-repro") {
    return "No test runner detected; treat the provided stack/error as the reproduction.";
  }
  return `Reproduction planned (${plan.method})${via} but not executed.${gen}`;
}

function buildReproHandoff(
  plan: { method: ReproductionMethod; steps: string[] },
  result: ReproductionAnalysis["result"],
  error: ParsedError,
  compared: { match: ReproductionAnalysis["match"]; detail: string },
  generated?: ProposedTest,
): string[] {
  const notes: string[] = [];
  if (result.attempted && result.reproduced && compared.match === "matched") {
    notes.push(`Failure is live and matches the report: ${compared.detail}`);
  } else if (result.attempted && result.reproduced) {
    notes.push(compared.detail);
  } else if (result.attempted && !result.reproduced) {
    notes.push("Local tests passed — prefer environment/data/race hypotheses over a source-level patch.");
  } else {
    notes.push(plan.steps[0] ?? "Replay the original failing command.");
  }
  if (error.type) notes.push(`Match the original ${error.type} when judging a successful repro.`);
  if (generated) {
    notes.push(
      `${generated.created ? "Wrote" : "Proposed"} regression \`${generated.path}\` so later agents can re-run the same scenario.`,
    );
  }
  notes.push(`Reproduction confidence ${Math.round((compared.match === "matched" ? 0.92 : compared.match === "partial" ? 0.68 : 0.4) * 100)}%.`);
  return notes;
}

async function writeGeneratedTest(repoPath: string, test: ProposedTest): Promise<string | undefined> {
  const abs = path.resolve(repoPath, test.path);
  if (!abs.startsWith(path.resolve(repoPath))) return undefined;
  if (existsSync(abs)) return undefined;
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, test.content, "utf8");
  return abs;
}

function commandForGeneratedTest(runner: string | undefined, testPath: string): string | undefined {
  if (runner === "flutter-test") return `flutter test ${quote(testPath)}`;
  if (testPath.endsWith(".dart")) return `dart test ${quote(testPath)}`;
  if (testPath.endsWith(".py")) return `pytest -q ${quote(testPath)}`;
  return `node --test ${quote(testPath)}`;
}

async function generatedTestIsRunnable(testPath: string, runner?: string): Promise<boolean> {
  if (testPath.endsWith(".dart") || runner === "flutter-test") {
    return (await commandExists("flutter")) || (await commandExists("dart"));
  }
  return true;
}

async function commandExists(bin: string): Promise<boolean> {
  const result = await tryCommand(bin, ["--version"], { timeoutMs: 8_000 });
  return Boolean(result && result.code === 0);
}

function quote(file: string): string {
  return file.includes(" ") ? `"${file}"` : file;
}

function shouldProposeGeneratedTest(
  error: ParsedError,
  crashSite: StackFrame | undefined,
  failingTest: string | undefined,
  tests: TestEvidence,
): boolean {
  const dart = error.language === "dart" || Boolean(crashSite?.file?.endsWith(".dart"));
  if (dart) return true;
  if (failingTest || tests.relatedTests.length > 0) return false;
  return Boolean(crashSite?.file);
}
