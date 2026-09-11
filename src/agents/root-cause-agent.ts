import { buildEvidenceGraph } from "../analysis/evidence-graph.js";
import { clamp } from "../exec.js";
import type {
  AgentRun,
  CauseAnalysis,
  CodeInvestigation,
  DebuggingMemory,
  DependencyAnalysis,
  EnvironmentAnalysis,
  FailureClassification,
  GitInvestigation,
  LogAnalysis,
  RankedCause,
  ReproductionAnalysis,
  SpecialistFindings,
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
      specialists: ctx.specialists,
      environment: ctx.environment,
      classification: ctx.classification,
      memory: ctx.memory ?? ctx.evidence?.memory,
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
  specialists?: SpecialistFindings;
  environment?: EnvironmentAnalysis;
  classification?: FailureClassification;
  memory?: DebuggingMemory;
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

  const flutterCause = flutterSpecialistCause(input);
  if (flutterCause) raw.push(flutterCause);

  const apiCause = networkSpecialistCause(input.specialists);
  if (apiCause) raw.push(apiCause);

  const dbCause = databaseSpecialistCause(input.specialists);
  if (dbCause) raw.push(dbCause);

  const gitCause = introducingCause(input.gitInvestigation);
  if (gitCause) raw.push(gitCause);

  const depCause = dependencyCause(input.dependencyAnalysis);
  if (depCause) raw.push(depCause);

  const memoryCause = knownIncidentCause(input.memory);
  if (memoryCause) raw.push(memoryCause);

  const mismatchCause = toolchainMismatchCause(input.environment, input.classification);
  if (mismatchCause) raw.push(mismatchCause);

  const envCause = input.specialists?.network || mismatchCause ? undefined : environmentCause(input.logAnalysis);
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

function flutterSpecialistCause(input: Parameters<typeof rankCauses>[0]): Omit<RankedCause, "id"> | undefined {
  const flutter = input.specialists?.flutter;
  if (!flutter) return undefined;
  const implicated = flutter.implicated;
  if (!implicated.length && !flutter.usesBloc && !flutter.usesDio) return undefined;
  const nullish = /undefined|null|nil|none|\bnan\b/.test(input.logAnalysis.error.message.toLowerCase());
  const focus = implicated[0];
  if (focus === "ios-build" || focus === "android-build") {
    return {
      kind: "flutter",
      description: `${focus === "ios-build" ? "iOS" : "Android"} build failure — inspect Xcode/CocoaPods or Gradle before patching Dart.`,
      evidence: [flutter.summary, ...flutter.handoff],
      likelihood: 0.8,
    };
  }
  if (focus === "platform-channel") {
    return {
      kind: "flutter",
      description: "Platform channel / plugin mismatch between Dart and iOS or Android.",
      evidence: [flutter.summary, ...flutter.handoff],
      likelihood: 0.76,
    };
  }
  if ((focus === "dio" || flutter.usesDio) && nullish) {
    return {
      kind: "flutter",
      description: "Dio/API returned a null payload and a Bloc or widget dereferenced it.",
      evidence: [flutter.summary, input.logAnalysis.error.message, ...flutter.handoff],
      likelihood: 0.84,
    };
  }
  if (focus === "bloc" || (flutter.usesBloc && nullish)) {
    return {
      kind: "flutter",
      description: `Bloc/Cubit assumed a non-null state${flutter.blocs[0] ? ` in ${flutter.blocs[0]}` : ""}.`,
      evidence: [flutter.summary, ...flutter.handoff],
      likelihood: 0.8,
    };
  }
  if (focus === "drift") {
    return {
      kind: "flutter",
      description: "Drift/SQLite path failed (schema, nullability, or migration).",
      evidence: [flutter.summary, ...flutter.handoff],
      likelihood: 0.74,
    };
  }
  return {
    kind: "flutter",
    description: flutter.summary,
    evidence: flutter.handoff,
    likelihood: 0.55,
  };
}

function networkSpecialistCause(specialists?: SpecialistFindings): Omit<RankedCause, "id"> | undefined {
  const network = specialists?.network;
  if (!network) return undefined;
  const server = network.status && /^[45]/.test(network.status);
  return {
    kind: "api",
    description: network.summary,
    evidence: [network.endpoint, network.status ? `HTTP ${network.status}` : "", ...network.handoff].filter(
      (item): item is string => Boolean(item),
    ),
    likelihood: server ? 0.78 : 0.62,
  };
}

function databaseSpecialistCause(specialists?: SpecialistFindings): Omit<RankedCause, "id"> | undefined {
  const database = specialists?.database;
  if (!database) return undefined;
  return {
    kind: "database",
    description: database.summary,
    evidence: [database.engine, database.operation, ...database.handoff].filter((item): item is string => Boolean(item)),
    likelihood: database.engine && database.engine !== "unknown" ? 0.72 : 0.5,
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

function knownIncidentCause(memory?: DebuggingMemory): Omit<RankedCause, "id"> | undefined {
  const top = memory?.matches[0];
  if (!top || top.score < 0.45) return undefined;
  const count = memory?.matches.length ?? 0;
  return {
    kind: "known-incident",
    description: `${count} previous incident${count === 1 ? "" : "s"} had the same pattern: ${top.entry.rootCause}`,
    evidence: [
      top.entry.fix ? `Previous fix: ${top.entry.fix}` : "",
      top.entry.resolution ? `Resolution: ${top.entry.resolution}` : "",
      ...memory!.matches.slice(0, 3).map((match) => match.entry.rootCause),
    ].filter(Boolean),
    likelihood: Math.min(0.86, 0.5 + top.score * 0.25 + Math.min(0.12, Math.max(0, count - 1) * 0.04)),
  };
}

function toolchainMismatchCause(
  environment?: EnvironmentAnalysis,
  classification?: FailureClassification,
): Omit<RankedCause, "id"> | undefined {
  if (!environment?.mismatches.length) return undefined;
  const tools = environment.mismatches.map((item) => item.tool).join(", ");
  const buildish =
    classification?.family === "build" ||
    classification?.category === "dependency-issue" ||
    classification?.category === "configuration-environment" ||
    classification?.category === "build-failure";
  return {
    kind: "environment",
    description: `Potential environment mismatch detected (${tools}).`,
    evidence: [
      `${environment.localLabel}: ${describeSide(environment.local)}`,
      environment.baseline
        ? `${environment.baselineLabel ?? "Developer B"}: ${describeSide(environment.baseline)}`
        : "",
      ...environment.mismatches.map((item) => `${item.tool}: ${item.expected} vs ${item.actual}`),
    ].filter(Boolean),
    likelihood: buildish ? 0.88 : 0.62,
  };
}

function describeSide(runtime: {
  flutter?: string;
  xcode?: string;
  gradle?: string;
  dart?: string;
  kotlin?: string;
}): string {
  return [
    runtime.flutter ? `Flutter ${runtime.flutter}` : undefined,
    runtime.dart ? `Dart ${runtime.dart}` : undefined,
    runtime.xcode ? `Xcode ${runtime.xcode}` : undefined,
    runtime.gradle ? `Gradle ${runtime.gradle}` : undefined,
    runtime.kotlin ? `Kotlin ${runtime.kotlin}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
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
  if (input.specialists?.flutter?.implicated.length) confidence += 0.04;
  if (input.specialists?.crash?.kind === "null-crash") confidence += 0.03;
  if (input.environment?.mismatches.length) confidence += 0.05;
  if (input.memory?.matches.length) confidence += 0.05;
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
  if (leading?.kind === "environment") {
    notes.push("Align Flutter/Dart/Xcode/Gradle/Kotlin with the working machine before patching application code.");
  }
  if (leading?.kind === "known-incident") {
    notes.push("Reuse the historical fix as a starting point, then confirm it still matches this crash site.");
  }
  if (leading?.kind === "flutter" || leading?.kind === "api" || leading?.kind === "database") {
    notes.push("Start from the specialist handoff before a generic source patch.");
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
