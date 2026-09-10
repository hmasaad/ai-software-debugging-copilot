import { collectDependencies } from "../collectors/dependencies.js";
import type {
  AgentRun,
  DependencyAnalysis,
  DependencyEvidence,
  DependencyIssue,
  ParsedError,
  StackFrame,
} from "../types.js";
import { LogAnalyzerAgent } from "./log-analyzer.js";
import { DEPENDENCY_ANALYST, type AgentContext, type SpecialistAgent } from "./types.js";

/**
 * Dependency Analyst — detects dependency and version-related issues.
 */
export class DependencyAnalystAgent implements SpecialistAgent<DependencyAnalysis> {
  readonly id = DEPENDENCY_ANALYST.id;
  readonly name = DEPENDENCY_ANALYST.name;
  readonly responsibility = DEPENDENCY_ANALYST.responsibility;

  async run(ctx: AgentContext): Promise<{ result: DependencyAnalysis; run: AgentRun }> {
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

  async analyze(ctx: AgentContext): Promise<DependencyAnalysis> {
    const logAnalysis = ctx.logAnalysis ?? (await new LogAnalyzerAgent().analyze(ctx.input));
    const error = logAnalysis.error;
    const frames = error.frames;
    const evidence = await collectDependencies(ctx.input.repoPath, error, frames);
    const issues = classifyDependencyIssues(error, frames, evidence);
    const likelyDependencyBug = issues.some((issue) => issue.kind !== "none" && issue.likelihood >= 0.55);
    const summary = buildDepSummary(issues, evidence, likelyDependencyBug);
    const handoff = buildDepHandoff(issues, likelyDependencyBug);

    return { evidence, issues, likelyDependencyBug, summary, handoff };
  }
}

export function classifyDependencyIssues(
  error: ParsedError,
  frames: StackFrame[],
  evidence: DependencyEvidence,
): DependencyIssue[] {
  const text = `${error.type ?? ""} ${error.message}\n${error.stackTrace ?? ""}`;
  const issues: DependencyIssue[] = [];

  const missing = text.match(/cannot find module ['"]([^'"]+)['"]/i)
    ?? text.match(/cannot find package ['"]([^'"]+)['"]/i)
    ?? text.match(/ERR_MODULE_NOT_FOUND[\s\S]{0,80}['"]([^'"]+)['"]/i);
  if (missing?.[1]) {
    const name = missing[1];
    const listed = evidence.hits.some((hit) => hit.name === name || name.startsWith(`${hit.name}/`));
    issues.push({
      kind: listed ? "lockfile-drift" : "missing-module",
      package: name,
      detail: listed
        ? `${name} is declared in the manifest but could not be resolved — install or lockfile drift.`
        : `${name} is not resolvable and is not an overlapping declared dependency.`,
      likelihood: listed ? 0.72 : 0.88,
    });
  }

  if (/peer dep|requires a peer of|unmet peer/i.test(text)) {
    issues.push({
      kind: "peer-dependency",
      detail: "Peer dependency warning/error in the failure output.",
      likelihood: 0.7,
    });
  }

  if (/ERR_REQUIRE_ESM|does not provide an export named|Cannot use import statement outside a module/i.test(text)) {
    issues.push({
      kind: "esm-cjs",
      detail: "ESM/CJS interop failure — likely a package type or version mismatch.",
      likelihood: 0.68,
    });
  }

  const version = text.match(/requires\s+(\S+)\s+version\s+(\S+)/i);
  if (version?.[1]) {
    issues.push({
      kind: "version-mismatch",
      package: version[1],
      detail: `A version constraint failed for ${version[1]}.`,
      likelihood: 0.75,
    });
  }

  const inNodeModules = frames.some((frame) => frame.file.includes("node_modules") || frame.file.includes("site-packages"));
  if (inNodeModules && evidence.hits.length > 0) {
    issues.push({
      kind: "version-mismatch",
      package: evidence.hits[0]?.name,
      detail: `Stack passes through ${evidence.hits.map((h) => h.name).join(", ")} — consider a regression in those versions.`,
      likelihood: 0.5,
    });
  }

  if (issues.length === 0) {
    issues.push({
      kind: "none",
      detail: evidence.hits.length
        ? `Overlapping packages: ${evidence.hits.map((h) => h.name).join(", ")}. Failure looks like application code.`
        : "No dependency or version signal in the error.",
      likelihood: 0.15,
    });
  }

  return issues.sort((a, b) => b.likelihood - a.likelihood);
}

function buildDepSummary(issues: DependencyIssue[], evidence: DependencyEvidence, likely: boolean): string {
  const top = issues[0];
  if (!top || top.kind === "none") {
    return `No strong dependency/version signal${evidence.ecosystem ? ` (${evidence.ecosystem})` : ""}. Treat this as application code unless a later agent disagrees.`;
  }
  return `${likely ? "Likely" : "Possible"} ${top.kind}${top.package ? ` in ${top.package}` : ""}: ${top.detail}`;
}

function buildDepHandoff(issues: DependencyIssue[], likely: boolean): string[] {
  const top = issues[0];
  if (!top || top.kind === "none") {
    return ["Prefer a source-level fix; dependency/version looks unlikely."];
  }
  const notes = [top.detail];
  if (likely && top.package) notes.push(`Check ${top.package} in the lockfile and recent manifest commits.`);
  if (likely) notes.push("Do not patch application code until the install/version hypothesis is ruled out.");
  return notes;
}
