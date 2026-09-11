import path from "node:path";
import { parsePrNumber } from "./git-regression.js";
import type {
  CodeInvestigation,
  DebuggingMemory,
  DependencyAnalysis,
  EnvironmentAnalysis,
  EvidenceCheck,
  EvidenceGraph,
  EvidenceGraphNode,
  GitInvestigation,
  LogAnalysis,
  PullRequestEvidence,
  RankedCause,
  ReproductionAnalysis,
  StackFrame,
} from "../types.js";

export function buildEvidenceGraph(input: {
  logAnalysis: LogAnalysis;
  codeInvestigation?: CodeInvestigation;
  gitInvestigation?: GitInvestigation;
  dependencyAnalysis?: DependencyAnalysis;
  reproduction?: ReproductionAnalysis;
  environment?: EnvironmentAnalysis;
  memory?: DebuggingMemory;
  leading?: RankedCause;
  confidence: number;
}): EvidenceGraph {
  const crashSite =
    input.logAnalysis.crashSite ??
    input.codeInvestigation?.origin ??
    input.logAnalysis.error.frames.find((frame) => frame.inProject) ??
    input.logAnalysis.error.frames[0];
  const nodes: EvidenceGraphNode[] = [];
  const seen = new Set<string>();

  const crashLabel = input.logAnalysis.error.type ?? "Crash";
  add(nodes, seen, {
    id: "crash",
    kind: "crash",
    label: crashLabel,
    detail: clip(input.logAnalysis.error.message, 140),
  });

  if (crashSite) {
    add(nodes, seen, {
      id: "function",
      kind: "function",
      label: displayUnit(crashSite),
      detail: `${path.basename(crashSite.file)}${crashSite.line ? `:${crashSite.line}` : ""}`,
    });
  }

  const repoStep = findLayer(input, /repository|\brepo\b/i);
  if (repoStep) {
    add(nodes, seen, {
      id: "repository",
      kind: "repository",
      label: "Repository",
      detail: repoStep,
    });
  }

  const apiStep = findLayer(input, /\bapi\b|http|client|dio|fetch|get[A-Z]\w*(Media|Data|Response|Json)|response/i);
  const apiLike = isApiLike(input, crashSite);
  if (apiStep || apiLike) {
    add(nodes, seen, {
      id: "api",
      kind: "api",
      label: "API Response",
      detail: apiStep ?? apiLike,
    });
  }

  const expression = input.codeInvestigation?.trace.find((step) => step.role === "crash-site")?.expression;
  if (expression && !apiStep) {
    add(nodes, seen, {
      id: "source",
      kind: "source",
      label: clip(expression, 48),
      detail: crashSite ? `${path.basename(crashSite.file)}${crashSite.line ? `:${crashSite.line}` : ""}` : undefined,
    });
  }

  const nullish = isNullish(input);
  if (nullish) {
    add(nodes, seen, {
      id: "null-value",
      kind: "null-value",
      label: "null value",
      detail: clip(input.logAnalysis.error.message, 120),
    });
  }

  if (input.leading?.kind === "dependency") {
    add(nodes, seen, {
      id: "dependency",
      kind: "dependency",
      label: "Dependency",
      detail: input.leading.description,
    });
  }
  if (input.leading?.kind === "environment") {
    add(nodes, seen, {
      id: "environment",
      kind: "environment",
      label: input.environment?.mismatches.length ? "Toolchain mismatch" : "Environment",
      detail: input.leading.description,
    });
  }
  if (input.leading?.kind === "known-incident") {
    add(nodes, seen, {
      id: "memory",
      kind: "memory",
      label: "Debugging memory",
      detail: input.leading.description,
    });
  }

  const commit = input.gitInvestigation?.introducing;
  if (commit) {
    add(nodes, seen, {
      id: "commit",
      kind: "commit",
      label: `Commit ${commit.sha.slice(0, 7)}`,
      detail: commit.subject,
    });
  }
  const pr = linkedPullRequest(input.gitInvestigation);
  if (pr) {
    add(nodes, seen, {
      id: "pr",
      kind: "pr",
      label: `PR #${pr.number}`,
      detail: pr.title,
    });
  }

  const supporting = evidenceChecks(input, crashSite, expression, Boolean(apiStep || apiLike), nullish);
  const contradicting = contradictingChecks(input);
  const claim = claimFor(input.leading, Boolean(apiStep || apiLike), nullish);
  const confidence = scoreGraphConfidence(input.confidence, supporting, contradicting);
  const summary = `${claim} (${Math.round(confidence * 100)}%) via ${nodes.map((node) => node.label).join(" → ")}.`;

  return { claim, confidence, nodes, supporting, contradicting, summary };
}

export function renderEvidenceGraphAscii(graph: EvidenceGraph): string {
  const chain = graph.nodes.map((node) => node.label);
  const arrows = chain.flatMap((label, index) => (index === 0 ? [label] : [" ↓", label]));
  const evidence = graph.supporting.map((check) => `${check.present && check.supports ? "✓" : "✗"} ${check.label}`);
  const contra = graph.contradicting.length
    ? graph.contradicting.map((check) => `✗ ${check.label}`)
    : ["None"];

  return [
    arrows.join("\n"),
    "",
    `Root Cause: ${graph.claim}`,
    `Confidence: ${Math.round(graph.confidence * 100)}%`,
    "",
    "Evidence:",
    ...evidence,
    "",
    "Contradicting evidence:",
    ...contra,
  ].join("\n");
}

function evidenceChecks(
  input: Parameters<typeof buildEvidenceGraph>[0],
  crashSite: StackFrame | undefined,
  expression: string | undefined,
  api: boolean,
  nullish: boolean,
): EvidenceCheck[] {
  const frames = input.logAnalysis.error.frames;
  const reproduced = Boolean(input.reproduction?.result.reproduced);
  const matched = input.reproduction?.match === "matched";
  const commit = Boolean(input.gitInvestigation?.introducing);

  const checks: EvidenceCheck[] = [
    {
      id: "stack-trace",
      label: "Stack trace",
      present: frames.length > 0,
      supports: frames.length > 0,
      detail: crashSite
        ? `${path.basename(crashSite.file)}${crashSite.line ? `:${crashSite.line}` : ""}`
        : frames.length
          ? `${frames.length} frames`
          : "No stack frames parsed.",
    },
    {
      id: "source-code",
      label: "Source code",
      present: Boolean(expression || input.codeInvestigation?.snippets.length),
      supports: Boolean(expression || input.codeInvestigation?.snippets.length),
      detail: expression ?? input.codeInvestigation?.summary ?? "No crash-site source.",
    },
    {
      id: api ? "api-response" : "null-value",
      label: api ? "API response" : "Null/undefined value",
      present: api || nullish,
      supports: api || nullish,
      detail: api
        ? "Null/missing payload inferred from the crash path."
        : nullish
          ? input.logAnalysis.error.message
          : "No null/API signal.",
    },
    {
      id: "git-commit",
      label: "Git commit",
      present: commit,
      supports: commit,
      detail: commit
        ? `${input.gitInvestigation?.introducing?.sha.slice(0, 7)} ${input.gitInvestigation?.introducing?.subject}`
        : "No introducing commit identified.",
    },
    {
      id: "reproduction",
      label: "Reproduction",
      present: Boolean(input.reproduction?.result.attempted),
      supports: reproduced && (matched || input.reproduction?.match !== "unmatched"),
      detail: input.reproduction?.matchDetail ?? input.reproduction?.result.summary ?? "Reproduction did not run.",
    },
  ];
  if (input.environment) {
    checks.push({
      id: "toolchain",
      label: "Toolchain mismatch",
      present: input.environment.mismatches.length > 0,
      supports: input.environment.mismatches.length > 0,
      detail: input.environment.mismatches.length
        ? input.environment.mismatches.map((item) => `${item.tool}: ${item.expected} vs ${item.actual}`).join("; ")
        : "No toolchain mismatch detected.",
    });
  }
  if (input.memory) {
    checks.push({
      id: "memory",
      label: "Historical incidents",
      present: input.memory.matches.length > 0,
      supports: input.memory.matches.length > 0,
      detail: input.memory.summary,
    });
  }
  return checks;
}

function contradictingChecks(input: Parameters<typeof buildEvidenceGraph>[0]): EvidenceCheck[] {
  const checks: EvidenceCheck[] = [];
  const leading = input.leading?.kind;
  const repro = input.reproduction?.result;

  if (repro?.attempted && !repro.reproduced) {
    checks.push({
      id: "not-reproduced",
      label: "Could not reproduce locally",
      present: true,
      supports: false,
      detail: repro.summary,
    });
  }
  if (input.reproduction?.match === "partial" && repro?.reproduced) {
    checks.push({
      id: "partial-match",
      label: "Captured failure only partly matches the report",
      present: true,
      supports: false,
      detail: input.reproduction.matchDetail,
    });
  }
  if (input.dependencyAnalysis?.likelyDependencyBug && leading !== "dependency") {
    checks.push({
      id: "dependency",
      label: "Dependency/version issue may explain the crash instead",
      present: true,
      supports: false,
      detail: input.dependencyAnalysis.summary,
    });
  }
  if (leading && leading !== "environment") {
    const msg = `${input.logAnalysis.error.type ?? ""} ${input.logAnalysis.error.message}`.toLowerCase();
    if (/timeout|econnrefused|enotfound|network|socket/.test(msg)) {
      checks.push({
        id: "environment",
        label: "Logs look like a network/environment failure",
        present: true,
        supports: false,
        detail: input.logAnalysis.error.message,
      });
    }
  }
  return checks;
}

function claimFor(leading: RankedCause | undefined, api: boolean, nullish: boolean): string {
  if (leading?.kind === "dependency") return shortClaim(leading.description, "Dependency/version failure");
  if (leading?.kind === "flutter") return shortClaim(leading.description, "Flutter framework failure");
  if (leading?.kind === "api") return shortClaim(leading.description, "API/backend failure");
  if (leading?.kind === "database") return shortClaim(leading.description, "Database failure");
  if (leading?.kind === "environment") return shortClaim(leading.description, "Environment failure");
  if (leading?.kind === "known-incident") return shortClaim(leading.description, "Known historical incident");
  if (leading?.kind === "unreproducible") return "Could not reproduce locally";
  if (api && nullish) return "Null API response";
  if (nullish) return "Null/undefined dereference";
  if (leading?.kind === "introducing-commit") return shortClaim(leading.description, "Recent commit introduced the bug");
  if (leading) return shortClaim(leading.description, leading.kind);
  return "Insufficient evidence for a root cause";
}

function shortClaim(text: string, fallback: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (!one) return fallback;
  return one.length > 80 ? `${one.slice(0, 77)}...` : one;
}

function isNullish(input: Parameters<typeof buildEvidenceGraph>[0]): boolean {
  if (input.leading?.kind === "null-deref") return true;
  const msg = input.logAnalysis.error.message.toLowerCase();
  return /undefined|null|nil|none|\bnan\b/.test(msg);
}

function isApiLike(input: Parameters<typeof buildEvidenceGraph>[0], crashSite?: StackFrame): string | undefined {
  const blob = [
    crashSite?.file,
    crashSite?.functionName,
    ...(input.codeInvestigation?.suspects ?? []),
    ...(input.codeInvestigation?.trace.map((step) => `${step.functionName ?? ""} ${step.expression ?? ""}`) ?? []),
    ...(input.codeInvestigation?.callers.map((caller) => caller.text) ?? []),
  ]
    .filter(Boolean)
    .join(" ");
  if (!/\bapi\b|http|client|dio|fetch|get[A-Z]\w*(Media|Data|Response|Json)|response/i.test(blob) && !/media/i.test(crashSite?.file ?? "")) {
    return undefined;
  }
  const named = blob.match(/\b(get[A-Z][A-Za-z0-9_]+)\b/);
  return named?.[1] ?? "null/missing payload on the crash path";
}

function findLayer(input: Parameters<typeof buildEvidenceGraph>[0], pattern: RegExp): string | undefined {
  const steps = [
    ...(input.codeInvestigation?.trace.map((step) => ({
      file: step.file,
      fn: step.functionName,
      text: step.expression ?? step.note,
    })) ?? []),
    ...(input.codeInvestigation?.callers.map((caller) => ({
      file: caller.file,
      fn: undefined,
      text: caller.text,
    })) ?? []),
    ...(input.logAnalysis.error.frames.map((frame) => ({
      file: frame.file,
      fn: frame.functionName,
      text: frame.raw,
    })) ?? []),
  ];
  for (const step of steps) {
    const blob = `${step.file} ${step.fn ?? ""} ${step.text ?? ""}`;
    if (!pattern.test(blob)) continue;
    return step.fn || path.basename(step.file);
  }
  return undefined;
}

function displayUnit(frame: StackFrame): string {
  const fn = frame.functionName?.split(".")[0];
  if (fn && fn.length > 2 && fn !== "<anonymous>") return fn;
  const stem = path.parse(frame.file).name;
  return stem || fn || "crash site";
}

function add(nodes: EvidenceGraphNode[], seen: Set<string>, node: EvidenceGraphNode): void {
  if (seen.has(node.id)) return;
  seen.add(node.id);
  nodes.push(node);
}

function scoreGraphConfidence(base: number, supporting: EvidenceCheck[], contradicting: EvidenceCheck[]): number {
  const supportHits = supporting.filter((check) => check.present && check.supports).length;
  const supportMax = Math.max(1, supporting.length);
  const supportBoost = (supportHits / supportMax) * 0.08;
  const contraPenalty = contradicting.length * 0.08;
  return Math.min(0.96, Math.max(0.05, base + supportBoost - contraPenalty));
}

function linkedPullRequest(git?: GitInvestigation): PullRequestEvidence | undefined {
  if (!git) return undefined;
  if (git.regression?.pullRequest) return git.regression.pullRequest;
  const numbered = parsePrNumber(git.introducing?.subject ?? "");
  if (numbered) {
    const byNumber = git.pullRequests.find((pr) => pr.number === numbered);
    if (byNumber) return byNumber;
  }
  return git.pullRequests.find((pr) => Boolean(pr.overlap?.length));
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
