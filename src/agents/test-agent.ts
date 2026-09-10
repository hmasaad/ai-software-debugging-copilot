import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { verifyFix } from "../analysis/verify.js";
import type {
  AgentRun,
  CodeInvestigation,
  LogAnalysis,
  ProposedTest,
  RelatedTest,
  TestAnalysis,
  TestEvidence,
} from "../types.js";
import { proposeReproductionTest, understandSymptoms } from "../analysis/repro-scenario.js";
import { TEST_AGENT, type AgentContext, type SpecialistAgent } from "./types.js";

/**
 * Test Agent — creates and/or runs tests against the proposed fix.
 */
export class TestAgent implements SpecialistAgent<TestAnalysis> {
  readonly id = TEST_AGENT.id;
  readonly name = TEST_AGENT.name;
  readonly responsibility = TEST_AGENT.responsibility;

  async run(ctx: AgentContext): Promise<{ result: TestAnalysis; run: AgentRun }> {
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

  async analyze(ctx: AgentContext): Promise<TestAnalysis> {
    const tests = ctx.evidence?.tests ?? { relatedTests: [] };
    const relatedTests = tests.relatedTests;
    const proposedTest =
      ctx.reproduction?.generatedTest ??
      proposeRegressionTest({
        repoPath: ctx.input.repoPath,
        tests,
        logAnalysis: ctx.logAnalysis,
        codeInvestigation: ctx.codeInvestigation,
      });

    const createdFiles: string[] = [];
    let created = proposedTest;
    const shouldCreate = Boolean(ctx.apply && proposedTest && !proposedTest.created && relatedTests.length === 0);
    if (shouldCreate && proposedTest) {
      const abs = path.resolve(ctx.input.repoPath, proposedTest.path);
      if (abs.startsWith(path.resolve(ctx.input.repoPath)) && !existsSync(abs)) {
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, proposedTest.content, "utf8");
        createdFiles.push(abs);
        created = { ...proposedTest, created: true };
      }
    }

    const applied = Boolean(ctx.apply);
    const runTests = ctx.runTests !== false;
    const command = ctx.reproduction?.command ?? ctx.reproduction?.result.command ?? tests.testCommand;

    let verification = await verifyFix(ctx.input.repoPath, ctx.evidence ?? emptyEvidence(ctx, tests), applied && runTests, command);
    if (!ctx.apply) {
      verification = {
        testsRan: false,
        passed: false,
        command,
        output: "",
        summary: "Patch not applied; verification skipped. Re-run with --apply to write the fix and run tests.",
      };
    }

    if (createdFiles.length && verification.testsRan && !verification.passed) {
      await Promise.all(createdFiles.map((file) => unlink(file).catch(() => undefined)));
      createdFiles.length = 0;
      if (created) created = { ...created, created: false };
    }

    return {
      verification,
      relatedTests,
      proposedTest: created,
      createdFiles,
      summary: buildTestSummary(verification, created, relatedTests),
      handoff: buildTestHandoff(verification, created, ctx.fixAnalysis?.proposal.edits.length ?? 0),
    };
  }
}

export function proposeRegressionTest(input: {
  repoPath?: string;
  tests: TestEvidence;
  logAnalysis?: LogAnalysis;
  codeInvestigation?: CodeInvestigation;
}): ProposedTest | undefined {
  const origin = input.codeInvestigation?.origin ?? input.logAnalysis?.crashSite;
  const fn = origin?.functionName?.replace(/[^A-Za-z0-9_$]/g, "") || "repro";
  if (!origin?.file) return undefined;

  const dart = origin.file.endsWith(".dart") || input.logAnalysis?.error.language === "dart";
  if (dart) {
    return proposeReproductionTest({
      repoPath: input.repoPath,
      error: input.logAnalysis?.error ?? { message: "Unknown error", frames: [origin], language: "dart" },
      crashSite: origin,
      symptoms: understandSymptoms({
        error: input.logAnalysis?.error ?? { message: "Unknown error", frames: [origin], language: "dart" },
        crashSite: origin,
      }),
      tests: input.tests,
    });
  }

  let sourceRel = origin.file.replace(/\\/g, "/");
  if (input.repoPath && path.isAbsolute(origin.file)) {
    sourceRel = path.relative(input.repoPath, origin.file).replace(/\\/g, "/");
  }
  if (!sourceRel || sourceRel.startsWith("..")) return undefined;
  const parsed = path.parse(sourceRel);
  const relDir = parsed.dir.replace(/\\/g, "/");
  const importPath = `./${parsed.name}${parsed.ext}`;
  const testPath = path.posix.join(relDir || ".", `${parsed.name}.regression.test${parsed.ext || ".js"}`);

  if (input.tests.relatedTests.some((test) => test.file.replace(/\\/g, "/") === testPath)) {
    return undefined;
  }

  const content = `import assert from "node:assert/strict";
import { test } from "node:test";
import { ${fn} } from "${importPath}";

test("regression: ${fn} does not throw on empty input", () => {
  assert.doesNotThrow(() => ${fn}({}));
});
`;

  const reason = input.tests.relatedTests.length
    ? `Extend coverage for ${fn} at ${sourceRel}${origin.line ? `:${origin.line}` : ""}.`
    : `No related tests for ${sourceRel}; add a regression around ${fn}.`;

  return { path: testPath, content, reason, created: false };
}

function buildTestSummary(
  verification: TestAnalysis["verification"],
  proposed: ProposedTest | undefined,
  related: RelatedTest[],
): string {
  if (verification.testsRan && verification.passed) {
    return `Tests passed${verification.command ? ` via \`${verification.command}\`` : ""}.`;
  }
  if (verification.testsRan && !verification.passed) {
    return `Tests failed${verification.command ? ` via \`${verification.command}\`` : ""}; the patch needs another pass.`;
  }
  if (proposed && !proposed.created) {
    return `Proposed regression test \`${proposed.path}\`${related.length ? " (not written; existing tests cover the area)" : " (not written; re-run with --apply)"}.`;
  }
  return verification.summary;
}

function buildTestHandoff(
  verification: TestAnalysis["verification"],
  proposed: ProposedTest | undefined,
  editCount: number,
): string[] {
  const notes: string[] = [];
  if (verification.testsRan && verification.passed) {
    notes.push("Fix is verified; safe to keep the working-tree edits.");
  } else if (verification.testsRan && !verification.passed) {
    notes.push("Restore the patch and iterate; tests still fail.");
  } else if (!editCount) {
    notes.push("No patch to verify yet.");
  } else {
    notes.push("Apply the patch, then re-run Test Agent.");
  }
  if (proposed) notes.push(`${proposed.created ? "Created" : "Consider"} \`${proposed.path}\`: ${proposed.reason}`);
  return notes;
}

function emptyEvidence(ctx: AgentContext, tests: TestEvidence): NonNullable<AgentContext["evidence"]> {
  return {
    collectedAt: new Date().toISOString(),
    repoPath: ctx.input.repoPath,
    error: ctx.logAnalysis?.error ?? { message: "Unknown error", frames: [] },
    logs: { sources: [], excerpt: "" },
    sourceSnippets: [],
    git: { available: false, recentCommits: [], commitsTouchingSuspects: [], blame: [] },
    pullRequests: [],
    tests,
    dependencies: { hits: [] },
    runtime: { os: process.platform, arch: process.arch, cwd: ctx.input.repoPath, ci: false, envHints: [] },
  };
}
