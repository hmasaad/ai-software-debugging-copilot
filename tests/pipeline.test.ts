import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectEvidence } from "../src/collectors/index.js";
import { debugBug } from "../src/pipeline.js";
import { renderMarkdownReport } from "../src/report/markdown.js";
import type { Investigator } from "../src/types.js";
import { createCartFixture, removeFixture } from "./helpers/fixture.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => removeFixture(dir)));
});

describe("collectEvidence", () => {
  it("pulls source, git, tests, and runtime around a stack frame", async () => {
    const fixture = await createCartFixture();
    fixtures.push(fixture.dir);

    const evidence = await collectEvidence({
      repoPath: fixture.dir,
      stackTrace: `TypeError: Cannot read properties of undefined (reading 'qty')
    at lineTotal (${path.join(fixture.dir, "src/cart.js")}:2:24)
    at cartTotal (${path.join(fixture.dir, "src/cart.js")}:6:42)`,
    });

    expect(evidence.error.type).toBe("TypeError");
    expect(evidence.sourceSnippets.some((snippet) => snippet.file.endsWith("src/cart.js"))).toBe(true);
    expect(evidence.git.available).toBe(true);
    expect(evidence.git.recentCommits.length).toBeGreaterThan(0);
    expect(evidence.tests.runner).toBe("npm-test");
    expect(evidence.tests.relatedTests.some((test) => test.file.includes("cart.test.js"))).toBe(true);
    expect(evidence.runtime.node).toMatch(/^v/);
  });
});

describe("debugBug pipeline", () => {
  it("reproduces, applies a fix, and verifies tests pass", async () => {
    const fixture = await createCartFixture();
    fixtures.push(fixture.dir);

    const investigator: Investigator = {
      name: "mock",
      async analyze() {
        return {
          summary: "Missing quantity defaults to undefined and poisons the total.",
          rootCause: "lineTotal multiplies by item.qty with no default, so omitted qty becomes NaN.",
          confidence: 0.91,
          hypotheses: [
            {
              id: "H1",
              description: "qty is optional but used as a required number",
              evidence: ["src/cart.js:2", "failing test defaults missing quantity to 1"],
              likelihood: 0.91,
            },
          ],
          affectedFiles: ["src/cart.js"],
          reproSteps: ["Run npm test"],
          investigator: "mock",
        };
      },
      async proposeFix() {
        return {
          summary: "Default missing qty to 1.",
          rationale: "Treat omitted quantity as a single unit.",
          edits: [
            {
              path: "src/cart.js",
              oldString: "return item.price * item.qty;",
              newString: "return item.price * (item.qty ?? 1);",
            },
          ],
          testPlan: ["npm test"],
          risks: [],
          applied: false,
          applyErrors: [],
        };
      },
    };

    const report = await debugBug(
      {
        repoPath: fixture.dir,
        message: "AssertionError: Expected NaN to equal 10",
        stackTrace: `AssertionError [ERR_ASSERTION]: Expected NaN to equal 10
    at TestContext.<anonymous> (${path.join(fixture.dir, "src/cart.test.js")}:6:10)
    at lineTotal (${path.join(fixture.dir, "src/cart.js")}:2:3)`,
        failingTest: "src/cart.test.js",
      },
      {
        repoPath: fixture.dir,
        apply: true,
        runTests: true,
        investigator: "heuristic",
        investigatorInstance: investigator,
        reportPath: path.join(fixture.dir, "debug-report.md"),
        jsonReportPath: path.join(fixture.dir, "debug-report.json"),
      },
    );

    expect(report.reproduction.reproduced).toBe(true);
    expect(report.agentRuns[0]?.id).toBe("log-analyzer");
    expect(report.agentRuns.some((run) => run.id === "classifier")).toBe(true);
    expect(report.agentRuns.some((run) => run.id === "code-investigator")).toBe(true);
    expect(report.agentRuns.some((run) => run.id === "git-investigator")).toBe(true);
    expect(report.agentRuns.some((run) => run.id === "dependency-analyst")).toBe(true);
    expect(report.agentRuns.some((run) => run.id === "reproduction-agent")).toBe(true);
    expect(report.agentRuns.some((run) => run.id === "root-cause-agent")).toBe(true);
    expect(report.agentRuns.some((run) => run.id === "fix-agent")).toBe(true);
    expect(report.agentRuns.some((run) => run.id === "test-agent")).toBe(true);
    expect(report.agentRuns.some((run) => run.id === "validation-agent")).toBe(true);
    expect(report.agentRuns.some((run) => run.id === "incident-agent")).toBe(true);
    expect(report.validationAnalysis.resolved).toBe(true);
    expect(report.incidentReport.body).toContain("### What happened");
    expect(report.logAnalysis.summary).toBeTruthy();
    expect(report.codeInvestigation.trace.length).toBeGreaterThan(0);
    expect(report.gitInvestigation.evidence.available).toBe(true);
    expect(report.dependencyAnalysis.likelyDependencyBug).toBe(false);
    expect(report.reproductionAnalysis.result.reproduced).toBe(true);
    expect(report.causeAnalysis.causes.length).toBeGreaterThan(0);
    expect(report.proposedFix.applied).toBe(true);
    expect(report.fixAnalysis?.risk?.level).toBe("LOW");
    expect(report.rollbackIntelligence?.canSafelyPatch).toBe(true);
    expect(report.rollbackIntelligence?.action).toBe("patch");
    expect(report.incidentResponse?.path).toBe("fix");
    expect(report.incidentResponse?.stage).toBe("RESOLVED");
    expect(report.incidentResponse?.waiting).toEqual([]);
    expect(report.knowledgeGraph?.nodes.map((node) => node.label)).toEqual([
      "Incident",
      "Root Cause",
      "Commit",
      "Fix",
      "Affected Components",
      "Resolution",
    ]);
    expect(report.verification.passed).toBe(true);
    expect(report.classification?.category).toBeTruthy();
    expect(report.iterations[0]?.summary).toMatch(/Attempt 1 → Tests passed/);
    expect(report.blastRadius?.origin).toBeTruthy();
    expect(await readFile(path.join(fixture.dir, "src/cart.js"), "utf8")).toContain("item.qty ?? 1");

    const markdown = renderMarkdownReport(report);
    expect(markdown).toContain("Root cause analysis");
    expect(markdown).toContain("Git Investigator");
    expect(markdown).toContain("Dependency Analyst");
    expect(markdown).toContain("Reproduction Agent");
    expect(markdown).toContain("Root Cause Agent");
    expect(markdown).toContain("Fix Agent");
    expect(markdown).toContain("Test Agent");
    expect(markdown).toContain("Validation Agent");
    expect(markdown).toContain("Incident Agent");
    expect(markdown).toContain("Specialized agents");
    expect(markdown).toContain("Failure classification");
    expect(markdown).toContain("Patch → test → verify");
    expect(markdown).toContain("Proposed fix");
    expect(markdown).toContain("Verification");
    expect(markdown).toContain("Risk: LOW");
    expect(markdown).toContain("Read logs                 AUTO");
    expect(markdown).toContain("Deploy                    APPROVAL");
    expect(markdown).toContain("Debugging knowledge graph");
    expect(markdown).toContain("Incident");
    expect(markdown).toContain("Affected Components");
    expect(await readFile(path.join(fixture.dir, "debug-report.md"), "utf8")).toContain("Debugging report");
  });

  it("does not apply a HIGH-risk multi-module patch even with --apply", async () => {
    const fixture = await createCartFixture();
    fixtures.push(fixture.dir);

    await writeFile(
      path.join(fixture.dir, "src/pay.js"),
      `export function charge() {
  throw new Error("declined");
}
`,
    );

    const wideFiles = [
      "lib/savings/a.js",
      "lib/savings/b.js",
      "lib/reports/c.js",
      "lib/reports/d.js",
      "lib/shareout/e.js",
      "lib/shareout/f.js",
      "lib/media/g.js",
    ];
    for (const file of wideFiles) {
      await mkdir(path.join(fixture.dir, path.dirname(file)), { recursive: true });
      await writeFile(path.join(fixture.dir, file), "export const x = 1;\n");
    }

    const investigator: Investigator = {
      name: "mock",
      async analyze() {
        return {
          summary: "Payment charge always throws.",
          rootCause: "charge() throws declined without a recovery path.",
          confidence: 0.72,
          hypotheses: [
            {
              id: "H1",
              description: "Uncaught payment decline",
              evidence: ["src/pay.js"],
              likelihood: 0.72,
            },
          ],
          affectedFiles: ["src/pay.js", ...wideFiles],
          reproSteps: ["Run the pay path"],
          investigator: "mock",
        };
      },
      async proposeFix() {
        return {
          summary: "Rewrite several modules around the payment decline.",
          rationale: "Broad refactor across savings, reports, shareout, and media.",
          edits: wideFiles.map((file) => ({
            path: file,
            oldString: "export const x = 1;",
            newString: "export const x = 2;",
          })),
          testPlan: ["npm test"],
          risks: [],
          applied: false,
          applyErrors: [],
        };
      },
    };

    const report = await debugBug(
      {
        repoPath: fixture.dir,
        message: "Error: declined",
        stackTrace: `Error: declined
    at charge (${path.join(fixture.dir, "src/pay.js")}:2:9)`,
      },
      {
        repoPath: fixture.dir,
        apply: true,
        runTests: false,
        investigator: "heuristic",
        investigatorInstance: investigator,
      },
    );

    expect(report.fixAnalysis?.risk?.level).toBe("HIGH");
    expect(report.fixAnalysis?.risk?.files).toBe(7);
    expect(report.fixAnalysis?.risk?.modules).toBe(4);
    expect(report.proposedFix.applied).toBe(false);
    expect(report.proposedFix.applyErrors.some((error) => /HIGH risk/i.test(error))).toBe(true);
    expect(report.rollbackIntelligence?.canSafelyPatch).toBe(false);
    expect(report.rollbackIntelligence?.action).not.toBe("patch");
    expect(await readFile(path.join(fixture.dir, "lib/savings/a.js"), "utf8")).toBe("export const x = 1;\n");
  });
});
