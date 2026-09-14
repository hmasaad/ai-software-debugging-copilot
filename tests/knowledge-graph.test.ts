import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  KNOWLEDGE_GRAPH_FLOW,
  buildKnowledgeGraph,
  renderKnowledgeGraphAscii,
  similarIncidentsLine,
} from "../src/analysis/knowledge-graph.js";
import { recallIncidents, rememberIncident } from "../src/analysis/memory.js";
import type { BlastRadiusAnalysis, GitInvestigation, LogAnalysis, RootCauseAnalysis, ValidationAnalysis } from "../src/types.js";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const FLOW = [
  "Incident",
  "   ↓",
  "Root Cause",
  "   ↓",
  "Commit",
  "   ↓",
  "Fix",
  "   ↓",
  "Affected Components",
  "   ↓",
  "Resolution",
].join("\n");

const incident = {
  errorType: "NullCheckError",
  errorMessage: "Null check operator used on a null value",
  category: "runtime-crash" as const,
  rootCause: "Null API response",
  fix: "Handle null",
  resolution: "resolved",
  files: ["lib/savings/SavingsMemberMediaBloc.dart"],
  commit: "8f31a2c Firebase initialization change",
  components: ["Savings screen", "SavingsRepository"],
};

const error: LogAnalysis["error"] = {
  type: "NullCheckError",
  message: "Null check operator used on a null value",
  frames: [],
};

const rootCause: RootCauseAnalysis = {
  summary: "Null API response",
  rootCause: "Null API response",
  confidence: 0.9,
  hypotheses: [],
  affectedFiles: incident.files,
  reproSteps: [],
  investigator: "heuristic",
};

const git: GitInvestigation = {
  evidence: { available: true, recentCommits: [], commitsTouchingSuspects: [], blame: [] },
  pullRequests: [],
  suspects: [],
  introducing: {
    sha: "8f31a2cdef",
    author: "Developer",
    date: "2026-09-11",
    subject: "Firebase initialization change",
    score: 0.9,
    reasons: ["blame"],
  },
  summary: "Likely introduced by 8f31a2c",
  handoff: [],
};

const blastRadius: BlastRadiusAnalysis = {
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
  question: "What else could this affect?",
  summary: "HIGH",
};

const validation: ValidationAnalysis = {
  verdict: "likely-resolved",
  resolved: true,
  checks: [],
  residualRisks: [],
  summary: "resolved",
  handoff: [],
};

describe("debugging knowledge graph", () => {
  it("locks the incident → resolution chain", () => {
    expect(KNOWLEDGE_GRAPH_FLOW).toBe(FLOW);
    expect(renderKnowledgeGraphAscii()).toBe(FLOW);
  });

  it("says a future incident looks similar to 3 previous incidents", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "debug-knowledge-"));
    fixtures.push(dir);
    for (let index = 0; index < 3; index += 1) {
      await rememberIncident({ repoPath: dir, ...incident });
    }
    const memory = await recallIncidents({
      repoPath: dir,
      errorType: incident.errorType,
      errorMessage: incident.errorMessage,
      category: incident.category,
      files: incident.files,
    });
    expect(memory.matches).toHaveLength(3);
    const graph = buildKnowledgeGraph({
      error,
      rootCause,
      gitInvestigation: git,
      blastRadius,
      fix: { summary: "Handle null" },
      validation,
      memory,
    });
    expect(graph.similarCount).toBe(3);
    expect(graph.summary).toBe("This looks similar to 3 previous incidents.");
    expect(similarIncidentsLine(3)).toBe("This looks similar to 3 previous incidents.");
    expect(graph.nodes.map((node) => node.label)).toEqual([
      "Incident",
      "Root Cause",
      "Commit",
      "Fix",
      "Affected Components",
      "Resolution",
    ]);
    expect(graph.nodes.find((node) => node.kind === "incident")?.detail).toContain("NullCheckError");
    expect(graph.nodes.find((node) => node.kind === "root-cause")?.detail).toBe("Null API response");
    expect(graph.nodes.find((node) => node.kind === "commit")?.detail).toBe("8f31a2cd Firebase initialization change");
    expect(graph.nodes.find((node) => node.kind === "fix")?.detail).toBe("Handle null");
    expect(graph.nodes.find((node) => node.kind === "affected-components")?.detail).toContain("Savings screen");
    expect(graph.nodes.find((node) => node.kind === "resolution")?.detail).toBe("resolved");
    expect(renderKnowledgeGraphAscii(graph)).toBe(
      [
        ...FLOW.split("\n"),
        "",
        "Incident: NullCheckError: Null check operator used on a null value",
        "Root Cause: Null API response",
        "Commit: 8f31a2cd Firebase initialization change",
        "Fix: Handle null",
        "Affected Components: Savings screen, SavingsRepository",
        "Resolution: resolved",
        "",
        "This looks similar to 3 previous incidents.",
      ].join("\n"),
    );
  });

  it("stores commit and components on remembered incidents", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "debug-knowledge-store-"));
    fixtures.push(dir);
    const memory = await rememberIncident({ repoPath: dir, ...incident });
    expect(memory.latest?.commit).toBe(incident.commit);
    expect(memory.latest?.components).toEqual(incident.components);
  });

  it("reports no similar previous incidents on a first-seen crash", () => {
    const graph = buildKnowledgeGraph({
      error,
      rootCause,
      gitInvestigation: git,
      blastRadius,
      fix: { summary: "Handle null" },
      validation,
      memory: { stored: false, matches: [], summary: "No similar historical incidents." },
    });
    expect(graph.similarCount).toBe(0);
    expect(graph.summary).toBe("No similar previous incidents.");
    expect(renderKnowledgeGraphAscii(graph)).toContain("No similar previous incidents.");
    expect(renderKnowledgeGraphAscii(graph)).not.toContain("This looks similar to");
  });
});
