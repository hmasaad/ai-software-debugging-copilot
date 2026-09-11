import { describe, expect, it } from "vitest";
import { IncidentAgent } from "../src/agents/incident-agent.js";
import {
  PRODUCTION_INVESTIGATOR_FLOW,
  buildRollbackPlan,
  correlateIncident,
  detectIncident,
  investigateProductionIncident,
  parseProductionMetrics,
  renderProductionInvestigatorAscii,
} from "../src/analysis/incident-investigator.js";
import { renderCorrelationAscii } from "../src/analysis/correlation-engine.js";
import type { GitInvestigation, LogAnalysis } from "../src/types.js";

const git: GitInvestigation = {
  evidence: { available: true, recentCommits: [], commitsTouchingSuspects: [], blame: [] },
  pullRequests: [],
  suspects: [],
  introducing: {
    sha: "abc1234",
    author: "Dev",
    date: "2026-09-10",
    subject: "Firebase initialization change",
    score: 0.9,
    reasons: ["blame"],
  },
  summary: "Likely introduced by abc1234",
  handoff: [],
};

const logs: LogAnalysis = {
  error: { type: "FirebaseException", message: "Firebase initialization failed", frames: [] },
  logs: { sources: ["crashlytics"], excerpt: "Firebase initialization failed" },
  crashSite: { file: "lib/firebase.dart", line: 12, raw: "", inProject: true },
  exceptionChain: [],
  logLevels: { fatal: 1, error: 2, warn: 0, info: 0, debug: 0 },
  timestamps: ["2026-09-11T14:32:00Z"],
  correlationIds: ["trace-9f2a"],
  repeating: [{ message: "Firebase initialization failed", count: 12 }],
  summary: "Firebase crash",
  handoff: [],
};

describe("production incident investigator", () => {
  it("prints the investigator flow", () => {
    expect(PRODUCTION_INVESTIGATOR_FLOW).toBe(
      [
        "                 PRODUCTION INCIDENT",
        "                         │",
        "                         ↓",
        "                 Incident Detection",
        "                         │",
        "          ┌──────────────┼──────────────┐",
        "          ↓              ↓              ↓",
        "       Logs           Crashes          Metrics",
        "          │              │              │",
        "          └──────────────┼──────────────┘",
        "                         ↓",
        "                 Correlation Engine",
        "                         ↓",
        "                  Root Cause Analysis",
        "                         ↓",
        "                  Blast-Radius Analysis",
        "                         ↓",
        "                  Regression Detection",
        "                         ↓",
        "                 Fix / Rollback Plan",
        "                         ↓",
        "                    Validation",
        "                         ↓",
        "                  Incident Report",
      ].join("\n"),
    );
  });

  it("does not treat a local crash as a production incident", () => {
    const detection = detectIncident({
      bug: { repoPath: "/tmp", message: "TypeError: Cannot read properties of undefined (reading 'id')" },
      logAnalysis: logs,
    });
    expect(detection.detected).toBe(false);
    expect(investigateProductionIncident({ bug: { repoPath: "/tmp" }, logAnalysis: logs })).toBeUndefined();
  });

  it("detects from Crashlytics + metrics, correlates deploy, and plans a rollback", () => {
    const bug = {
      repoPath: "/tmp",
      version: "1.0.181",
      affectedUsers: 327,
      firstSeen: "14:32 UTC",
      incidentSource: "crashlytics" as const,
      extraContext: "errorRate: 4.2%\nbaseline: 0.4%\np95: 1800ms\ncrash-free users: 97.1%\ncrashes: 84\nrequests: 12000",
    };
    const metrics = parseProductionMetrics(bug.extraContext);
    expect(metrics?.errorRate).toBeCloseTo(0.042);
    expect(metrics?.latencyP95Ms).toBe(1800);
    expect(metrics?.crashFreeUsers).toBeCloseTo(0.971);

    const detection = detectIncident({ bug, logAnalysis: logs, metrics });
    expect(detection.detected).toBe(true);
    expect(detection.severity).toBe("sev-1");
    expect(detection.signals.some((signal) => signal.kind === "log")).toBe(true);
    expect(detection.signals.some((signal) => signal.kind === "crash")).toBe(true);
    expect(detection.signals.some((signal) => signal.kind === "metric")).toBe(true);

    const correlation = correlateIncident({ bug, logAnalysis: logs, gitInvestigation: git, metrics });
    expect(correlation.correlated).toBe(true);
    expect(correlation.deploy?.version).toBe("1.0.181");
    expect(correlation.links.some((link) => link.left === "metrics" && link.right === "deploy")).toBe(true);

    const plan = buildRollbackPlan({
      bug,
      gitInvestigation: git,
      blastRadius: {
        question: "What else could this change break?",
        origin: "FirebaseBoot",
        usedBy: [],
        high: ["Savings screen"],
        low: ["Media screen"],
        summary: "HIGH Savings screen",
      },
    });
    expect(plan.action).toBe("rollback");
    expect(plan.target).toBe("1.0.180");
    expect(plan.steps[0]).toMatch(/abc1234/);
    expect(plan.risks).toContain("HIGH Savings screen");

    const investigation = investigateProductionIncident({
      bug,
      logAnalysis: logs,
      gitInvestigation: git,
    });
    expect(investigation?.rollbackPlan.action).toBe("rollback");
    const ascii = renderProductionInvestigatorAscii(investigation);
    expect(ascii).toContain("PRODUCTION INCIDENT");
    expect(ascii).toContain("Incident Detection");
    expect(ascii).toContain("Correlation Engine");
    expect(ascii).toContain("Crash spike");
    expect(ascii).toContain("API latency spike");
    expect(ascii).toContain("Potential incident");
    expect(ascii).toContain("Fix / Rollback Plan");
    expect(ascii).toContain("Incident Report");
    expect(ascii).toContain("Rollback / hotfix");
  });

  it("lets Incident Agent include correlation and the rollback plan", async () => {
    const investigation = investigateProductionIncident({
      bug: {
        repoPath: "/tmp",
        version: "1.0.181",
        affectedUsers: 327,
        firstSeen: "14:32 UTC",
        incidentSource: "crashlytics",
      },
      logAnalysis: logs,
      gitInvestigation: git,
    });
    const { result } = await new IncidentAgent().run({
      input: {
        repoPath: "/tmp",
        version: "1.0.181",
        affectedUsers: 327,
        firstSeen: "14:32 UTC",
        incidentSource: "crashlytics",
        message: "Firebase initialization failed",
      },
      logAnalysis: logs,
      gitInvestigation: git,
      investigation,
    });
    expect(result.body).toContain("### Correlation");
    expect(result.body).toContain("### Fix / Rollback Plan");
    expect(result.timeline.some((event) => event.label === "Correlated")).toBe(true);
  });

  it("connects crash spike, latency, deploy, new dependency, and app version", () => {
    const correlation = correlateIncident({
      bug: {
        repoPath: "/tmp",
        version: "1.0.181",
        extraContext: [
          "crash spike",
          "API latency spike",
          "p95: 1800ms",
          "deployment 15 minutes earlier",
          "new dependency firebase_core",
        ].join("\n"),
      },
      logAnalysis: logs,
      gitInvestigation: git,
      metrics: {
        crashes: 84,
        requests: 12_000,
        latencyP95Ms: 1800,
        errorRate: 0.042,
        deployedMinutesAgo: 15,
        newDependency: "firebase_core",
      },
      dependencyAnalysis: {
        evidence: { hits: [{ name: "firebase_core", version: "3.4.0", source: "pubspec.yaml" }] },
        issues: [{ kind: "version-mismatch", package: "firebase_core", detail: "Newly bumped", likelihood: 0.8 }],
        likelyDependencyBug: true,
        summary: "firebase_core was bumped",
        handoff: [],
      },
    });
    expect(correlation.potentialIncident).toBe(true);
    expect(correlation.events.filter((event) => event.present).map((event) => event.kind)).toEqual([
      "crash-spike",
      "latency-spike",
      "deployment",
      "new-dependency",
      "app-version",
    ]);
    expect(correlation.deploy?.minutesBefore).toBe(15);
    expect(correlation.newDependency).toBe("firebase_core");
    expect(renderCorrelationAscii(correlation)).toContain(
      [
        "Crash spike",
        "   +",
        "API latency spike",
        "   +",
        "Deployment 15 minutes earlier",
        "   +",
        "New dependency",
        "   +",
        "Specific app version",
        "        ↓",
        "Potential incident",
      ].join("\n"),
    );
  });
});
