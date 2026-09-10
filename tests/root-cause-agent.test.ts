import { describe, expect, it } from "vitest";
import { rankCauses, RootCauseAgent } from "../src/agents/root-cause-agent.js";
import { ROOT_CAUSE_AGENT } from "../src/agents/types.js";
import type { LogAnalysis } from "../src/types.js";

const crashLog: LogAnalysis = {
  error: {
    type: "TypeError",
    message: "Cannot read properties of undefined (reading 'id')",
    frames: [
      { file: "src/cart.js", line: 16, functionName: "getPrimaryItemId", raw: "at getPrimaryItemId", inProject: true },
    ],
  },
  logs: { sources: [], excerpt: "" },
  crashSite: { file: "src/cart.js", line: 16, functionName: "getPrimaryItemId", raw: "at getPrimaryItemId", inProject: true },
  exceptionChain: [],
  logLevels: { fatal: 0, error: 1, warn: 0, info: 0, debug: 0 },
  timestamps: [],
  correlationIds: [],
  repeating: [],
  summary: "TypeError at src/cart.js:16",
  handoff: [],
};

describe("Root Cause Agent", () => {
  it("exposes the core-agent contract", () => {
    const agent = new RootCauseAgent();
    expect(agent.id).toBe("root-cause-agent");
    expect(agent.name).toBe(ROOT_CAUSE_AGENT.name);
    expect(agent.responsibility).toBe("Build an evidence graph and rank possible causes");
  });

  it("ranks an unguarded null deref above the crash-site frame", () => {
    const ranked = rankCauses({
      logAnalysis: crashLog,
      codeInvestigation: {
        origin: crashLog.crashSite,
        trace: [
          {
            file: "src/cart.js",
            line: 16,
            functionName: "getPrimaryItemId",
            role: "crash-site",
            expression: "return order.item.id;",
            note: "Unguarded access at src/cart.js:16 in getPrimaryItemId: return order.item.id;",
          },
        ],
        functions: [],
        callers: [],
        suspects: ["order", "item", "id"],
        snippets: [],
        summary: "Traced crash to src/cart.js:16",
        handoff: [],
      },
    });

    expect(ranked.leading?.kind).toBe("null-deref");
    expect(ranked.causes.some((cause) => cause.kind === "crash-site")).toBe(true);
    expect(ranked.confidence).toBeGreaterThan(0.5);
    expect(ranked.graph.claim).toMatch(/null|undefined/i);
    expect(ranked.graph.nodes.some((node) => node.kind === "crash")).toBe(true);
    expect(ranked.graph.nodes.some((node) => /getPrimaryItemId|cart/i.test(node.label))).toBe(true);
    expect(ranked.graph.supporting.some((check) => check.label === "Stack trace" && check.supports)).toBe(true);
    expect(ranked.graph.contradicting).toEqual([]);
  });

  it("promotes a likely dependency issue over application-code hypotheses", () => {
    const ranked = rankCauses({
      logAnalysis: {
        ...crashLog,
        error: { type: "Error", message: "Cannot find module 'left-pad'", frames: [] },
        crashSite: undefined,
        summary: "missing module",
      },
      dependencyAnalysis: {
        evidence: { ecosystem: "node", hits: [] },
        issues: [
          { kind: "missing-module", package: "left-pad", detail: "left-pad is not resolvable", likelihood: 0.88 },
        ],
        likelyDependencyBug: true,
        summary: "Likely missing-module in left-pad",
        handoff: [],
      },
    });

    expect(ranked.leading?.kind).toBe("dependency");
    expect(ranked.handoff.some((note) => /install\/version/i.test(note))).toBe(true);
  });

  it("includes an introducing-commit cause from Git Investigator", () => {
    const ranked = rankCauses({
      logAnalysis: crashLog,
      gitInvestigation: {
        evidence: { available: true, recentCommits: [], commitsTouchingSuspects: [], blame: [] },
        pullRequests: [],
        suspects: [],
        introducing: {
          sha: "deadbeef1111",
          author: "Ada",
          date: "2026-09-10",
          subject: "unguarded item.id access",
          score: 0.9,
          reasons: ["git blame on src/cart.js:16"],
        },
        summary: "Likely introduced by deadbeef",
        handoff: [],
      },
    });

    expect(ranked.causes.some((cause) => cause.kind === "introducing-commit")).toBe(true);
  });
});
