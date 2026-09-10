import { buildEvidenceGraph } from "../analysis/evidence-graph.js";
import { clamp } from "../exec.js";
import type {
  AgentRun,
  CauseAnalysis,
  CodeInvestigation,
  DependencyAnalysis,
  GitInvestigation,
  LogAnalysis,
  RankedCause,
  ReproductionAnalysis,
  StackFrame,
} from "../types.js";
import { LogAnalyzerAgent } from "./log-analyzer.js";
import { ROOT_CAUSE_AGENT, type AgentContext, type SpecialistAgent } from "./types.js";

/**
 * Root Cause Agent — builds and ranks possible causes from specialist findings.
 */
export class RootCauseAgent implements SpecialistAgent<CauseAnalysis> {
  readonly id = ROOT_CAUSE_AGENT.id;
  readonly name = ROOT_CAUSE_AGENT.name;
  readonly responsibility = ROOT_CAUSE_AGENT.responsibility;

  async run(ctx: AgentContext): Promise<{ result: CauseAnalysis; run: AgentRun }> {
    const started = Date.now();
    const result = await this.analyze(ctx);
    return {
      result,
      run: {
        id: this.id,
        name: this.name,
        responsibility: this.responsibility,
        status: "ok",
        summary: result.summary,
        durationMs: Date.now() - started,
      },
    };
  }

  async analyze(ctx: AgentContext): Promise<CauseAnalysis> {
    const logAnalysis = ctx.logAnalysis ?? (await new LogAnalyzerAgent().analyze(ctx.input));
    return rankCauses({
      logAnalysis,
      codeInvestigation: ctx.codeInvestigation,
      gitInvestigation: ctx.gitInvestigation,
      dependencyAnalysis: ctx.dependencyAnalysis,
      reproduction: ctx.reproduction,
      snippetFiles:
        ctx.evidence?.sourceSnippets.map((snippet) => snippet.file) ??
        ctx.codeInvestigation?.snippets.map((snippet) => snippet.file),
    });
  }
}

export function rankCauses(input: {
  logAnalysis: LogAnalysis;
  codeInvestigation?: CodeInvestigation;
  gitInvestigation?: GitInvestigation;
  dependencyAnalysis?: DependencyAnalysis;
  reproduction?: ReproductionAnalysis;
  snippetFiles?: string[];
}): CauseAnalysis {
  const crashSite =
    input.logAnalysis.crashSite ??
    input.codeInvestigation?.origin ??
    input.logAnalysis.error.frames.find((frame) => frame.inProject) ??
    input.logAnalysis.error.frames[0];
  const raw: Omit<RankedCause, "id">[] = [];

  if (crashSite) {
    raw.push(crashSiteCause(crashSite, input.codeInvestigation, input.logAnalysis));
  }

  const nullCause = nullDerefCause(input.logAnalysis, input.codeInvestigation);
  if (nullCause) raw.push(nullCause);

  const gitCause = introducingCause(input.gitInvestigation);
  if (gitCause) raw.push(gitCause);

  const depCause = dependencyCause(input.dependencyAnalysis);
  if (depCause) raw.push(depCause);

  const envCause = environmentCause(input.logAnalysis);
  if (envCause) raw.push(envCause);

  const repro = input.reproduction?.result;
  if (repro?.attempted && !repro.reproduced) {
    raw.push({
      kind: "unreproducible",
      description: "Could not reproduce locally. The failure may depend on production data, config, or a race.",
      evidence: [repro.summary],
      likelihood: 0.45,
    });
  }

  const topFile = crashSite?.file;
  const related = input.reproduction?.relatedTests.length ?? 0;
  if (topFile && related === 0 && input.reproduction && !input.reproduction.generatedTest) {
    raw.push({
      kind: "untested",
      description: `No related tests found for ${topFile}. The path may be untested.`,
      evidence: [`runner=${input.reproduction.runner ?? "unknown"}`],
      likelihood: 0.35,
    });
  }

  const causes = raw
    .sort((a, b) => b.likelihood - a.likelihood)
    .slice(0, 6)
    .map((cause, index) => ({ ...cause, id: `H${index + 1}` }));
  const leading = causes[0];
  const confidence = scoreConfidence(leading, input);
  const affectedFiles = uniqueFiles([
    ...(input.snippetFiles ?? []),
    ...input.logAnalysis.error.frames.filter((frame) => frame.inProject).map((frame) => frame.file),
    ...(input.codeInvestigation?.trace.map((step) => step.file) ?? []),
  ]).slice(0, 6);
  const graph = buildEvidenceGraph({ ...input, leading, confidence });
  const summary = buildCauseSummary(leading, causes, graph.confidence);
  const handoff = buildCauseHandoff(leading, causes, input.reproduction);
  if (graph.summary) handoff.unshift(`Evidence graph: ${graph.claim} (${Math.round(graph.confidence * 100)}%).`);

  return { causes, leading, confidence: graph.confidence, affectedFiles, graph, summary, handoff };
}

function crashSiteCause(
  crashSite: StackFrame,
  code: CodeInvestigation | undefined,
  log: LogAnalysis,
): Omit<RankedCause, "id"> {
  const loc = `${crashSite.file}${crashSite.line ? `:${crashSite.line}` : ""}`;
  const fn = crashSite.functionName ? ` (${crashSite.functionName})` : "";
  const expression = code?.trace.find((step) => step.role === "crash-site")?.expression;
  return {
    kind: "crash-site",
    description: `Defect in ${loc}${fn} — this is the top project frame${expression ? `: \`${expression}\`` : ""}.`,
    evidence: [crashSite.raw, expression, code?.summary, log.summary].filter((item): item is string => Boolean(item)),
    likelihood: crashSite.inProject ? 0.72 : 0.4,
  };
}

function nullDerefCause(log: LogAnalysis, code: CodeInvestigation | undefined): Omit<RankedCause, "id"> | undefined {
  const msg = log.error.message.toLowerCase();
  if (!/undefined|null|nil|none|\bnan\b/.test(msg)) return undefined;
  const unguarded = code?.trace.some((step) => /unguarded/i.test(step.note));
  return {
    kind: "null-deref",
    description: "Null/undefined value reached a dereference. A missing guard or bad default is likely.",
    evidence: [log.error.message, unguarded ? "Code Investigator flagged an unguarded access." : ""].filter(Boolean),
    likelihood: unguarded ? 0.78 : 0.58,
  };
}

function introducingCause(git: GitInvestigation | undefined): Omit<RankedCause, "id"> | undefined {
  const introducing = git?.introducing;
  if (!introducing) return undefined;
  return {
    kind: "introducing-commit",
    description: `Recent change introduced the bug: ${introducing.subject} (${introducing.sha.slice(0, 8)} by ${introducing.author} on ${introducing.date}).`,
    evidence: introducing.reasons.concat(git?.summary ? [git.summary] : []),
    likelihood: Math.min(0.7, 0.45 + introducing.score * 0.25),
  };
}

function dependencyCause(deps: DependencyAnalysis | undefined): Omit<RankedCause, "id"> | undefined {
  const issue = deps?.issues.find((item) => item.kind !== "none");
  if (!issue || !deps) return undefined;
  return {
    kind: "dependency",
    description: deps.summary,
    evidence: deps.issues.map((item) => item.detail),
    likelihood: deps.likelyDependencyBug ? Math.max(issue.likelihood, 0.7) : Math.min(issue.likelihood, 0.4),
  };
}

function environmentCause(log: LogAnalysis): Omit<RankedCause, "id"> | undefined {
  const msg = `${log.error.type ?? ""} ${log.error.message}`.toLowerCase();
  if (!/timeout|econnrefused|enotfound|network|socket/.test(msg)) return undefined;
  return {
    kind: "environment",
    description: "Runtime/environment failure (network, service down, bad URL) rather than a logic bug.",
    evidence: [log.error.message],
    likelihood: 0.5,
  };
}

function scoreConfidence(leading: RankedCause | undefined, input: Parameters<typeof rankCauses>[0]): number {
  let confidence = leading?.likelihood ?? 0.35;
  if (input.reproduction?.result.reproduced) confidence += 0.08;
  if (input.reproduction?.match === "matched") confidence += 0.12;
  if (input.gitInvestigation?.introducing) confidence += 0.04;
  if (input.codeInvestigation?.trace.some((step) => step.role === "crash-site")) confidence += 0.04;
  return clamp(confidence, 0.05, 0.96);
}

function buildCauseSummary(leading: RankedCause | undefined, causes: RankedCause[], confidence: number): string {
  if (!leading) return "No ranked causes; evidence is too thin for a confident root cause.";
  const alts = causes
    .slice(1, 3)
    .map((cause) => `${cause.id} ${cause.kind}`)
    .join(", ");
  return `Leading cause ${leading.id} (${Math.round(confidence * 100)}%): ${leading.description}${alts ? ` Alternatives: ${alts}.` : ""}`;
}

function buildCauseHandoff(
  leading: RankedCause | undefined,
  causes: RankedCause[],
  reproduction: ReproductionAnalysis | undefined,
): string[] {
  const notes: string[] = [];
  if (leading) notes.push(`Investigate ${leading.id} (${leading.kind}) first: ${leading.description}`);
  if (leading?.kind === "dependency") {
    notes.push("Do not patch application code until the install/version hypothesis is ruled out.");
  }
  if (reproduction?.result.reproduced && reproduction.match === "matched") {
    notes.push(`Reproduction matched the report (${Math.round(reproduction.confidence * 100)}%).`);
  } else if (reproduction?.steps[0]) notes.push(reproduction.steps[0]);
  const second = causes[1];
  if (second) notes.push(`If ${leading?.id} is wrong, try ${second.id} (${second.kind}).`);
  return notes;
}

function uniqueFiles(files: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of files) {
    if (!file || seen.has(file)) continue;
    seen.add(file);
    out.push(file);
  }
  return out;
}
