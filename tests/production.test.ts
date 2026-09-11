import { describe, expect, it } from "vitest";
import { IncidentAgent } from "../src/agents/incident-agent.js";
import {
  buildProductionIncident,
  crashFingerprint,
  parseProductionSignals,
  renderProductionIncidentAscii,
} from "../src/analysis/production.js";
import type { DebuggingMemory, GitInvestigation } from "../src/types.js";

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

describe("production incident mode", () => {
  it("parses Crashlytics / Sentry / log payloads", () => {
    expect(
      parseProductionSignals("Version: 1.0.181\nAffected users: 327\nFirst seen: 14:32 UTC\nsource: crashlytics"),
    ).toEqual({
      version: "1.0.181",
      affectedUsers: 327,
      firstSeen: "14:32 UTC",
      incidentSource: "crashlytics",
    });
    expect(
      parseProductionSignals(JSON.stringify({ release: "1.0.181", userCount: 327, firstSeen: "14:32 UTC", logger: "sentry" })),
    ).toMatchObject({
      version: "1.0.181",
      affectedUsers: 327,
      firstSeen: "14:32 UTC",
      incidentSource: "sentry",
    });
  });

  it("prints the production crash card and recommends rollback", () => {
    const incident = buildProductionIncident({
      bug: {
        repoPath: "/tmp",
        version: "1.0.181",
        affectedUsers: 327,
        firstSeen: "14:32 UTC",
        incidentSource: "crashlytics",
      },
      gitInvestigation: git,
    });
    expect(incident?.recommendedAction).toBe("rollback");
    expect(Math.round((incident?.confidence ?? 0) * 100)).toBe(91);
    expect(incident?.likelyCause).toBe("Recent Firebase initialization change");
    expect(renderProductionIncidentAscii(incident!)).toBe(
      [
        "Production Crash",
        "",
        "Version: 1.0.181",
        "Affected users: 327",
        "First seen: 14:32 UTC",
        "",
        "Likely cause:",
        "Recent Firebase initialization change",
        "",
        "Confidence: 91%",
        "",
        "Recommended action:",
        "Rollback / hotfix",
      ].join("\n"),
    );
  });

  it("groups similar crashes from debugging memory", () => {
    const memory: DebuggingMemory = {
      stored: true,
      matches: [
        {
          entry: {
            id: "1",
            createdAt: "2026-09-01T00:00:00.000Z",
            errorType: "FirebaseException",
            errorMessage: "Firebase initialization failed",
            category: "runtime-crash",
            rootCause: "Bad Firebase init",
            fix: "Guard init",
            resolution: "hotfixed",
            files: ["lib/firebase.dart"],
          },
          score: 0.8,
        },
        {
          entry: {
            id: "2",
            createdAt: "2026-09-08T00:00:00.000Z",
            errorType: "FirebaseException",
            errorMessage: "Firebase initialization failed",
            category: "runtime-crash",
            rootCause: "Bad Firebase init",
            fix: "Guard init",
            resolution: "hotfixed",
            files: ["lib/firebase.dart"],
          },
          score: 0.7,
        },
      ],
      summary: "2 previous incidents had the same pattern",
    };
    const incident = buildProductionIncident({
      bug: {
        repoPath: "/tmp",
        extraContext: "Version: 1.0.181\nAffected users: 12\nFirst seen: 10:00 UTC\nsource: sentry",
      },
      gitInvestigation: git,
      memory,
      suggestedFix: "Guard Firebase.initializeApp against a null options payload.",
    });
    expect(incident?.groupedCount).toBe(2);
    expect(incident?.source).toBe("sentry");
    expect(incident?.suggestedFix).toMatch(/Firebase/);
    expect(renderProductionIncidentAscii(incident!)).toContain("Similar crashes: 2");
  });

  it("lets Incident Agent own the production flow", async () => {
    const { result } = await new IncidentAgent().run({
      input: {
        repoPath: "/tmp",
        version: "1.0.181",
        affectedUsers: 327,
        firstSeen: "14:32 UTC",
        incidentSource: "crashlytics",
        message: "Firebase initialization failed",
      },
      logAnalysis: {
        error: { type: "FirebaseException", message: "Firebase initialization failed", frames: [] },
        logs: { sources: ["crashlytics"], excerpt: "" },
        crashSite: { file: "lib/firebase.dart", line: 12, raw: "", inProject: true },
        exceptionChain: [],
        logLevels: { fatal: 1, error: 0, warn: 0, info: 0, debug: 0 },
        timestamps: [],
        correlationIds: [],
        repeating: [],
        summary: "Firebase crash",
        handoff: [],
      },
      gitInvestigation: git,
      rootCause: {
        summary: "",
        rootCause: "Firebase initialization assumed a valid options object.",
        confidence: 0.8,
        hypotheses: [],
        affectedFiles: ["lib/firebase.dart"],
        reproSteps: [],
        investigator: "heuristic",
      },
      fixAnalysis: {
        proposal: {
          summary: "Guard Firebase initialization",
          rationale: "",
          edits: [],
          testPlan: [],
          risks: [],
          applied: false,
          applyErrors: [],
        },
        strategy: "none",
        source: "heuristic",
        summary: "No application patch yet.",
        handoff: [],
      },
    });
    expect(result.severity).toBe("sev-1");
    expect(result.production?.version).toBe("1.0.181");
    expect(result.production?.recommendedAction).toBe("rollback");
    expect(result.body).toContain("### Production");
    expect(result.timeline.some((event) => event.label === "Production")).toBe(true);
    expect(crashFingerprint({ errorType: "FirebaseException", errorMessage: "Firebase initialization failed", file: "lib/firebase.dart" })).toContain("firebase.dart");
  });
});
