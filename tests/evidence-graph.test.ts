import { describe, expect, it } from "vitest";
import { buildEvidenceGraph, renderEvidenceGraphAscii } from "../src/analysis/evidence-graph.js";
import type { LogAnalysis } from "../src/types.js";

const flutterLog: LogAnalysis = {
  error: {
    type: "NullCheckError",
    message: "Null check operator used on a null value",
    frames: [
      {
        file: "lib/savings/SavingsMemberMediaBloc.dart",
        line: 217,
        functionName: "SavingsMemberMediaBloc._onLoad",
        raw: "SavingsMemberMediaBloc.dart:217",
        inProject: true,
      },
    ],
    language: "dart",
  },
  logs: { sources: [], excerpt: "" },
  crashSite: {
    file: "lib/savings/SavingsMemberMediaBloc.dart",
    line: 217,
    functionName: "SavingsMemberMediaBloc._onLoad",
    raw: "SavingsMemberMediaBloc.dart:217",
    inProject: true,
  },
  exceptionChain: [],
  logLevels: { fatal: 0, error: 1, warn: 0, info: 0, debug: 0 },
  timestamps: [],
  correlationIds: [],
  repeating: [],
  summary: "Null check at SavingsMemberMediaBloc.dart:217",
  handoff: [],
};

describe("evidence graph", () => {
  it("chains crash → bloc → repository → API → null → commit → PR", () => {
    const graph = buildEvidenceGraph({
      logAnalysis: flutterLog,
      codeInvestigation: {
        origin: flutterLog.crashSite,
        trace: [
          {
            file: "lib/savings/SavingsMemberMediaBloc.dart",
            line: 217,
            functionName: "SavingsMemberMediaBloc._onLoad",
            role: "crash-site",
            expression: "final media = getSavingsMedia()!;",
            note: "Unguarded access at SavingsMemberMediaBloc.dart:217",
          },
          {
            file: "lib/savings/savings_repository.dart",
            line: 40,
            functionName: "getSavingsMedia",
            role: "callee",
            note: "Crash line calls getSavingsMedia, defined at savings_repository.dart:40.",
          },
        ],
        functions: [],
        callers: [],
        suspects: ["getSavingsMedia", "media"],
        snippets: [],
        summary: "Traced crash to SavingsMemberMediaBloc.dart:217",
        handoff: [],
      },
      gitInvestigation: {
        evidence: { available: true, recentCommits: [], commitsTouchingSuspects: [], blame: [] },
        pullRequests: [
          {
            number: 421,
            title: "Savings media",
            url: "https://example/421",
            state: "merged",
            overlap: ["lib/savings/savings_repository.dart"],
          },
        ],
        suspects: [],
        introducing: {
          sha: "abc1234deadbeef",
          author: "Ada",
          date: "2026-09-10",
          subject: "Assume savings media always exists",
          score: 0.9,
          reasons: ["git blame on line 217"],
        },
        summary: "Likely introduced by abc1234",
        handoff: [],
      },
      reproduction: {
        result: {
          attempted: true,
          reproduced: true,
          command: "flutter test",
          output: "Null check operator used on a null value",
          summary: "Reproduced via flutter test.",
        },
        method: "generated-test",
        relatedTests: [],
        steps: [],
        symptoms: {
          summary: "Null check operator",
          errorMessage: "Null check operator used on a null value",
          signals: ["null-deref", "flutter"],
        },
        scenario: {
          title: "should handle null savings member media response",
          setup: [],
          action: "Run flutter test",
          expectedFailure: "Null check operator used on a null value",
        },
        match: "matched",
        matchDetail: "Captured failure matches the report.",
        confidence: 0.92,
        summary: "Issue reproduced.",
        handoff: [],
      },
      leading: {
        id: "H1",
        kind: "null-deref",
        description: "Null/undefined value reached a dereference.",
        evidence: [],
        likelihood: 0.78,
      },
      confidence: 0.9,
    });

    expect(graph.nodes.map((node) => node.label)).toEqual([
      "NullCheckError",
      "SavingsMemberMediaBloc",
      "Repository",
      "API Response",
      "null value",
      "Commit abc1234",
      "PR #421",
    ]);
    expect(graph.claim).toBe("Null API response");
    expect(graph.supporting.filter((check) => check.present && check.supports).map((check) => check.label)).toEqual([
      "Stack trace",
      "Source code",
      "API response",
      "Git commit",
      "Reproduction",
    ]);
    expect(graph.contradicting).toEqual([]);

    const ascii = renderEvidenceGraphAscii(graph);
    expect(ascii).toContain("SavingsMemberMediaBloc");
    expect(ascii).toContain("Root Cause: Null API response");
    expect(ascii).toContain("✓ Stack trace");
    expect(ascii).toContain("Contradicting evidence:\nNone");
  });

  it("records contradicting evidence when the bug does not reproduce", () => {
    const graph = buildEvidenceGraph({
      logAnalysis: flutterLog,
      leading: {
        id: "H1",
        kind: "unreproducible",
        description: "Could not reproduce locally.",
        evidence: [],
        likelihood: 0.45,
      },
      confidence: 0.4,
      reproduction: {
        result: {
          attempted: true,
          reproduced: false,
          output: "",
          summary: "flutter test exited 0.",
        },
        method: "test-suite",
        relatedTests: [],
        steps: [],
        symptoms: {
          summary: "Null check",
          errorMessage: "Null check operator used on a null value",
          signals: ["null-deref"],
        },
        scenario: { title: "repro", setup: [], action: "test", expectedFailure: "null" },
        match: "unmatched",
        matchDetail: "Command succeeded.",
        confidence: 0.28,
        summary: "Could not reproduce.",
        handoff: [],
      },
    });

    expect(graph.contradicting.some((check) => check.id === "not-reproduced")).toBe(true);
    expect(renderEvidenceGraphAscii(graph)).toContain("Could not reproduce locally");
  });
});
