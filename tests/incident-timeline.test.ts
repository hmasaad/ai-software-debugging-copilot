import { describe, expect, it } from "vitest";
import { buildIncidentTimeline, renderIncidentTimelineAscii } from "../src/analysis/incident-timeline.js";
import type { FixAnalysis, GitInvestigation, ValidationAnalysis } from "../src/types.js";

const LOCKED = [
  "14:02  Deployment started",
  "14:07  Deployment completed",
  "14:11  Error rate increased",
  "14:13  Crash threshold exceeded",
  "14:15  First customer impact detected",
  "14:18  Regression identified",
  "14:23  Fix generated",
  "14:27  Fix validated",
].join("\n");

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

const fixAnalysis: FixAnalysis = {
  proposal: {
    summary: "Guard Firebase init",
    rationale: "",
    edits: [{ path: "lib/firebase.dart", oldString: "init()", newString: "init()!" }],
    testPlan: [],
    risks: [],
    applied: false,
    applyErrors: [],
  },
  strategy: "investigator",
  source: "heuristic",
  summary: "Guard Firebase init",
  handoff: [],
};

const validation: ValidationAnalysis = {
  verdict: "resolved",
  resolved: true,
  checks: [],
  residualRisks: [],
  summary: "Fix validated",
  handoff: [],
};

describe("incident timeline", () => {
  it("reconstructs the 14:02–14:27 production clock", () => {
    const timeline = buildIncidentTimeline({
      bug: {
        repoPath: "/tmp",
        version: "1.0.181",
        affectedUsers: 327,
        firstSeen: "14:15",
        incidentSource: "crashlytics",
      },
      metrics: {
        errorRate: 0.042,
        baselineErrorRate: 0.004,
        crashes: 84,
        crashFreeUsers: 0.971,
        deployedMinutesAgo: 13,
      },
      gitInvestigation: git,
      fixAnalysis,
      validation,
    });
    expect(renderIncidentTimelineAscii(timeline)).toBe(LOCKED);
    expect(timeline?.impactAt).toBe("14:15");
  });

  it("keeps reported clock times when the incident already logged them", () => {
    const timeline = buildIncidentTimeline({
      bug: {
        repoPath: "/tmp",
        extraContext: LOCKED,
      },
    });
    expect(renderIncidentTimelineAscii(timeline)).toBe(LOCKED);
  });

  it("omits fix validation until the patch is confirmed", () => {
    const timeline = buildIncidentTimeline({
      bug: { repoPath: "/tmp", firstSeen: "14:15", affectedUsers: 12, incidentSource: "logs" },
      metrics: { errorRate: 0.05, crashes: 3, deployedMinutesAgo: 13 },
      gitInvestigation: git,
      fixAnalysis,
    });
    const ascii = renderIncidentTimelineAscii(timeline);
    expect(ascii).toContain("14:23  Fix generated");
    expect(ascii).not.toContain("Fix validated");
  });

  it("does not invent a clock without first-seen, logs, or reported times", () => {
    expect(buildIncidentTimeline({ gitInvestigation: git, fixAnalysis })).toBeUndefined();
  });
});
