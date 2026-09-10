import { afterEach, describe, expect, it } from "vitest";
import {
  compareFailures,
  proposeReproductionTest,
  understandSymptoms,
} from "../src/analysis/repro-scenario.js";
import {
  classifyReproductionMethod,
  planReproduction,
  ReproductionAgent,
} from "../src/agents/reproduction-agent.js";
import { REPRODUCTION_AGENT } from "../src/agents/types.js";
import { createCartFixture, removeFixture } from "./helpers/fixture.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => removeFixture(dir)));
});

describe("Reproduction Agent", () => {
  it("exposes the core-agent contract", () => {
    const agent = new ReproductionAgent();
    expect(agent.id).toBe("reproduction-agent");
    expect(agent.name).toBe(REPRODUCTION_AGENT.name);
    expect(agent.responsibility).toBe("Reproduce the issue and match it against the reported failure");
  });

  it("plans a failing-test command and crash-site steps", () => {
    expect(
      classifyReproductionMethod(
        { failingTest: "src/cart.test.js" },
        { runner: "vitest", testCommand: "npx vitest run", relatedTests: [] },
      ),
    ).toBe("failing-test");

    const plan = planReproduction({
      failingTest: "src/cart.test.js",
      tests: {
        runner: "npm-test",
        testCommand: "npm test --silent",
        relatedTests: [{ file: "src/cart.test.js", reason: "name-match for src/cart.js" }],
      },
      crashSite: { file: "src/cart.js", line: 2, functionName: "lineTotal", raw: "at lineTotal", inProject: true },
      error: { type: "AssertionError", message: "Expected NaN to equal 10", frames: [] },
    });

    expect(plan.method).toBe("failing-test");
    expect(plan.command).toBe("npm test --silent");
    expect(plan.steps.some((step) => step.includes("npm test --silent"))).toBe(true);
    expect(plan.steps.some((step) => step.includes("src/cart.js:2"))).toBe(true);
    expect(plan.steps.some((step) => step.includes("Expected NaN to equal 10"))).toBe(true);
  });

  it("reproduces the cart fixture failure and matches the report", async () => {
    const fixture = await createCartFixture();
    fixtures.push(fixture.dir);

    const agent = new ReproductionAgent();
    const { result, run } = await agent.run({
      input: {
        repoPath: fixture.dir,
        failingTest: "src/cart.test.js",
        stackTrace: `AssertionError [ERR_ASSERTION]: Expected NaN to equal 10
    at TestContext.<anonymous> (${fixture.dir}/src/cart.test.js:6:10)
    at lineTotal (${fixture.dir}/src/cart.js:2:3)`,
      },
      runTests: true,
    });

    expect(run.status).toBe("ok");
    expect(result.result.reproduced).toBe(true);
    expect(result.match).toBe("matched");
    expect(result.confidence).toBeGreaterThan(0.8);
    expect(result.command).toContain("npm test");
    expect(result.symptoms.signals).toContain("assertion-mismatch");
    expect(result.scenario.title).toBeTruthy();
    expect(result.steps.some((step) => step.startsWith("Understand symptoms"))).toBe(true);
    expect(result.steps.some((step) => step.startsWith("Compare with the reported failure"))).toBe(true);
    expect(result.capturedFailure?.excerpt || result.result.output).toMatch(/NaN/i);
  });

  it("generates a Flutter regression test for a null savings media crash", () => {
    const crashSite = {
      file: "lib/savings/SavingsMemberMediaBloc.dart",
      line: 217,
      functionName: "SavingsMemberMediaBloc._onLoad",
      raw: "SavingsMemberMediaBloc.dart:217",
      inProject: true,
    };
    const error = {
      type: "NullCheckError",
      message: "Null check operator used on a null value",
      frames: [crashSite],
      language: "dart" as const,
    };
    const symptoms = understandSymptoms({ error, crashSite });
    const proposed = proposeReproductionTest({
      error,
      crashSite,
      symptoms,
      tests: { runner: "flutter-test", testCommand: "flutter test", relatedTests: [] },
    });

    expect(symptoms.signals).toContain("null-deref");
    expect(proposed?.path).toBe("test/savings_member_media_bloc_test.dart");
    expect(proposed?.content).toContain("should handle null savings member media response");
    expect(proposed?.content).toContain("package:flutter_test/flutter_test.dart");
    expect(proposed?.content).toContain("Null check operator used on a null value");
    expect(proposed?.content).toContain("SavingsMemberMediaBloc.dart:217");
    expect(classifyReproductionMethod({ failingTest: undefined }, { relatedTests: [] }, true)).toBe("generated-test");
  });

  it("treats a matching captured failure as matched", () => {
    const compared = compareFailures({
      reported: {
        type: "NullCheckError",
        message: "Null check operator used on a null value",
        frames: [],
        language: "dart",
      },
      crashSite: {
        file: "SavingsMemberMediaBloc.dart",
        line: 217,
        functionName: "_onLoad",
        raw: "",
        inProject: true,
      },
      captured: {
        type: "NullCheckError",
        message: "Null check operator used on a null value",
        file: "SavingsMemberMediaBloc.dart",
        line: 217,
        excerpt: "Null check operator used on a null value",
      },
      output: "Null check operator used on a null value\n#0 _onLoad (package:app/SavingsMemberMediaBloc.dart:217:12)",
      attempted: true,
      reproduced: true,
    });

    expect(compared.match).toBe("matched");
    expect(compared.confidence).toBeGreaterThan(0.85);
  });
});
