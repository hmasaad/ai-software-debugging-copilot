import { describe, expect, it } from "vitest";
import {
  INCIDENT_RESPONSE_FLOW,
  INCIDENT_RESPONSE_GATES,
  buildIncidentResponse,
  canExecuteAutonomously,
  looksLikeDataMutation,
  renderIncidentResponseAscii,
} from "../src/analysis/incident-response.js";
import type { FixAnalysis, GitInvestigation, LogAnalysis, RollbackIntelligence, ValidationAnalysis } from "../src/types.js";

const FLOW = [
  "             Detection",
  "                 ↓",
  "          Investigation",
  "                 ↓",
  "            Diagnosis",
  "                 ↓",
  "          Risk Analysis",
  "                 ↓",
  "       ┌─────────┴─────────┐",
  "       ↓                   ↓",
  "    Rollback             Fix",
  "       │                   │",
  "       └─────────┬─────────┘",
  "                 ↓",
  "             Validation",
  "                 ↓",
  "            Monitoring",
  "                 ↓",
  "              RESOLVED",
].join("\n");

const GATES = [
  "Read logs                 AUTO",
  "Investigate               AUTO",
  "Create reproduction       AUTO",
  "Generate patch            AUTO",
  "Run tests                 AUTO",
  "Create PR                 AUTO",
  "Deploy                    APPROVAL",
  "Rollback production       APPROVAL",
  "Delete/modify data        APPROVAL",
].join("\n");

const logs: LogAnalysis = {
  error: { type: "TypeError", message: "boom", frames: [] },
  logs: { sources: [], excerpt: "" },
  exceptionChain: [],
  logLevels: { fatal: 0, error: 1, warn: 0, info: 0, debug: 0 },
  timestamps: [],
  correlationIds: [],
  repeating: [],
  summary: "TypeError",
  handoff: [],
};

const git: GitInvestigation = {
  evidence: { available: true, recentCommits: [], commitsTouchingSuspects: [], blame: [] },
  pullRequests: [],
  suspects: [],
  introducing: {
    sha: "abc1234def",
    author: "Dev",
    date: "2026-09-11",
    subject: "Firebase initialization change",
    score: 0.9,
    reasons: ["blame"],
  },
  summary: "Likely introduced by abc1234",
  handoff: [],
};

const fix: FixAnalysis = {
  proposal: {
    summary: "optional chain",
    rationale: "",
    edits: [{ path: "src/cart.js", oldString: "item.id", newString: "item?.id" }],
    testPlan: [],
    risks: [],
    applied: true,
    applyErrors: [],
  },
  strategy: "optional-chain",
  source: "heuristic",
  summary: "optional chain",
  handoff: [],
  risk: {
    label: "Fix A",
    files: 1,
    tests: 1,
    modules: 1,
    level: "LOW",
    confidence: 0.9,
    preferred: true,
    filePaths: ["src/cart.js"],
    reasons: [],
  },
};

const validation: ValidationAnalysis = {
  verdict: "resolved",
  resolved: true,
  checks: [],
  residualRisks: [],
  summary: "resolved",
  handoff: [],
};

const rollback: RollbackIntelligence = {
  canSafelyPatch: false,
  action: "rollback",
  target: "1.0.180",
  reason: "327 users after a known-bad deploy. Do not ship a code patch first.",
  fallbacks: ["feature-flag", "configuration", "disable"],
  steps: ["Roll back to 1.0.180"],
  summary: "Can safely patch: NO → Rollback (1.0.180).",
};

describe("autonomous incident response", () => {
  it("locks the connected response flow and approval gates", () => {
    expect(INCIDENT_RESPONSE_FLOW).toBe(FLOW);
    expect(INCIDENT_RESPONSE_GATES).toBe(GATES);
    expect(canExecuteAutonomously("read-logs")).toBe(true);
    expect(canExecuteAutonomously("create-pr")).toBe(true);
    expect(canExecuteAutonomously("deploy")).toBe(false);
    expect(canExecuteAutonomously("rollback-production")).toBe(false);
    expect(canExecuteAutonomously("delete-modify-data")).toBe(false);
  });

  it("runs a local safe patch to RESOLVED without waiting on deploy", () => {
    const response = buildIncidentResponse({
      logAnalysis: logs,
      gitInvestigation: git,
      rootCause: {
        summary: "null",
        rootCause: "null deref",
        confidence: 0.9,
        hypotheses: [],
        affectedFiles: ["src/cart.js"],
        reproSteps: [],
        investigator: "heuristic",
      },
      fixAnalysis: fix,
      testAnalysis: {
        verification: { testsRan: true, passed: true, output: "", summary: "pass" },
        relatedTests: [],
        createdFiles: [],
        summary: "pass",
        handoff: [],
      },
      validation,
      rollbackIntelligence: {
        ...rollback,
        canSafelyPatch: true,
        action: "patch",
        reason: "Smallest safe code fix is available.",
        summary: "Can safely patch: YES → Patch.",
      },
      production: false,
    });
    expect(response.path).toBe("fix");
    expect(response.stage).toBe("RESOLVED");
    expect(response.waiting).toEqual([]);
    expect(response.actions.find((action) => action.id === "deploy")?.status).toBe("skipped");
    expect(response.actions.find((action) => action.id === "rollback-production")?.status).toBe("skipped");
    expect(renderIncidentResponseAscii(response)).toBe(
      [
        FLOW,
        "",
        GATES,
        "",
        "Path: Fix",
        "Stage: RESOLVED",
        "Waiting for approval: none",
        "Reason: Smallest safe fix ran autonomously.",
      ].join("\n"),
    );
  });

  it("holds a production rollback for human approval", () => {
    const response = buildIncidentResponse({
      logAnalysis: logs,
      gitInvestigation: git,
      rootCause: {
        summary: "firebase",
        rootCause: "Firebase init",
        confidence: 0.91,
        hypotheses: [],
        affectedFiles: ["lib/firebase.dart"],
        reproSteps: [],
        investigator: "heuristic",
      },
      rollbackIntelligence: rollback,
      production: true,
    });
    expect(response.path).toBe("rollback");
    expect(response.stage).toBe("Rollback");
    expect(response.waiting).toEqual(["Rollback production"]);
    expect(response.actions.find((action) => action.id === "rollback-production")?.status).toBe("waiting-approval");
    expect(response.actions.find((action) => action.id === "deploy")?.gate).toBe("APPROVAL");
    expect(response.actions.find((action) => action.id === "rollback-production")?.status).not.toBe("done");
    expect(renderIncidentResponseAscii(response)).toContain("Waiting for approval: Rollback production");
    expect(renderIncidentResponseAscii(response)).toContain("Path: Rollback");
  });

  it("blocks delete/modify-data patches until a human approves", () => {
    expect(
      looksLikeDataMutation([{ path: "db/cleanup.sql", oldString: "-- noop", newString: "DELETE FROM users;" }]),
    ).toBe(true);
    expect(looksLikeDataMutation([{ path: "src/cart.js", oldString: "item.id", newString: "item?.id" }])).toBe(false);
    const response = buildIncidentResponse({
      logAnalysis: logs,
      gitInvestigation: git,
      rootCause: {
        summary: "cleanup",
        rootCause: "stale rows",
        confidence: 0.5,
        hypotheses: [],
        affectedFiles: ["db/cleanup.sql"],
        reproSteps: [],
        investigator: "heuristic",
      },
      fixAnalysis: {
        ...fix,
        proposal: {
          ...fix.proposal,
          edits: [{ path: "db/cleanup.sql", oldString: "-- noop", newString: "DELETE FROM users;" }],
        },
      },
      production: true,
    });
    expect(response.actions.find((action) => action.id === "delete-modify-data")?.status).toBe("waiting-approval");
    expect(response.waiting).toContain("Delete/modify data");
  });
});
