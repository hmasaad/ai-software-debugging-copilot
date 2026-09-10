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
  codeInvestigation: {
    origin: { file: "src/cart.js", line: 16, functionName: "getPrimaryItemId", raw: "at getPrimaryItemId", inProject: true },
    trace: [
      {
        file: "src/crash.js",
        line: 4,
        functionName: "getPrimaryItemId",
        role: "caller",
        expression: "console.log(getPrimaryItemId(order));",
        note: "Caller src/crash.js:4: console.log(getPrimaryItemId(order));",
      },
      {
        file: "src/cart.js",
        line: 16,
        functionName: "getPrimaryItemId",
        role: "crash-site",
        expression: "return order.item.id;",
        note: "Unguarded access at src/cart.js:16 in getPrimaryItemId: return order.item.id;",
      },
    ],
    functions: [
      { file: "src/cart.js", name: "getPrimaryItemId", startLine: 15, endLine: 17, signature: "export function getPrimaryItemId(order) {" },
    ],
    callers: [{ file: "src/crash.js", line: 4, text: "console.log(getPrimaryItemId(order));" }],
    suspects: ["order", "item", "id"],
    snippets: [],
    summary: "Traced crash to src/cart.js:16 in getPrimaryItemId. Reached from src/crash.js:4.",
    handoff: ["Inspect src/cart.js:16 — return order.item.id;"],
  },
  gitInvestigation: {
    evidence: { available: true, branch: "main", head: "abc1234", recentCommits: [], commitsTouchingSuspects: [], blame: [] },
    pullRequests: [],
    suspects: [
      {
        sha: "deadbeef1111",
        author: "Ada",
        date: "2026-09-10",
        subject: "unguarded item.id access",
        score: 0.9,
        reasons: ["git blame on src/cart.js:16"],
      },
    ],
    introducing: {
      sha: "deadbeef1111",
      author: "Ada",
      date: "2026-09-10",
      subject: "unguarded item.id access",
      score: 0.9,
      reasons: ["git blame on src/cart.js:16"],
    },
    summary: "Likely introduced by deadbeef (Ada, 2026-09-10): unguarded item.id access.",
    handoff: ["Inspect commit deadbeef — unguarded item.id access (git blame on src/cart.js:16)."],
  },
  dependencyAnalysis: {
    evidence: { ecosystem: "node", hits: [] },
    issues: [{ kind: "none", detail: "No dependency or version signal in the error.", likelihood: 0.15 }],
    likelyDependencyBug: false,
    summary: "No strong dependency/version signal (node). Treat this as application code unless a later agent disagrees.",
    handoff: ["Prefer a source-level fix; dependency/version looks unlikely."],
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
    expect(html).toContain("Code Investigator");
    expect(html).toContain("Git Investigator");
    expect(html).toContain("Dependency Analyst");
    expect(html).toContain("unguarded item.id access");
    expect(html).toContain("Trace the error through the codebase");
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
