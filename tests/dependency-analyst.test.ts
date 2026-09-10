import { describe, expect, it } from "vitest";
import { classifyDependencyIssues, DependencyAnalystAgent } from "../src/agents/dependency-analyst.js";
import { DEPENDENCY_ANALYST } from "../src/agents/types.js";
import type { DependencyEvidence, ParsedError } from "../src/types.js";

const emptyEvidence: DependencyEvidence = { ecosystem: "node", manifest: "package.json", hits: [] };

describe("Dependency Analyst", () => {
  it("exposes the core-agent contract", () => {
    const agent = new DependencyAnalystAgent();
    expect(agent.id).toBe("dependency-analyst");
    expect(agent.name).toBe(DEPENDENCY_ANALYST.name);
    expect(agent.responsibility).toBe("Detect dependency/version-related issues");
  });

  it("flags a missing module that is not in the manifest", () => {
    const error: ParsedError = {
      type: "Error",
      message: "Cannot find module 'left-pad'",
      frames: [],
    };
    const issues = classifyDependencyIssues(error, [], emptyEvidence);
    expect(issues[0]).toMatchObject({ kind: "missing-module", package: "left-pad" });
    expect(issues[0]?.likelihood).toBeGreaterThan(0.8);
  });

  it("treats a declared-but-unresolved module as lockfile drift", () => {
    const error: ParsedError = {
      type: "Error",
      message: "Cannot find module 'left-pad'",
      frames: [],
    };
    const issues = classifyDependencyIssues(error, [], {
      ecosystem: "node",
      manifest: "package-lock.json",
      hits: [{ name: "left-pad", version: "^1.3.0", source: "package.json" }],
    });
    expect(issues[0]).toMatchObject({ kind: "lockfile-drift", package: "left-pad" });
  });

  it("detects ESM/CJS interop failures", () => {
    const error: ParsedError = {
      type: "Error",
      message: "require() of ES Module not supported",
      stackTrace: "Error [ERR_REQUIRE_ESM]: require() of ES Module",
      frames: [],
    };
    const issues = classifyDependencyIssues(error, [], emptyEvidence);
    expect(issues[0]?.kind).toBe("esm-cjs");
  });

  it("does not treat an application TypeError as a dependency bug", async () => {
    const agent = new DependencyAnalystAgent();
    const { result, run } = await agent.run({
      input: {
        repoPath: process.cwd(),
        stackTrace: `TypeError: Cannot read properties of undefined (reading 'id')
    at getPrimaryItemId (src/cart.js:16:21)`,
      },
    });

    expect(run.status).toBe("ok");
    expect(result.likelyDependencyBug).toBe(false);
    expect(result.issues[0]?.kind).toBe("none");
  });
});
