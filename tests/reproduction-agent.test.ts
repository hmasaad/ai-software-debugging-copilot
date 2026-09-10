import { afterEach, describe, expect, it } from "vitest";
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
    expect(agent.responsibility).toBe("Determine how to reproduce the issue");
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

  it("reproduces the cart fixture failure", async () => {
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
    expect(result.command).toContain("npm test");
    expect(result.steps.length).toBeGreaterThan(1);
  });
});
