import { describe, expect, it } from "vitest";
import { renderInvestigationBoard } from "../src/board/html.js";
import { startBoardServer } from "../src/board/serve.js";
import type { DebuggingReport } from "../src/types.js";

const report: DebuggingReport = {
  title: "Debugging report: TypeError: Cannot read properties of undefined (reading 'id')",
  createdAt: "2026-09-10T06:18:24.729Z",
  repoPath: "/repo/examples/failing-cart",
  error: {
    type: "TypeError",
    message: "Cannot read properties of undefined (reading 'id')",
    frames: [
      { file: "src/cart.js", line: 16, column: 21, functionName: "getPrimaryItemId", raw: "at getPrimaryItemId", inProject: true },
    ],
    language: "javascript",
  },
  evidence: {
    collectedAt: "2026-09-10T06:18:24.729Z",
    repoPath: "/repo/examples/failing-cart",
    error: {
      type: "TypeError",
      message: "Cannot read properties of undefined (reading 'id')",
      frames: [
        { file: "src/cart.js", line: 16, functionName: "getPrimaryItemId", raw: "at getPrimaryItemId", inProject: true },
      ],
      language: "javascript",
    },
    logs: { sources: ["crash.log"], excerpt: "TypeError: Cannot read properties of undefined (reading 'id')" },
    sourceSnippets: [
      {
        file: "src/cart.js",
        startLine: 15,
        endLine: 16,
        focusLine: 16,
        content: ">  16 |   return order.item.id;",
        language: "javascript",
      },
    ],
    git: { available: true, branch: "main", head: "abc1234", recentCommits: [], commitsTouchingSuspects: [], blame: [] },
    pullRequests: [],
    tests: {
      runner: "npm-test",
      testCommand: "npm test --silent",
      relatedTests: [{ file: "src/cart.test.js", reason: "name-match for src/cart.js" }],
    },
    dependencies: { ecosystem: "node", hits: [] },
    runtime: {
      os: "darwin",
      arch: "x64",
      node: "v22.13.0",
      cwd: "/repo/examples/failing-cart",
      ci: false,
      envHints: [],
    },
  },
  reproduction: {
    attempted: true,
    reproduced: true,
    command: "npm test --silent",
    exitCode: 1,
    output: "NaN !== 10",
    summary: "Reproduced: `npm test --silent` failed with exit 1.",
  },
  rootCause: {
    summary: "Heuristic analysis of TypeError at getPrimaryItemId.",
    rootCause: "Defect in src/cart.js:16 (getPrimaryItemId) — this is the top project frame.",
    confidence: 0.8,
    hypotheses: [
      {
        id: "H1",
        description: "Defect in src/cart.js:16 (getPrimaryItemId)",
        evidence: ["at getPrimaryItemId (src/cart.js:16:21)"],
        likelihood: 0.72,
      },
    ],
    affectedFiles: ["src/cart.js"],
    reproSteps: ["Run npm test --silent."],
    investigator: "heuristic",
  },
  proposedFix: {
    summary: "Add a null/undefined check at the dereference in the top project frame.",
    rationale: "order.item is undefined",
    edits: [],
    testPlan: ["Run npm test --silent."],
    risks: ["Heuristic mode does not apply code edits."],
    applied: false,
    applyErrors: [],
  },
  verification: {
    testsRan: false,
    passed: false,
    output: "",
    summary: "Patch not applied; verification skipped.",
  },
  iterations: [],
  notes: ["Ran in heuristic mode (no LLM key)."],
  agentRuns: [
    {
      id: "log-analyzer",
      name: "Log Analyzer",
      responsibility: "Understand logs, exceptions and stack traces",
      status: "ok",
      summary: "TypeError at src/cart.js:16 in getPrimaryItemId.",
      durationMs: 12,
    },
  ],
  logAnalysis: {
    error: {
      type: "TypeError",
      message: "Cannot read properties of undefined (reading 'id')",
      frames: [
        { file: "src/cart.js", line: 16, functionName: "getPrimaryItemId", raw: "at getPrimaryItemId", inProject: true },
      ],
      language: "javascript",
    },
    logs: { sources: ["crash.log"], excerpt: "TypeError: Cannot read properties of undefined (reading 'id')" },
    crashSite: { file: "src/cart.js", line: 16, functionName: "getPrimaryItemId", raw: "at getPrimaryItemId", inProject: true },
    exceptionChain: [
      { type: "TypeError", message: "Cannot read properties of undefined (reading 'id')", role: "primary" },
    ],
    logLevels: { fatal: 0, error: 1, warn: 0, info: 0, debug: 0 },
    timestamps: [],
    correlationIds: [],
    repeating: [],
    summary: "TypeError at src/cart.js:16 in getPrimaryItemId.",
    handoff: ["Inspect crash site src/cart.js:16 (getPrimaryItemId) — top project frame."],
  },
};

describe("investigation board", () => {
  it("renders every investigation column from a report", () => {
    const html = renderInvestigationBoard(report);
    expect(html).toContain("Investigation board");
    expect(html).toContain("TypeError");
    expect(html).toContain("getPrimaryItemId");
    expect(html).toContain("src/cart.js:16");
    expect(html).toContain("Collect evidence");
    expect(html).toContain("Root cause analysis");
    expect(html).toContain("H1");
    expect(html).toContain("80%");
    expect(html).toContain("NaN !== 10");
    expect(html).toContain("Log Analyzer");
    expect(html).toContain("Understand logs, exceptions and stack traces");
    expect(html).toContain("Core agents");
  });

  it("serves the board and report JSON", async () => {
    const board = await startBoardServer(report, { port: 0 });
    try {
      const page = await fetch(board.url);
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(html).toContain("Investigation board");

      const json = await fetch(`${board.url}/report.json`);
      const body = (await json.json()) as DebuggingReport;
      expect(body.rootCause.confidence).toBe(0.8);
    } finally {
      await board.close();
    }
  });
});
