import path from "node:path";
import { moduleOf } from "./fix-risk.js";
import type {
  BlastRadiusAnalysis,
  DebuggingMemory,
  GitInvestigation,
  KnowledgeGraph,
  KnowledgeGraphKind,
  KnowledgeGraphNode,
  ParsedError,
  RootCauseAnalysis,
  ValidationAnalysis,
} from "../types.js";

const NODE_SPECS: Array<{ kind: KnowledgeGraphKind; label: string }> = [
  { kind: "incident", label: "Incident" },
  { kind: "root-cause", label: "Root Cause" },
  { kind: "commit", label: "Commit" },
  { kind: "fix", label: "Fix" },
  { kind: "affected-components", label: "Affected Components" },
  { kind: "resolution", label: "Resolution" },
];

export const KNOWLEDGE_GRAPH_FLOW = [
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

export function similarIncidentsLine(count: number): string {
  if (!count) return "No similar previous incidents.";
  return `This looks similar to ${count} previous incident${count === 1 ? "" : "s"}.`;
}

export function collectComponents(input: {
  blastRadius?: BlastRadiusAnalysis;
  files?: string[];
  stored?: string[];
}): string[] {
  const fromBlast: string[] = [];
  if (input.blastRadius?.direct) fromBlast.push(...input.blastRadius.direct);
  if (input.blastRadius?.origin && input.blastRadius.origin !== "unknown") {
    fromBlast.push(input.blastRadius.origin);
  }
  const named = unique(fromBlast);
  const fromFiles = (input.files ?? []).map(componentFromFile);
  const source = named.length ? named : unique(fromFiles);
  return unique([...source, ...(input.stored ?? [])]).slice(0, 8);
}

export function commitLabel(git?: GitInvestigation, stored?: string): string {
  const suspect = git?.introducing ?? git?.regression?.commit;
  if (suspect) return formatCommit(suspect.sha, suspect.subject);
  const bisect = git?.bisect?.firstBad;
  if (bisect) return formatCommit(bisect.sha, bisect.subject);
  const window = git?.firstBadVersion?.commits[0];
  if (window) return formatCommit(window.sha, window.subject);
  if (git?.firstBadVersion?.firstBad) return git.firstBadVersion.firstBad;
  if (stored?.trim()) return stored.trim();
  return "not yet identified";
}

export function buildKnowledgeGraph(input: {
  error?: ParsedError;
  rootCause?: RootCauseAnalysis;
  gitInvestigation?: GitInvestigation;
  blastRadius?: BlastRadiusAnalysis;
  fix?: { summary: string };
  validation?: ValidationAnalysis;
  memory?: DebuggingMemory;
}): KnowledgeGraph {
  const latest = input.memory?.latest;
  const files = input.rootCause?.affectedFiles?.length ? input.rootCause.affectedFiles : latest?.files;
  const components = collectComponents({
    blastRadius: input.blastRadius,
    files,
    stored: latest?.components,
  });
  const details: Record<KnowledgeGraphKind, string> = {
    incident: incidentLabel(input.error, latest),
    "root-cause": clip(input.rootCause?.rootCause ?? latest?.rootCause ?? "not yet identified"),
    commit: commitLabel(input.gitInvestigation, latest?.commit),
    fix: clip(input.fix?.summary ?? latest?.fix ?? "not yet identified"),
    "affected-components": components.join(", ") || "unknown",
    resolution: clip(input.validation?.summary ?? latest?.resolution ?? "open"),
  };
  const nodes: KnowledgeGraphNode[] = NODE_SPECS.map((spec) => ({
    kind: spec.kind,
    label: spec.label,
    detail: details[spec.kind],
  }));
  const similar = input.memory?.matches ?? [];
  const similarCount = similar.length;
  return {
    nodes,
    similarCount,
    similar,
    summary: similarIncidentsLine(similarCount),
  };
}

export function renderKnowledgeGraphAscii(graph?: KnowledgeGraph): string {
  if (!graph) return KNOWLEDGE_GRAPH_FLOW;
  return [
    KNOWLEDGE_GRAPH_FLOW,
    "",
    ...graph.nodes.map((node) => `${node.label}: ${node.detail}`),
    "",
    graph.summary,
  ].join("\n");
}

function incidentLabel(error?: ParsedError, latest?: { errorType?: string; errorMessage: string }): string {
  const type = error?.type ?? latest?.errorType ?? "Error";
  const message = error?.message ?? latest?.errorMessage ?? "unknown";
  return clip(`${type}: ${message}`);
}

function formatCommit(sha: string, subject?: string): string {
  const short = sha.slice(0, 8);
  const title = subject?.replace(/\s+/g, " ").trim();
  return title ? `${short} ${title}` : short;
}

function componentFromFile(file: string): string {
  const mod = moduleOf(file);
  if (mod && mod !== "root") return mod;
  return path.basename(file, path.extname(file)) || file;
}

function clip(text: string, max = 160): string {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value) return "unknown";
  return value.length <= max ? value : value.slice(0, max);
}

function unique(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const value = item.replace(/\s+/g, " ").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
