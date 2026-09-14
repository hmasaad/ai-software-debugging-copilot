import { afterEach, describe, expect, it } from "vitest";
import { FixAgent, proposeMinimalEdit } from "../src/agents/fix-agent.js";
import { FIX_AGENT } from "../src/agents/types.js";
import { CodeInvestigatorAgent } from "../src/agents/code-investigator.js";
import { createCartFixture, removeFixture } from "./helpers/fixture.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => removeFixture(dir)));
});

describe("Fix Agent", () => {
  it("exposes the core-agent contract", () => {
    const agent = new FixAgent();
    expect(agent.id).toBe("fix-agent");
    expect(agent.name).toBe(FIX_AGENT.name);
    expect(agent.responsibility).toBe("Generate a minimal code fix");
  });

  it("inserts optional chaining on the undefined property", () => {
    const edit = proposeMinimalEdit({
      file: "src/cart.js",
      fileContent: "export function getPrimaryItemId(order) {\n  return order.item.id;\n}\n",
      expression: "return order.item.id;",
      message: "Cannot read properties of undefined (reading 'id')",
    });
    expect(edit).toEqual({
      path: "src/cart.js",
      oldString: "return order.item.id;",
      newString: "return order.item?.id;",
    });
  });

  it("defaults a missing qty used in a multiply", () => {
    const edit = proposeMinimalEdit({
      file: "src/cart.js",
      fileContent: "return item.price * item.qty;\n",
      expression: "return item.price * item.qty;",
      message: "Expected NaN to equal 10",
    });
    expect(edit?.newString).toBe("return item.price * (item.qty ?? 1);");
  });

  it("removes a Dart null-check bang on a null value", () => {
    const edit = proposeMinimalEdit({
      file: "lib/savings/savings_bloc.dart",
      fileContent: "dynamic load() {\n  return response.data!;\n}\n",
      expression: "return response.data!;",
      message: "Null check operator used on a null value",
    });
    expect(edit).toEqual({
      path: "lib/savings/savings_bloc.dart",
      oldString: "return response.data!;",
      newString: "return response.data;",
    });
  });

  it("skips application patches for a dependency root cause", async () => {
    const agent = new FixAgent();
    const { result } = await agent.run({
      input: { repoPath: process.cwd(), message: "Cannot find module 'left-pad'" },
      causeAnalysis: {
        causes: [],
        leading: {
          id: "H1",
          kind: "dependency",
          description: "missing module",
          evidence: [],
          likelihood: 0.9,
        },
        confidence: 0.9,
        affectedFiles: [],
        summary: "dependency",
        handoff: [],
      },
      dependencyAnalysis: {
        evidence: { hits: [] },
        issues: [{ kind: "missing-module", package: "left-pad", detail: "missing", likelihood: 0.88 }],
        likelyDependencyBug: true,
        summary: "missing left-pad",
        handoff: [],
      },
    });
    expect(result.strategy).toBe("dependency-install");
    expect(result.proposal.edits).toEqual([]);
  });

  it("produces an optional-chain edit for the cart crash site", async () => {
    const fixture = await createCartFixture();
    fixtures.push(fixture.dir);

    const code = new CodeInvestigatorAgent();
    const { result: codeInvestigation } = await code.run({
      input: {
        repoPath: fixture.dir,
        stackTrace: `TypeError: Cannot read properties of undefined (reading 'id')
    at getPrimaryItemId (${fixture.dir}/src/cart.js:10:21)`,
      },
    });

    const agent = new FixAgent();
    const { result, run } = await agent.run({
      input: {
        repoPath: fixture.dir,
        stackTrace: `TypeError: Cannot read properties of undefined (reading 'id')
    at getPrimaryItemId (${fixture.dir}/src/cart.js:10:21)`,
      },
      codeInvestigation,
      logAnalysis: {
        error: {
          type: "TypeError",
          message: "Cannot read properties of undefined (reading 'id')",
          frames: [],
        },
        logs: { sources: [], excerpt: "" },
        exceptionChain: [],
        logLevels: { fatal: 0, error: 1, warn: 0, info: 0, debug: 0 },
        timestamps: [],
        correlationIds: [],
        repeating: [],
        summary: "TypeError",
        handoff: [],
      },
    });

    expect(run.status).toBe("ok");
    expect(result.proposal.edits[0]?.newString).toContain("item?.id");
    expect(result.strategy).toBe("optional-chain");
    expect(result.risk?.level).toBe("LOW");
    expect(result.risk?.files).toBe(1);
    expect(result.risk?.modules).toBe(1);
    expect(result.risk?.preferred).toBe(true);
  });
});
