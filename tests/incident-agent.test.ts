import { describe, expect, it } from "vitest";
import { buildIncidentReport, IncidentAgent } from "../src/agents/incident-agent.js";
import { INCIDENT_AGENT } from "../src/agents/types.js";

describe("Incident Agent", () => {
  it("exposes the core-agent contract", () => {
    const agent = new IncidentAgent();
    expect(agent.id).toBe("incident-agent");
    expect(agent.name).toBe(INCIDENT_AGENT.name);
    expect(agent.responsibility).toBe("Produce an engineer-friendly incident report");
  });

  it("writes a SEV-style report from specialist findings", () => {
    const report = buildIncidentReport({
      logAnalysis: {
        error: {
          type: "TypeError",
          message: "Cannot read properties of undefined (reading 'id')",
          frames: [],
        },
        logs: { sources: [], excerpt: "" },
        crashSite: { file: "src/cart.js", line: 16, functionName: "getPrimaryItemId", raw: "", inProject: true },
        exceptionChain: [],
        logLevels: { fatal: 0, error: 1, warn: 0, info: 0, debug: 0 },
        timestamps: [],
        correlationIds: [],
        repeating: [],
        summary: "TypeError at src/cart.js:16 in getPrimaryItemId.",
        handoff: [],
      },
      codeInvestigation: {
        origin: { file: "src/cart.js", line: 16, functionName: "getPrimaryItemId", raw: "", inProject: true },
        trace: [
          {
            file: "src/cart.js",
            line: 16,
            role: "crash-site",
            expression: "return order.item.id;",
            note: "Unguarded access",
          },
        ],
        functions: [],
        callers: [],
        suspects: [],
        snippets: [],
        summary: "Traced crash to src/cart.js:16.",
        handoff: [],
      },
      reproduction: {
        result: {
          attempted: true,
          reproduced: true,
          command: "npm test --silent",
          output: "",
          summary: "Reproduced via npm test --silent.",
        },
        method: "test-suite",
        command: "npm test --silent",
        relatedTests: [],
        steps: ["Run `npm test --silent`."],
        summary: "Issue reproduced via `npm test --silent` (test-suite).",
        handoff: [],
      },
      causeAnalysis: {
        causes: [],
        leading: {
          id: "H1",
          kind: "null-deref",
          description: "Null/undefined value reached a dereference.",
          evidence: [],
          likelihood: 0.78,
        },
        confidence: 0.8,
        affectedFiles: ["src/cart.js"],
        summary: "Leading cause H1",
        handoff: [],
      },
      fixAnalysis: {
        proposal: {
          summary: "optional chain",
          rationale: "",
          edits: [{ path: "src/cart.js", oldString: "return order.item.id;", newString: "return order.item?.id;" }],
          testPlan: [],
          risks: [],
          applied: true,
          applyErrors: [],
        },
        strategy: "optional-chain",
        source: "heuristic",
        summary: "Heuristic optional-chain fix in src/cart.js (1 edit, applied).",
        handoff: [],
      },
      testAnalysis: {
        verification: {
          testsRan: true,
          passed: true,
          command: "npm test --silent",
          output: "",
          summary: "passed",
        },
        relatedTests: [],
        createdFiles: [],
        summary: "Tests passed via `npm test --silent`.",
        handoff: [],
      },
      validation: {
        verdict: "resolved",
        resolved: true,
        checks: [],
        residualRisks: [],
        summary: "Fix resolves the issue.",
        handoff: ["Safe to keep the patch; write up the incident."],
      },
    });

    expect(report.severity).toBe("sev-2");
    expect(report.status).toBe("resolved");
    expect(report.title).toMatch(/TypeError/);
    expect(report.body).toContain("### What happened");
    expect(report.body).toContain("### Root cause");
    expect(report.timeline.some((event) => event.label === "Validated")).toBe(true);
  });
});
