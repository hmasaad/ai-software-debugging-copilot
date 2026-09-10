import { describe, expect, it } from "vitest";
import {
  countLogLevels,
  extractExceptionChain,
  extractRepeating,
  LogAnalyzerAgent,
} from "../src/agents/log-analyzer.js";
import { LOG_ANALYZER } from "../src/agents/types.js";

describe("Log Analyzer", () => {
  it("exposes the core-agent contract", () => {
    const agent = new LogAnalyzerAgent();
    expect(agent.id).toBe("log-analyzer");
    expect(agent.name).toBe(LOG_ANALYZER.name);
    expect(agent.responsibility).toBe("Understand logs, exceptions and stack traces");
  });

  it("finds the crash site and primary exception from a Node stack", async () => {
    const agent = new LogAnalyzerAgent();
    const { result, run } = await agent.run({
      repoPath: "/repo",
      stackTrace: `TypeError: Cannot read properties of undefined (reading 'id')
    at getPrimaryItemId (/repo/src/cart.js:16:21)
    at ModuleJob.run (node:internal/modules/esm/module_job:234:25)`,
    });

    expect(run.status).toBe("ok");
    expect(result.error.type).toBe("TypeError");
    expect(result.crashSite).toMatchObject({ file: "/repo/src/cart.js", line: 16, functionName: "getPrimaryItemId" });
    expect(result.exceptionChain[0]).toMatchObject({ role: "primary", type: "TypeError" });
    expect(result.handoff.some((note) => note.includes("src/cart.js:16"))).toBe(true);
  });

  it("walks a Java caused-by chain to the inner exception", () => {
    const text = `java.io.IOException: failed to load user
    at com.acme.UserService.load(UserService.java:42)
Caused by: java.lang.NullPointerException: user is null
    at com.acme.UserRepo.find(UserRepo.java:18)`;
    const chain = extractExceptionChain(text, { type: "IOException", message: "failed to load user" });
    expect(chain[0]).toMatchObject({ role: "primary", type: "java.io.IOException" });
    expect(chain.some((item) => item.role === "caused-by" && item.type === "java.lang.NullPointerException")).toBe(true);
  });

  it("counts log levels and repeating error lines", () => {
    const text = `2026-09-10T06:18:24Z ERROR checkout failed
ERROR checkout failed
WARN retrying
INFO started`;
    expect(countLogLevels(text)).toMatchObject({ error: 2, warn: 1, info: 1 });
    expect(extractRepeating(text)[0]).toMatchObject({ count: 2 });
  });
});
