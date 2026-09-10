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
  reproductionAnalysis: {
    result: {
      attempted: true,
      reproduced: true,
      command: "npm test --silent",
      exitCode: 1,
      output: "NaN !== 10",
      summary: "Reproduced: `npm test --silent` failed with exit 1.",
    },
    method: "test-suite",
    command: "npm test --silent",
    runner: "npm-test",
    relatedTests: [{ file: "src/cart.test.js", reason: "name-match for src/cart.js" }],
    steps: [
      "Understand symptoms: TypeError at cart.js:16: Cannot read properties of undefined (reading 'id')",
      "Create scenario: should handle null cart response",
      "Run `npm test --silent`.",
      "Confirm the crash at `src/cart.js:16` in getPrimaryItemId.",
      "Capture the live failure output.",
      "Compare with the reported failure — matched.",
    ],
    symptoms: {
      summary: "TypeError at cart.js:16: Cannot read properties of undefined (reading 'id')",
      errorType: "TypeError",
      errorMessage: "Cannot read properties of undefined (reading 'id')",
      crashSite: "src/cart.js:16",
      language: "javascript",
      signals: ["null-deref", "crash-function"],
    },
    scenario: {
      title: "should handle null cart response",
      setup: ["Start from crash site `src/cart.js:16` (getPrimaryItemId)."],
      action: "Run `npm test --silent` (test-suite).",
      expectedFailure: "TypeError: Cannot read properties of undefined (reading 'id')",
    },
    capturedFailure: {
      type: "AssertionError",
      message: "Expected NaN to equal 10",
      excerpt: "NaN !== 10",
    },
    match: "matched",
    matchDetail: "Captured failure matches the report (TypeError, cart.js).",
    confidence: 0.92,
    summary: "Issue reproduced via `npm test --silent` (test-suite).",
    handoff: ["Failure is live: Reproduced: `npm test --silent` failed with exit 1."],
  },
  causeAnalysis: {
    causes: [
      {
        id: "H1",
        kind: "null-deref",
        description: "Null/undefined value reached a dereference. A missing guard or bad default is likely.",
        evidence: ["Cannot read properties of undefined (reading 'id')"],
        likelihood: 0.78,
      },
    ],
    leading: {
      id: "H1",
      kind: "null-deref",
      description: "Null/undefined value reached a dereference. A missing guard or bad default is likely.",
      evidence: ["Cannot read properties of undefined (reading 'id')"],
      likelihood: 0.78,
    },
    confidence: 0.82,
    affectedFiles: ["src/cart.js"],
    graph: {
      claim: "Null/undefined dereference",
      confidence: 0.82,
      nodes: [
        { id: "crash", kind: "crash", label: "TypeError", detail: "Cannot read properties of undefined (reading 'id')" },
        { id: "function", kind: "function", label: "getPrimaryItemId", detail: "src/cart.js:16" },
        { id: "null-value", kind: "null-value", label: "null value" },
      ],
      supporting: [
        { id: "stack-trace", label: "Stack trace", present: true, supports: true, detail: "src/cart.js:16" },
        { id: "source-code", label: "Source code", present: true, supports: true, detail: "return order.item.id;" },
        { id: "null-value", label: "Null/undefined value", present: true, supports: true, detail: "undefined (reading 'id')" },
        { id: "git-commit", label: "Git commit", present: false, supports: false, detail: "No introducing commit identified." },
        { id: "reproduction", label: "Reproduction", present: true, supports: true, detail: "Reproduced locally." },
      ],
      contradicting: [],
      summary: "Null/undefined dereference (82%) via TypeError → getPrimaryItemId → null value.",
    },
    summary: "Leading cause H1 (82%): Null/undefined value reached a dereference.",
    handoff: ["Investigate H1 (null-deref) first."],
  },
  fixAnalysis: {
    proposal: {
      summary: "Add a null/undefined check at the dereference in the top project frame.",
      rationale: "order.item is undefined",
      edits: [],
      testPlan: ["Run npm test --silent."],
      risks: [],
      applied: false,
      applyErrors: [],
    },
    strategy: "optional-chain",
    source: "heuristic",
    summary: "Heuristic optional-chain fix in src/cart.js (1 edit, not applied).",
    handoff: ["Re-run with --apply to write the patch and verify."],
  },
  testAnalysis: {
    verification: {
      testsRan: false,
      passed: false,
      output: "",
      summary: "Patch not applied; verification skipped.",
    },
    relatedTests: [{ file: "src/cart.test.js", reason: "name-match for src/cart.js" }],
    proposedTest: {
      path: "src/cart.regression.test.js",
      content: "",
      reason: "Extend coverage for getPrimaryItemId.",
      created: false,
    },
    createdFiles: [],
    summary: "Proposed regression test `src/cart.regression.test.js`.",
    handoff: ["Apply the patch, then re-run Test Agent."],
  },
  validationAnalysis: {
    verdict: "inconclusive",
    resolved: false,
    checks: [
      { id: "patch-applied", passed: false, detail: "Patch was not applied." },
      { id: "tests-passed", passed: false, detail: "Tests were not run." },
    ],
    residualRisks: ["Patch applied without a live test run."],
    summary: "Cannot confirm the fix yet (0/2 checks passed).",
    handoff: ["Apply the patch and re-run tests before calling the incident resolved."],
  },
  incidentReport: {
    title: "TypeError: Cannot read properties of undefined (reading 'id') @ src/cart.js:16",
    severity: "sev-2",
    status: "identified",
    impact: "TypeError is reproducible at src/cart.js:16 via `npm test --silent`.",
    whatHappened: "TypeError: Cannot read properties of undefined (reading 'id'). Crash site src/cart.js:16.",
    rootCause: "Null/undefined value reached a dereference.",
    fix: "Heuristic optional-chain fix in src/cart.js (not applied).",
    validation: "Cannot confirm the fix yet.",
    timeline: [{ label: "Detected", detail: "TypeError at src/cart.js:16 in getPrimaryItemId." }],
    followUps: ["Apply the patch with --apply and re-run validation."],
    body: "## Incident\n**SEV-2** · identified",
    summary: "SEV-2 identified: TypeError at src/cart.js:16.",
    handoff: ["Apply the patch with --apply and re-run validation."],
  },
  sandbox: {
    originRepo: "/repo/examples/failing-cart",
    path: "/tmp/debug-copilot-sandbox-demo",
    kind: "worktree",
    promoted: false,
    reverted: false,
    actions: [
      { tool: "inspect-repo", detail: "kind=worktree HEAD=abc1234", ok: true },
      { tool: "search-code", detail: "cart.js: return order.item.id", ok: true },
    ],
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
    expect(html).toContain("Reproduction Agent");
    expect(html).toContain("match");
    expect(html).toContain("Root Cause Agent");
    expect(html).toContain("Evidence graph");
    expect(html).toContain("Contradicting evidence");
    expect(html).toContain("Fix Agent");
    expect(html).toContain("Test Agent");
    expect(html).toContain("Validation Agent");
    expect(html).toContain("Incident Agent");
    expect(html).toContain("Autonomous sandbox");
    expect(html).toContain("inspect-repo");
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
