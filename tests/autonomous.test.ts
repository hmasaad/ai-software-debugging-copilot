import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { debugAutonomously } from "../src/autonomous/debug.js";
import { renderDebugResult } from "../src/report/result.js";
import { renderMarkdownReport } from "../src/report/markdown.js";
import type { Investigator } from "../src/types.js";
import { createCartFixture, removeFixture } from "./helpers/fixture.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => removeFixture(dir)));
});

function cartBug(dir: string) {
  return {
    repoPath: dir,
    message: "AssertionError: Expected NaN to equal 10",
    stackTrace: `AssertionError [ERR_ASSERTION]: Expected NaN to equal 10
    at TestContext.<anonymous> (${path.join(dir, "src/cart.test.js")}:6:10)
    at lineTotal (${path.join(dir, "src/cart.js")}:2:3)`,
    failingTest: "src/cart.test.js",
  };
}

function qtyInvestigator(): Investigator {
  return {
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
        rationale: "Handle missing quantity before multiplying price.",
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
}

describe("autonomous debugger", () => {
  it("validates a fix in the sandbox without promoting to the origin repo", async () => {
    const fixture = await createCartFixture();
    fixtures.push(fixture.dir);
    const originBefore = await readFile(fixture.cartPath, "utf8");

    const result = await debugAutonomously(cartBug(fixture.dir), {
      repoPath: fixture.dir,
      apply: false,
      runTests: true,
      investigator: "heuristic",
      investigatorInstance: qtyInvestigator(),
      reportPath: path.join(fixture.dir, "debug-report.md"),
    });

    expect(result.promoted).toBe(false);
    expect(result.reverted).toBe(false);
    expect(result.actions.map((action) => action.tool)).toEqual(
      expect.arrayContaining(["inspect-repo", "search-code", "inspect-git", "run-tests", "reproduce", "modify-code", "inspect-diff"]),
    );
    expect(result.report.sandbox?.kind).toBeTruthy();
    expect(result.report.validationAnalysis.resolved).toBe(true);
    expect(await readFile(fixture.cartPath, "utf8")).toBe(originBefore);
    expect(originBefore).not.toContain("item.qty ?? 1");

    const boxed = renderDebugResult(result.report);
    expect(boxed).toContain("DEBUGGING RESULT");
    expect(boxed).toContain("Root Cause:");
    expect(boxed).toContain("Evidence:");
    expect(boxed).toContain("Stack trace");
    expect(boxed).toContain("✓ Reproduced locally");
    expect(boxed).toContain("Contradicting evidence:");
    expect(boxed).toContain("Sandbox only");
    expect(boxed).toContain("Handle missing quantity");

    const markdown = renderMarkdownReport(result.report);
    expect(markdown).toContain("Autonomous sandbox");
  }, 60_000);

  it("promotes a validated sandbox patch when apply is set", async () => {
    const fixture = await createCartFixture();
    fixtures.push(fixture.dir);

    const result = await debugAutonomously(cartBug(fixture.dir), {
      repoPath: fixture.dir,
      apply: true,
      runTests: true,
      investigator: "heuristic",
      investigatorInstance: qtyInvestigator(),
    });

    expect(result.promoted).toBe(true);
    expect(result.reverted).toBe(false);
    expect(result.report.proposedFix.applied).toBe(true);
    expect(await readFile(fixture.cartPath, "utf8")).toContain("item.qty ?? 1");
    expect(renderDebugResult(result.report)).toContain("Promoted to original repo");
  }, 60_000);

  it("reverts the sandbox when validation fails and leaves origin unchanged", async () => {
    const fixture = await createCartFixture();
    fixtures.push(fixture.dir);
    const originBefore = await readFile(fixture.cartPath, "utf8");

    const investigator: Investigator = {
      name: "mock",
      analyze: qtyInvestigator().analyze,
      async proposeFix() {
        return {
          summary: "Break the total on purpose.",
          rationale: "Bad patch for revert coverage.",
          edits: [
            {
              path: "src/cart.js",
              oldString: "return item.price * item.qty;",
              newString: "return 0;",
            },
          ],
          testPlan: ["npm test"],
          risks: ["This patch is intentionally wrong."],
          applied: false,
          applyErrors: [],
        };
      },
    };

    const result = await debugAutonomously(cartBug(fixture.dir), {
      repoPath: fixture.dir,
      apply: true,
      runTests: true,
      maxIterations: 1,
      investigator: "heuristic",
      investigatorInstance: investigator,
    });

    expect(result.reverted).toBe(true);
    expect(result.promoted).toBe(false);
    expect(await readFile(fixture.cartPath, "utf8")).toBe(originBefore);
    expect(renderDebugResult(result.report)).toContain("Reverted");
  }, 60_000);
});
