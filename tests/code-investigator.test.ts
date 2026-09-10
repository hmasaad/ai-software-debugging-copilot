import { afterEach, describe, expect, it } from "vitest";
import { CodeInvestigatorAgent, findEnclosingFunction, identifiers } from "../src/agents/code-investigator.js";
import { CODE_INVESTIGATOR } from "../src/agents/types.js";
import { createCartFixture, removeFixture } from "./helpers/fixture.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => removeFixture(dir)));
});

describe("Code Investigator", () => {
  it("exposes the core-agent contract", () => {
    const agent = new CodeInvestigatorAgent();
    expect(agent.id).toBe("code-investigator");
    expect(agent.name).toBe(CODE_INVESTIGATOR.name);
    expect(agent.responsibility).toBe("Trace the error through the codebase");
  });

  it("finds the enclosing function around a crash line", () => {
    const lines = [
      "export function lineTotal(item) {",
      "  return item.price * item.qty;",
      "}",
      "",
      "export function getPrimaryItemId(order) {",
      "  return order.item.id;",
      "}",
    ];
    const span = findEnclosingFunction(lines, 6);
    expect(span).toMatchObject({ name: "getPrimaryItemId", start: 5 });
    expect(identifiers("return order.item.id;")).toEqual(["order", "item", "id"]);
  });

  it("traces getPrimaryItemId from the crash site to its caller", async () => {
    const fixture = await createCartFixture();
    fixtures.push(fixture.dir);

    const agent = new CodeInvestigatorAgent();
    const { result, run } = await agent.run({
      input: {
        repoPath: fixture.dir,
        stackTrace: `TypeError: Cannot read properties of undefined (reading 'id')
    at getPrimaryItemId (${fixture.dir}/src/cart.js:10:21)
    at ${fixture.dir}/src/crash.js:3:13`,
      },
    });

    expect(run.status).toBe("ok");
    expect(result.trace.some((step) => step.role === "crash-site")).toBe(true);
    expect(result.suspects).toEqual(expect.arrayContaining(["order", "item", "id"]));
    expect(result.summary.toLowerCase()).toMatch(/cart\.js/);
    const inbound =
      result.trace.some((step) => step.file.includes("crash.js")) ||
      result.callers.some((caller) => caller.file.includes("crash.js"));
    expect(inbound).toBe(true);
  });
});
