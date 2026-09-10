import type {
  BugInput,
  EvidenceBundle,
  FixProposal,
  Investigator,
  ReproductionResult,
  RootCauseAnalysis,
} from "../types.js";
import { clamp } from "../exec.js";

export class HeuristicInvestigator implements Investigator {
  readonly name = "heuristic";

  async analyze(
    _input: BugInput,
    evidence: EvidenceBundle,
    reproduction: ReproductionResult,
  ): Promise<RootCauseAnalysis> {
    const projectFrames = evidence.error.frames.filter((frame) => frame.inProject);
    const top = projectFrames[0] ?? evidence.error.frames[0];
    const snippet = evidence.sourceSnippets[0];
    const blame = evidence.git.blame[0];
    const recentHit = evidence.git.commitsTouchingSuspects[0];

    const hypotheses = buildHypotheses(evidence, reproduction, top?.file);
    const best = hypotheses[0];
    const affectedFiles = unique([
      ...evidence.sourceSnippets.map((s) => s.file),
      ...projectFrames.map((f) => f.file).filter((file) => !file.includes("node_modules")),
    ]).slice(0, 6);

    const rootCause = best?.description
      ?? (top
        ? `${evidence.error.type ?? "Error"} originates at ${top.file}${top.line ? `:${top.line}` : ""}${top.functionName ? ` in ${top.functionName}` : ""}.`
        : evidence.error.message);

    let confidence = 0.35;
    if (top?.inProject) confidence += 0.2;
    if (snippet) confidence += 0.1;
    if (blame) confidence += 0.1;
    if (reproduction.reproduced) confidence += 0.15;
    if (recentHit) confidence += 0.05;

    const reproSteps = [
      reproduction.command ? `Run \`${reproduction.command}\`.` : "Replay the failing request or command that produced the stack trace.",
      top ? `Inspect ${top.file}${top.line ? `:${top.line}` : ""}.` : "Inspect the top project stack frame.",
    ];

    return {
      summary: [
        `Heuristic analysis of ${evidence.error.type ?? "error"}: ${evidence.error.message}.`,
        top ? `Primary frame: ${top.file}${top.line ? `:${top.line}` : ""}.` : "No stack frames were parsed.",
        blame ? `Last change to that line: ${blame.sha} by ${blame.author} (${blame.date}) — ${blame.summary}.` : "",
        reproduction.summary,
      ]
        .filter(Boolean)
        .join(" "),
      rootCause,
      confidence: clamp(confidence, 0.05, 0.9),
      hypotheses,
      affectedFiles,
      reproSteps,
      investigator: this.name,
    };
  }

  async proposeFix(
    _input: BugInput,
    evidence: EvidenceBundle,
    rca: RootCauseAnalysis,
  ): Promise<FixProposal> {
    const snippet = evidence.sourceSnippets[0];
    const hint = suggestFixHint(evidence.error.message, snippet?.content);

    return {
      summary: hint
        ?? "No automatic patch from the heuristic investigator. Use an LLM investigator (OpenAI, Anthropic, or Cursor) to generate a precise edit.",
      rationale: rca.rootCause,
      edits: [],
      testPlan: evidence.tests.testCommand
        ? [`Run \`${evidence.tests.testCommand}\`.`, ...rca.reproSteps]
        : rca.reproSteps,
      risks: [
        "Heuristic mode does not apply code edits.",
        "Confirm the ranked hypotheses before changing code.",
      ],
      applied: false,
      applyErrors: [],
    };
  }
}

function buildHypotheses(
  evidence: EvidenceBundle,
  reproduction: ReproductionResult,
  topFile?: string,
): RootCauseAnalysis["hypotheses"] {
  const hypotheses: RootCauseAnalysis["hypotheses"] = [];
  const top = evidence.error.frames.find((frame) => frame.inProject) ?? evidence.error.frames[0];
  const blame = evidence.git.blame[0];
  const msg = evidence.error.message.toLowerCase();

  if (top) {
    hypotheses.push({
      id: "H1",
      description: `Defect in ${top.file}${top.line ? `:${top.line}` : ""}${top.functionName ? ` (${top.functionName})` : ""} — this is the top project frame.`,
      evidence: [top.raw, evidence.sourceSnippets[0]?.content.slice(0, 400) ?? "no snippet"].filter(Boolean),
      likelihood: top.inProject ? 0.72 : 0.4,
    });
  }

  if (blame && recent(blame.date)) {
    hypotheses.push({
      id: "H2",
      description: `Recent change introduced the bug: ${blame.summary} (${blame.sha} by ${blame.author} on ${blame.date}).`,
      evidence: [`git blame ${blame.file}:${blame.line}`, blame.summary],
      likelihood: 0.64,
    });
  }

  if (/undefined|null|nil|none/.test(msg)) {
    hypotheses.push({
      id: "H3",
      description: "Null/undefined value reached a dereference. A missing guard or bad default is likely.",
      evidence: [evidence.error.message],
      likelihood: 0.58,
    });
  }

  if (/timeout|econnrefused|enotfound|network|socket/.test(msg)) {
    hypotheses.push({
      id: "H4",
      description: "Runtime/environment failure (network, service down, bad URL) rather than a logic bug.",
      evidence: [evidence.error.message, ...evidence.runtime.envHints],
      likelihood: 0.5,
    });
  }

  if (reproduction.attempted && !reproduction.reproduced) {
    hypotheses.push({
      id: "H5",
      description: "Could not reproduce locally. The failure may depend on production data, config, or a race.",
      evidence: [reproduction.summary],
      likelihood: 0.45,
    });
  }

  if (topFile && evidence.tests.relatedTests.length === 0) {
    hypotheses.push({
      id: "H6",
      description: `No related tests found for ${topFile}. The path may be untested.`,
      evidence: [`runner=${evidence.tests.runner ?? "unknown"}`],
      likelihood: 0.35,
    });
  }

  return hypotheses.sort((a, b) => b.likelihood - a.likelihood).slice(0, 5);
}

function recent(date: string): boolean {
  if (!date) return false;
  const then = Date.parse(date);
  if (!Number.isFinite(then)) return false;
  return Date.now() - then < 1000 * 60 * 60 * 24 * 21;
}

function suggestFixHint(message: string, source?: string): string | undefined {
  const msg = message.toLowerCase();
  if (/cannot read propert(?:y|ies).*undefined/.test(msg) || /undefined is not an object/.test(msg)) {
    return "Add a null/undefined check (or optional chaining / default) at the dereference in the top project frame.";
  }
  if (/is not a function/.test(msg)) {
    return "The callee is the wrong type. Check imports, mocking, and that the value is initialized before invocation.";
  }
  if (/module not found|cannot find module/.test(msg)) {
    return "Restore the missing dependency or correct the import path; confirm it is listed in the package manifest.";
  }
  if (source?.includes("TODO") || source?.includes("FIXME")) {
    return "The focused source contains TODO/FIXME markers near the crash line — those are a starting point.";
  }
  return undefined;
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}
