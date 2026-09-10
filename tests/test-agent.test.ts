import { describe, expect, it } from "vitest";
import { proposeRegressionTest, TestAgent } from "../src/agents/test-agent.js";
import { TEST_AGENT } from "../src/agents/types.js";

describe("Test Agent", () => {
  it("exposes the core-agent contract", () => {
    const agent = new TestAgent();
    expect(agent.id).toBe("test-agent");
    expect(agent.name).toBe(TEST_AGENT.name);
    expect(agent.responsibility).toBe("Create/run tests against the fix");
  });

  it("proposes a regression test next to the crash file", () => {
    const proposed = proposeRegressionTest({
      repoPath: "/repo",
      tests: { runner: "npm-test", testCommand: "npm test --silent", relatedTests: [] },
      codeInvestigation: {
        origin: { file: "/repo/src/cart.js", line: 10, functionName: "getPrimaryItemId", raw: "", inProject: true },
        trace: [],
        functions: [],
        callers: [],
        suspects: [],
        snippets: [],
        summary: "",
        handoff: [],
      },
    });

    expect(proposed?.path).toBe("src/cart.regression.test.js");
    expect(proposed?.content).toContain("getPrimaryItemId");
    expect(proposed?.created).toBe(false);
  });

  it("still proposes an extra regression when a related test already exists", () => {
    const proposed = proposeRegressionTest({
      tests: {
        relatedTests: [{ file: "src/cart.test.js", reason: "name-match" }],
      },
      codeInvestigation: {
        origin: { file: "src/cart.js", line: 10, functionName: "getPrimaryItemId", raw: "", inProject: true },
        trace: [],
        functions: [],
        callers: [],
        suspects: [],
        snippets: [],
        summary: "",
        handoff: [],
      },
    });
    expect(proposed?.path).toBe("src/cart.regression.test.js");
  });

  it("skips live verification until a patch is applied", async () => {
    const agent = new TestAgent();
    const { result, run } = await agent.run({
      input: { repoPath: process.cwd() },
      apply: false,
      runTests: true,
      evidence: {
        collectedAt: new Date().toISOString(),
        repoPath: process.cwd(),
        error: { message: "x", frames: [] },
        logs: { sources: [], excerpt: "" },
        sourceSnippets: [],
        git: { available: false, recentCommits: [], commitsTouchingSuspects: [], blame: [] },
        pullRequests: [],
        tests: { testCommand: "npm test --silent", relatedTests: [] },
        dependencies: { hits: [] },
        runtime: { os: "darwin", arch: "x64", cwd: process.cwd(), ci: false, envHints: [] },
      },
    });

    expect(run.status).toBe("ok");
    expect(result.verification.testsRan).toBe(false);
    expect(result.summary.toLowerCase()).toMatch(/not written|not applied|skipped/);
  });
});
