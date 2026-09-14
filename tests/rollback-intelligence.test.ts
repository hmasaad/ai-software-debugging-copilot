import { describe, expect, it } from "vitest";
import { scoreFixRisk } from "../src/analysis/fix-risk.js";
import {
  ROLLBACK_INTELLIGENCE_FLOW,
  buildRollbackIntelligence,
  renderRollbackIntelligenceAscii,
} from "../src/analysis/rollback-intelligence.js";
import type { FixAnalysis, GitInvestigation } from "../src/types.js";

const FLOW = [
  "Incident",
  "   ↓",
  "Can safely patch?",
  " ├── YES → Patch",
  " │",
  " └── NO",
  "      ↓",
  "   Rollback?",
  "      ↓",
  "   Feature flag?",
  "      ↓",
  "   Configuration change?",
  "      ↓",
  "   Disable affected functionality?",
].join("\n");

const git: GitInvestigation = {
  evidence: { available: true, recentCommits: [], commitsTouchingSuspects: [], blame: [] },
  pullRequests: [],
  suspects: [],
  introducing: {
    sha: "abc1234def",
    author: "Dev",
    date: "2026-09-10",
    subject: "Firebase initialization change",
    score: 0.9,
    reasons: ["blame"],
  },
  firstBadVersion: {
    lastHealthy: "1.0.180",
    firstBad: "1.0.181",
    laterBad: [],
    versions: [
      { version: "1.0.180", status: "healthy" },
      { version: "1.0.181", status: "crashes" },
    ],
    commits: [],
    commitCount: 12,
    summary: "v1.0.181 is the first known bad version",
  },
  summary: "Likely introduced by abc1234",
  handoff: [],
};

const highFiles = [
  "lib/savings/a.dart",
  "lib/savings/b.dart",
  "lib/reports/c.dart",
  "lib/reports/d.dart",
  "lib/shareout/e.dart",
  "lib/shareout/f.dart",
  "lib/media/g.dart",
];

function fixOf(files: string[], strategy: FixAnalysis["strategy"] = "investigator"): FixAnalysis {
  const risk = scoreFixRisk({
    files,
    tests: files.length > 2 ? 43 : 1,
    strategy: strategy === "optional-chain" || strategy === "nullish-default" ? strategy : undefined,
  });
  return {
    proposal: {
      summary: "candidate patch",
      rationale: "",
      edits: files.map((path) => ({ path, oldString: "a", newString: "b" })),
      testPlan: [],
      risks: [],
      applied: false,
      applyErrors: [],
    },
    strategy,
    source: "heuristic",
    summary: "candidate patch",
    handoff: [],
    risk,
  };
}

describe("rollback intelligence", () => {
  it("locks the production mitigation tree", () => {
    expect(ROLLBACK_INTELLIGENCE_FLOW).toBe(FLOW);
  });

  it("prefers a small local patch when the change is safe", () => {
    const analysis = buildRollbackIntelligence({
      fixAnalysis: fixOf(["src/cart.js"], "optional-chain"),
    });
    expect(analysis.canSafelyPatch).toBe(true);
    expect(analysis.action).toBe("patch");
    expect(renderRollbackIntelligenceAscii(analysis)).toBe(
      [
        FLOW,
        "",
        "Can safely patch: YES",
        "Recommended: Patch",
        "Target: src/cart.js",
        "Reason: Smallest safe code fix is available.",
      ].join("\n"),
    );
  });

  it("rolls back a production incident instead of patching", () => {
    const analysis = buildRollbackIntelligence({
      bug: { repoPath: "/tmp", version: "1.0.181", affectedUsers: 327, incidentSource: "crashlytics" },
      gitInvestigation: git,
      fixAnalysis: fixOf(["lib/firebase.dart"], "optional-chain"),
    });
    expect(analysis.canSafelyPatch).toBe(false);
    expect(analysis.action).toBe("rollback");
    expect(analysis.target).toBe("1.0.180");
    expect(renderRollbackIntelligenceAscii(analysis)).toBe(
      [
        FLOW,
        "",
        "Can safely patch: NO",
        "Recommended: Rollback",
        "Target: 1.0.180",
        "Reason: 327 users after a known-bad deploy. Do not ship a code patch first.",
        "Then: Feature flag → Configuration change → Disable affected functionality",
      ].join("\n"),
    );
  });

  it("turns off a feature flag when a wide patch is unsafe and rollback is unavailable", () => {
    const analysis = buildRollbackIntelligence({
      bug: { repoPath: "/tmp", extraContext: "feature flag savings_v2" },
      fixAnalysis: fixOf(highFiles),
    });
    expect(analysis.canSafelyPatch).toBe(false);
    expect(analysis.action).toBe("feature-flag");
    expect(analysis.target).toBe("savings_v2");
    expect(renderRollbackIntelligenceAscii(analysis)).toContain("Recommended: Feature flag");
  });

  it("prefers a configuration change for toolchain drift", () => {
    const analysis = buildRollbackIntelligence({
      fixAnalysis: { ...fixOf([]), strategy: "environment-align", proposal: { ...fixOf([]).proposal, edits: [] } },
      environment: {
        local: { os: "darwin", arch: "arm64", cwd: "/tmp", ci: false, envHints: [] },
        localLabel: "CI",
        mismatches: [{ tool: "Flutter", expected: "3.24.0", actual: "3.19.0" }],
        summary: "Flutter mismatch",
      },
    });
    expect(analysis.canSafelyPatch).toBe(false);
    expect(analysis.action).toBe("configuration");
    expect(analysis.target).toContain("Flutter");
    expect(renderRollbackIntelligenceAscii(analysis)).toContain("Recommended: Configuration change");
  });

  it("disables the affected surface when no safer mitigation exists", () => {
    const analysis = buildRollbackIntelligence({
      fixAnalysis: fixOf(highFiles),
      blastRadius: {
        question: "What else could this affect?",
        origin: "SavingsRepository",
        usedBy: [],
        high: ["Savings screen"],
        low: [],
        direct: ["Savings screen"],
        indirect: ["Savings reports"],
        severity: "HIGH",
        workflowShare: 0.32,
        workflowLabel: "Savings workflows",
        layers: [],
        summary: "HIGH Savings screen",
      },
    });
    expect(analysis.canSafelyPatch).toBe(false);
    expect(analysis.action).toBe("disable");
    expect(analysis.target).toBe("Savings screen");
    expect(renderRollbackIntelligenceAscii(analysis)).toContain("Recommended: Disable affected functionality");
  });
});
