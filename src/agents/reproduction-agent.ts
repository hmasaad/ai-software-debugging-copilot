import { collectTests } from "../collectors/tests.js";
import { reproduceBug, selectTestCommand } from "../analysis/reproduce.js";
import type {
  AgentRun,
  BugInput,
  ParsedError,
  ReproductionAnalysis,
  ReproductionMethod,
  StackFrame,
  TestEvidence,
} from "../types.js";
import { LogAnalyzerAgent } from "./log-analyzer.js";
import { REPRODUCTION_AGENT, type AgentContext, type SpecialistAgent } from "./types.js";

/**
 * Reproduction Agent — determines how to reproduce the issue.
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
    const tests = ctx.evidence?.tests ?? (await collectTests(ctx.input.repoPath, frames));
    const plan = planReproduction({
      failingTest: ctx.input.failingTest,
      tests,
      crashSite: logAnalysis.crashSite ?? ctx.codeInvestigation?.origin,
      error: logAnalysis.error,
      introducing: ctx.gitInvestigation?.introducing,
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
    const result = await reproduceBug(ctx.input, { ...evidence, tests }, shouldRun, plan.command);
    const summary = buildReproSummary(plan, result);
    const handoff = buildReproHandoff(plan, result, logAnalysis.error);

    return {
      result,
      method: plan.method,
      command: result.command ?? plan.command,
      runner: tests.runner,
      relatedTests: tests.relatedTests,
      steps: plan.steps,
      summary,
      handoff,
    };
  }
}

export function classifyReproductionMethod(input: Pick<BugInput, "failingTest">, tests: TestEvidence): ReproductionMethod {
  if (input.failingTest) return "failing-test";
  const related = tests.relatedTests[0]?.file;
  if (related && (tests.runner === "vitest" || tests.runner === "jest")) return "related-test";
  if (tests.testCommand) return "test-suite";
  return "error-as-repro";
}

export function planReproduction(input: {
  failingTest?: string;
  tests: TestEvidence;
  crashSite?: StackFrame;
  error?: ParsedError;
  introducing?: { sha: string; subject: string };
}): { method: ReproductionMethod; command?: string; steps: string[] } {
  const method = classifyReproductionMethod({ failingTest: input.failingTest }, input.tests);
  const command = selectTestCommand({ failingTest: input.failingTest }, input.tests);
  const steps: string[] = [];

  if (command) steps.push(`Run \`${command}\`.`);
  else steps.push("Replay the failing request or command that produced the stack trace.");

  if (input.failingTest) steps.push(`Focus on failing test \`${input.failingTest}\`.`);
  for (const test of input.tests.relatedTests.slice(0, 3)) {
    steps.push(`Related test \`${test.file}\` — ${test.reason}.`);
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

function buildReproSummary(
  plan: { method: ReproductionMethod; command?: string; steps: string[] },
  result: ReproductionAnalysis["result"],
): string {
  const via = plan.command ? ` via \`${plan.command}\`` : "";
  if (result.attempted && result.reproduced) return `Issue reproduced${via} (${plan.method}).`;
  if (result.attempted && !result.reproduced) {
    return `Could not reproduce${via}; the failure may be environmental or already fixed.`;
  }
  if (plan.method === "error-as-repro") {
    return "No test runner detected; treat the provided stack/error as the reproduction.";
  }
  return `Reproduction planned (${plan.method})${via} but not executed.`;
}

function buildReproHandoff(
  plan: { method: ReproductionMethod; steps: string[] },
  result: ReproductionAnalysis["result"],
  error: ParsedError,
): string[] {
  const notes: string[] = [];
  if (result.attempted && result.reproduced) {
    notes.push(`Failure is live: ${result.summary}`);
  } else if (result.attempted && !result.reproduced) {
    notes.push("Local tests passed — prefer environment/data/race hypotheses over a source-level patch.");
  } else {
    notes.push(plan.steps[0] ?? "Replay the original failing command.");
  }
  if (error.type) notes.push(`Match the original ${error.type} when judging a successful repro.`);
  return notes;
}
