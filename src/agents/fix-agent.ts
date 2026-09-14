import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { countAffectedTests, labelFixCandidates, preferSmallestSafeFix, sameEdits, scoreFixRisk } from "../analysis/fix-risk.js";
import type {
  AgentRun,
  CauseAnalysis,
  CodeInvestigation,
  FileEdit,
  FixAnalysis,
  FixProposal,
  FixRisk,
  FixStrategy,
  ParsedError,
  RootCauseAnalysis,
} from "../types.js";
import { HeuristicInvestigator } from "../llm/heuristic.js";
import { FIX_AGENT, type AgentContext, type SpecialistAgent } from "./types.js";

/**
 * Fix Agent — generates a minimal code fix from ranked causes and the crash expression.
 */
export class FixAgent implements SpecialistAgent<FixAnalysis> {
  readonly id = FIX_AGENT.id;
  readonly name = FIX_AGENT.name;
  readonly responsibility = FIX_AGENT.responsibility;

  async run(ctx: AgentContext): Promise<{ result: FixAnalysis; run: AgentRun }> {
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

  async analyze(ctx: AgentContext): Promise<FixAnalysis> {
    const leading = ctx.causeAnalysis?.leading ?? ctx.rootCause?.hypotheses[0];
    if (ctx.causeAnalysis?.leading?.kind === "dependency" || ctx.dependencyAnalysis?.likelyDependencyBug) {
      return emptyFix("dependency-install", "heuristic", ctx, "No application patch: treat this as an install/version issue first.");
    }
    if (ctx.causeAnalysis?.leading?.kind === "environment" && ctx.environment?.mismatches.length) {
      return emptyFix(
        "environment-align",
        "heuristic",
        ctx,
        "No application patch: align Flutter/Xcode/Gradle with the working machine first.",
      );
    }

    const investigator = ctx.investigator ?? new HeuristicInvestigator();
    const rca = ctx.rootCause ?? fallbackRca(ctx);
    let proposal = await investigator.proposeFix(ctx.input, ctx.evidence ?? emptyEvidence(ctx), rca, ctx.previousFailure);
    let source: FixAnalysis["source"] = investigator.name === "heuristic" ? "heuristic" : "investigator";
    let strategy: FixStrategy = proposal.edits.length ? "investigator" : "none";

    const heuristic = await proposeMinimalFix({
      repoPath: ctx.input.repoPath,
      error: ctx.logAnalysis?.error ?? ctx.evidence?.error,
      codeInvestigation: ctx.codeInvestigation,
      causeAnalysis: ctx.causeAnalysis,
    });

    const related = ctx.evidence?.tests?.relatedTests ?? [];
    const candidates: Array<{ proposal: FixProposal; strategy: FixStrategy; source: FixAnalysis["source"]; edits: FileEdit[] }> = [];

    if (heuristic.edit) {
      const heuristicProposal: FixProposal = {
        summary: heuristic.summary,
        rationale: rca.rootCause,
        edits: [heuristic.edit],
        testPlan: ctx.reproduction?.steps.length ? ctx.reproduction.steps : ["Re-run the failing test."],
        risks: ["Heuristic patch is a minimal guard; confirm the intended null/default behavior."],
        applied: false,
        applyErrors: [],
      };
      candidates.push({
        proposal: heuristicProposal,
        strategy: heuristic.strategy,
        source: "heuristic",
        edits: heuristicProposal.edits,
      });
    }

    if (proposal.edits.length && !candidates.some((item) => sameEdits(item.edits, proposal.edits))) {
      if (investigator.name === "heuristic" && heuristic.strategy !== "none") {
        strategy = heuristic.strategy;
      }
      candidates.push({ proposal, strategy, source, edits: proposal.edits });
    }

    if (!candidates.length) {
      const handoff = buildFixHandoff(proposal, strategy, leading?.description);
      return {
        proposal,
        strategy,
        source,
        summary: buildFixSummary(proposal, strategy, source),
        handoff,
        risk: scoreFixRisk({ files: [], tests: 0, baseConfidence: rca.confidence, strategy }),
        alternatives: [],
      };
    }

    const scored = candidates.map((item) => ({
      ...item,
      risk: scoreFixRisk({
        files: item.edits.map((edit) => edit.path),
        tests: countAffectedTests(ctx.input.repoPath, item.edits.map((edit) => edit.path), related),
        baseConfidence: rca.confidence,
        strategy: item.strategy,
      }),
    }));
    const ranked = preferSmallestSafeFix(scored);
    const winner = ranked[0];
    if (!winner) {
      return emptyFix("none", source, ctx, "No fix candidate survived risk ranking.");
    }
    const alternatives = labelFixCandidates(ranked.map((item) => item.risk));
    const preferred = alternatives[0];
    if (!preferred) {
      return emptyFix("none", source, ctx, "No fix candidate survived risk ranking.");
    }
    proposal = winner.proposal;
    strategy = winner.strategy;
    source = winner.source;
    const risk: FixRisk = { ...preferred, preferred: true };

    const handoff = buildFixHandoff(proposal, strategy, leading?.description, risk);
    const previous = ctx.memory?.matches[0]?.entry;
    if (previous?.fix) {
      handoff.unshift(`Debugging memory: a similar incident was fixed with "${previous.fix}".`);
    }
    if (alternatives.length > 1) {
      handoff.unshift("Prefer the smallest safe fix that resolves the problem.");
    }
    if (risk.level === "HIGH") {
      handoff.unshift("HIGH risk: do not apply this patch to production code without review.");
    }
    return {
      proposal,
      strategy,
      source,
      summary: buildFixSummary(proposal, strategy, source, risk),
      handoff,
      risk,
      alternatives,
    };
  }
}

export async function proposeMinimalFix(input: {
  repoPath: string;
  error?: ParsedError;
  codeInvestigation?: CodeInvestigation;
  causeAnalysis?: CauseAnalysis;
}): Promise<{ edit?: FileEdit; strategy: FixStrategy; summary: string }> {
  const crash = input.codeInvestigation?.trace.find((step) => step.role === "crash-site");
  const origin = input.codeInvestigation?.origin;
  const rel = origin?.file
    ? path.isAbsolute(origin.file)
      ? path.relative(input.repoPath, origin.file)
      : origin.file
    : crash?.file;
  if (!rel) return { strategy: "none", summary: "No crash-site file to patch." };

  const abs = path.resolve(input.repoPath, rel);
  if (!abs.startsWith(path.resolve(input.repoPath)) || !existsSync(abs)) {
    return { strategy: "none", summary: "Crash-site file is missing or outside the repo." };
  }

  const content = await readFile(abs, "utf8");
  const expression = crash?.expression ?? crash?.note ?? "";
  const message = input.error?.message ?? "";
  const edit = proposeMinimalEdit({
    file: rel.replace(/\\/g, "/"),
    fileContent: content,
    expression,
    message,
  });
  if (!edit) return { strategy: "none", summary: "No safe minimal edit matched the crash expression." };
  return {
    edit,
    strategy: inferStrategy(edit),
    summary: `Minimal ${inferStrategy(edit)} edit in ${edit.path}.`,
  };
}

export function proposeMinimalEdit(input: {
  file: string;
  fileContent: string;
  expression: string;
  message: string;
}): FileEdit | undefined {
  const line = pickExisting(input.fileContent, input.expression);
  if (!line) return undefined;

  const reading = input.message.match(/reading ['"](\w+)['"]/i)?.[1];
  if (reading) {
    const token = `.${reading}`;
    if (line.includes(token) && !line.includes(`?.${reading}`)) {
      return { path: input.file, oldString: line, newString: line.replace(token, `?.${reading}`) };
    }
  }

  if (/nan|qty|quantity/i.test(input.message) || /\.qty\b/.test(line)) {
    if (line.includes("item.price * item.qty") && !line.includes("??")) {
      return {
        path: input.file,
        oldString: line,
        newString: line.replace("item.price * item.qty", "item.price * (item.qty ?? 1)"),
      };
    }
  }

  if (/\.\w+/.test(line) && !/\?\./.test(line) && /undefined|null/i.test(input.message)) {
    const replaced = line.replace(/\.(\w+)(\s*;?\s*)$/, "?.$1$2");
    if (replaced !== line) {
      return { path: input.file, oldString: line, newString: replaced };
    }
  }

  return undefined;
}

function inferStrategy(edit: FileEdit): FixStrategy {
  if (edit.newString.includes("??")) return "nullish-default";
  if (edit.newString.includes("?.")) return "optional-chain";
  return "investigator";
}

function pickExisting(content: string, expression: string): string | undefined {
  const trimmed = expression.trim();
  if (trimmed && content.includes(trimmed)) return trimmed;
  const line = content.split("\n").find((row) => trimmed && row.includes(trimmed.replace(/;$/, "")));
  return line?.trim();
}

function buildFixSummary(proposal: FixProposal, strategy: FixStrategy, source: FixAnalysis["source"], risk?: FixRisk): string {
  if (strategy === "dependency-install" || strategy === "environment-align") return proposal.summary;
  if (!proposal.edits.length) {
    return proposal.summary || "No minimal edit generated; wait for an LLM investigator or a clearer crash expression.";
  }
  const where = proposal.edits.map((edit) => edit.path).join(", ");
  const applied = proposal.applied ? "applied" : "not applied";
  const riskBit = risk ? ` Risk ${risk.level} (${Math.round(risk.confidence * 100)}%).` : "";
  return `${source === "investigator" ? "Investigator" : "Heuristic"} ${strategy} fix in ${where} (${proposal.edits.length} edit${proposal.edits.length === 1 ? "" : "s"}, ${applied}).${riskBit}`;
}

function buildFixHandoff(proposal: FixProposal, strategy: FixStrategy, leading?: string, risk?: FixRisk): string[] {
  const notes: string[] = [];
  if (strategy === "dependency-install") {
    notes.push("Do not patch application code until the dependency/version hypothesis is ruled out.");
    return notes;
  }
  if (strategy === "environment-align") {
    notes.push("Do not patch application code until the toolchain mismatch is ruled out.");
    return notes;
  }
  if (risk) {
    notes.push(
      `${risk.label}: ${risk.files} file${risk.files === 1 ? "" : "s"}, ${risk.tests} tests, ${risk.modules} module${risk.modules === 1 ? "" : "s"}, ${risk.level} risk, ${Math.round(risk.confidence * 100)}% confidence.`,
    );
  }
  if (proposal.edits[0]) {
    notes.push(`Review ${proposal.edits[0].path}: \`${oneLine(proposal.edits[0].oldString)}\` → \`${oneLine(proposal.edits[0].newString)}\`.`);
  } else {
    notes.push("No file edit available; Test Agent should not treat the suite as a verification of a patch.");
  }
  if (leading) notes.push(`Fix targets: ${leading}`);
  if (proposal.applied) notes.push("Working tree updated; run Test Agent next.");
  else if (proposal.edits.length) notes.push("Re-run with --apply to write the patch and verify.");
  return notes;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function emptyFix(
  strategy: FixStrategy,
  source: FixAnalysis["source"],
  ctx: AgentContext,
  summary: string,
): FixAnalysis {
  return {
    proposal: {
      summary,
      rationale: ctx.rootCause?.rootCause ?? ctx.causeAnalysis?.summary ?? summary,
      edits: [],
      testPlan: ctx.reproduction?.steps ?? [],
      risks:
        strategy === "dependency-install"
          ? ["Installing or pinning the wrong version."]
          : strategy === "environment-align"
            ? ["The failure may still be application code after toolchains match."]
            : [],
      applied: false,
      applyErrors: [],
    },
    strategy,
    source,
    summary,
    handoff: buildFixHandoff(
      { summary, rationale: "", edits: [], testPlan: [], risks: [], applied: false, applyErrors: [] },
      strategy,
    ),
    risk: scoreFixRisk({ files: [], tests: 0, strategy }),
    alternatives: [],
  };
}

function fallbackRca(ctx: AgentContext): RootCauseAnalysis {
  const leading = ctx.causeAnalysis?.leading;
  return {
    summary: ctx.causeAnalysis?.summary ?? "No investigator RCA; using Root Cause Agent ranking.",
    rootCause: leading?.description ?? ctx.logAnalysis?.summary ?? "Unknown root cause",
    confidence: ctx.causeAnalysis?.confidence ?? 0.4,
    hypotheses: (ctx.causeAnalysis?.causes ?? []).map((cause) => ({
      id: cause.id,
      description: cause.description,
      evidence: cause.evidence,
      likelihood: cause.likelihood,
    })),
    affectedFiles: ctx.causeAnalysis?.affectedFiles ?? [],
    reproSteps: ctx.reproduction?.steps ?? [],
    investigator: "fix-agent",
  };
}

function emptyEvidence(ctx: AgentContext): NonNullable<AgentContext["evidence"]> {
  return (
    ctx.evidence ?? {
      collectedAt: new Date().toISOString(),
      repoPath: ctx.input.repoPath,
      error: ctx.logAnalysis?.error ?? { message: ctx.input.message ?? "Unknown error", frames: [] },
      logs: ctx.logAnalysis?.logs ?? { sources: [], excerpt: "" },
      sourceSnippets: ctx.codeInvestigation?.snippets ?? [],
      git: { available: false, recentCommits: [], commitsTouchingSuspects: [], blame: [] },
      pullRequests: [],
      tests: { relatedTests: [] },
      dependencies: { hits: [] },
      runtime: { os: process.platform, arch: process.arch, cwd: ctx.input.repoPath, ci: false, envHints: [] },
    }
  );
}
