import { describe, expect, it } from "vitest";
import {
  collectCorrelationEvents,
  correlateIncident,
  isPotentialIncident,
  renderCorrelationAscii,
} from "../src/analysis/correlation-engine.js";
import { parseProductionMetrics } from "../src/analysis/incident-investigator.js";
import type { GitInvestigation } from "../src/types.js";

const git: GitInvestigation = {
  evidence: { available: true, recentCommits: [], commitsTouchingSuspects: [], blame: [] },
  pullRequests: [],
  suspects: [],
  introducing: {
    sha: "abc1234",
    author: "Dev",
    date: "2026-09-11T14:17:00Z",
    subject: "chore(deps): bump firebase_core",
    score: 0.9,
    reasons: ["blame"],
  },
  summary: "Likely introduced by abc1234",
  handoff: [],
};

describe("incident correlation engine", () => {
  it("connects crash, latency, deploy, dependency, and version into a potential incident", () => {
    const extraContext = [
      "Crash spike",
      "API latency spike",
      "Deployment 15 minutes earlier",
      "New dependency firebase_core",
      "version: 1.0.181",
      "p95: 1800ms",
      "crashes: 84",
    ].join("\n");
    const bug = { repoPath: "/tmp", extraContext, version: "1.0.181" };
    const metrics = parseProductionMetrics(extraContext);
    const correlation = correlateIncident({
      bug,
      metrics,
      gitInvestigation: git,
      logAnalysis: {
        error: { type: "FirebaseException", message: "Firebase initialization failed", frames: [] },
        logs: { sources: ["crashlytics"], excerpt: "" },
        crashSite: { file: "lib/firebase.dart", line: 12, raw: "", inProject: true },
        exceptionChain: [],
        logLevels: { fatal: 4, error: 20, warn: 0, info: 0, debug: 0 },
        timestamps: ["2026-09-11T14:32:00Z"],
        correlationIds: [],
        repeating: [],
        summary: "Firebase crash spike",
        handoff: [],
      },
    });

    expect(correlation.potentialIncident).toBe(true);
    expect(correlation.correlated).toBe(true);
    expect(correlation.deploy?.minutesBefore).toBe(15);
    expect(correlation.newDependency).toBe("firebase_core");
    expect(correlation.events.filter((event) => event.present).map((event) => event.label)).toEqual([
      "Crash spike",
      "API latency spike",
      "Deployment 15 minutes earlier",
      "New dependency",
      "Specific app version",
    ]);
    expect(renderCorrelationAscii(correlation)).toBe(
      [
        "Correlation Engine",
        "",
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
        "",
        "Potential incident: Crash spike, API latency spike, Deployment 15 minutes earlier, New dependency, and Specific app version.",
      ].join("\n"),
    );
  });

  it("does not declare a potential incident from a single crash", () => {
    const events = collectCorrelationEvents({
      bug: { repoPath: "/tmp", message: "TypeError: Cannot read properties of undefined (reading 'id')" },
      blob: "TypeError: Cannot read properties of undefined (reading 'id')",
    });
    expect(isPotentialIncident(events)).toBe(false);
    expect(renderCorrelationAscii({ events, links: [], correlated: false, potentialIncident: false, summary: "none" })).toContain(
      "No overlapping signals yet.",
    );
  });
});
