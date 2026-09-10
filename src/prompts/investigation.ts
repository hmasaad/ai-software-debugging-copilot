import type { BugInput, EvidenceBundle, ReproductionResult } from "../types.js";
import { truncate } from "../exec.js";

export function buildEvidenceBrief(
  input: BugInput,
  evidence: EvidenceBundle,
  reproduction: ReproductionResult,
): string {
  const frames = evidence.error.frames
    .slice(0, 12)
    .map((frame) => {
      const loc = `${frame.file}${frame.line ? `:${frame.line}` : ""}`;
      const fn = frame.functionName ? ` (${frame.functionName})` : "";
      return `- ${loc}${fn}${frame.inProject ? " [project]" : ""}`;
    })
    .join("\n");

  const snippets = evidence.sourceSnippets
    .map((snippet) => `### ${snippet.file}${snippet.focusLine ? `:${snippet.focusLine}` : ""}\n\`\`\`\n${snippet.content}\n\`\`\``)
    .join("\n\n");

  const commits = evidence.git.commitsTouchingSuspects
    .concat(evidence.git.recentCommits)
    .slice(0, 10)
    .map((c) => `- ${c.sha.slice(0, 8)} ${c.date} ${c.author}: ${c.subject}`)
    .join("\n");

  const blame = evidence.git.blame
    .map((b) => `- ${b.file}:${b.line} ${b.sha} ${b.author} (${b.date}) ${b.summary}`)
    .join("\n");

  const prs = evidence.pullRequests
    .slice(0, 6)
    .map((pr) => `- #${pr.number} ${pr.title} (${pr.state}) ${pr.url}`)
    .join("\n");

  const tests = evidence.tests.relatedTests
    .map((t) => `- ${t.file} — ${t.reason}`)
    .join("\n");

  const deps = evidence.dependencies.hits
    .map((d) => `- ${d.name}${d.version ? `@${d.version}` : ""} (${d.source})`)
    .join("\n");

  return truncate(
    [
      `## Log Analyzer`,
      evidence.logAnalysis?.summary ?? "",
      evidence.logAnalysis?.crashSite
        ? `Crash site: ${evidence.logAnalysis.crashSite.file}${evidence.logAnalysis.crashSite.line ? `:${evidence.logAnalysis.crashSite.line}` : ""}`
        : "",
      evidence.logAnalysis?.exceptionChain.length
        ? `Exception chain:\n${evidence.logAnalysis.exceptionChain.map((ex) => `- ${ex.role}: ${ex.type ?? "Error"}: ${ex.message}`).join("\n")}`
        : "",
      evidence.logAnalysis?.handoff.length ? `Handoff:\n${evidence.logAnalysis.handoff.map((h) => `- ${h}`).join("\n")}` : "",
      "",
      `## Code Investigator`,
      evidence.codeInvestigation?.summary ?? "",
      evidence.codeInvestigation?.trace.length
        ? `Trace:\n${evidence.codeInvestigation.trace
            .map((step) => `- ${step.role} ${step.file}${step.line ? `:${step.line}` : ""} ${step.note}`)
            .join("\n")}`
        : "",
      evidence.codeInvestigation?.suspects.length
        ? `Suspects: ${evidence.codeInvestigation.suspects.join(", ")}`
        : "",
      evidence.codeInvestigation?.handoff.length
        ? `Handoff:\n${evidence.codeInvestigation.handoff.map((h) => `- ${h}`).join("\n")}`
        : "",
      "",
      `## Git Investigator`,
      evidence.gitInvestigation?.summary ?? "",
      evidence.gitInvestigation?.introducing
        ? `Likely introducing commit: ${evidence.gitInvestigation.introducing.sha.slice(0, 8)} ${evidence.gitInvestigation.introducing.author} (${evidence.gitInvestigation.introducing.date}): ${evidence.gitInvestigation.introducing.subject}`
        : "",
      evidence.gitInvestigation?.suspects.length
        ? `Suspects:\n${evidence.gitInvestigation.suspects
            .map((c) => `- ${c.sha.slice(0, 8)} ${c.date} ${c.author}: ${c.subject} (${c.reasons.join("; ")})`)
            .join("\n")}`
        : "",
      evidence.gitInvestigation?.handoff.length
        ? `Handoff:\n${evidence.gitInvestigation.handoff.map((h) => `- ${h}`).join("\n")}`
        : "",
      "",
      `## Dependency Analyst`,
      evidence.dependencyAnalysis?.summary ?? "",
      evidence.dependencyAnalysis?.likelyDependencyBug ? "Treat as a dependency/version issue until proven otherwise." : "",
      evidence.dependencyAnalysis?.issues.length
        ? `Issues:\n${evidence.dependencyAnalysis.issues
            .map((issue) => `- ${issue.kind}${issue.package ? ` ${issue.package}` : ""}: ${issue.detail}`)
            .join("\n")}`
        : "",
      evidence.dependencyAnalysis?.handoff.length
        ? `Handoff:\n${evidence.dependencyAnalysis.handoff.map((h) => `- ${h}`).join("\n")}`
        : "",
      "",
      `## Reproduction Agent`,
      evidence.reproductionAnalysis?.summary ?? reproduction.summary,
      evidence.reproductionAnalysis?.method
        ? `Method: ${evidence.reproductionAnalysis.method}`
        : "",
      evidence.reproductionAnalysis?.command ?? (reproduction.command ? `Command: ${reproduction.command}` : ""),
      evidence.reproductionAnalysis?.steps.length
        ? `Steps:\n${evidence.reproductionAnalysis.steps.map((step) => `- ${step}`).join("\n")}`
        : "",
      evidence.reproductionAnalysis?.handoff.length
        ? `Handoff:\n${evidence.reproductionAnalysis.handoff.map((h) => `- ${h}`).join("\n")}`
        : "",
      "",
      `## Root Cause Agent`,
      evidence.causeAnalysis?.summary ?? "",
      evidence.causeAnalysis?.causes.length
        ? `Ranked causes:\n${evidence.causeAnalysis.causes
            .map((cause) => `- ${cause.id} ${cause.kind} (${cause.likelihood}): ${cause.description}`)
            .join("\n")}`
        : "",
      evidence.causeAnalysis?.handoff.length
        ? `Handoff:\n${evidence.causeAnalysis.handoff.map((h) => `- ${h}`).join("\n")}`
        : "",
      "",
      `## Fix Agent`,
      evidence.fixAnalysis?.summary ?? "",
      evidence.fixAnalysis ? `Strategy: ${evidence.fixAnalysis.strategy} (${evidence.fixAnalysis.source})` : "",
      evidence.fixAnalysis?.proposal.edits.length
        ? `Edits:\n${evidence.fixAnalysis.proposal.edits
            .map((edit) => `- ${edit.path}: ${edit.oldString} → ${edit.newString}`)
            .join("\n")}`
        : "",
      evidence.fixAnalysis?.handoff.length
        ? `Handoff:\n${evidence.fixAnalysis.handoff.map((h) => `- ${h}`).join("\n")}`
        : "",
      "",
      `## Test Agent`,
      evidence.testAnalysis?.summary ?? "",
      evidence.testAnalysis?.proposedTest
        ? `${evidence.testAnalysis.proposedTest.created ? "Created" : "Proposed"} test: ${evidence.testAnalysis.proposedTest.path}`
        : "",
      evidence.testAnalysis?.handoff.length
        ? `Handoff:\n${evidence.testAnalysis.handoff.map((h) => `- ${h}`).join("\n")}`
        : "",
      "",
      `## Validation Agent`,
      evidence.validationAnalysis?.summary ?? "",
      evidence.validationAnalysis ? `Verdict: ${evidence.validationAnalysis.verdict}` : "",
      evidence.validationAnalysis?.checks.length
        ? `Checks:\n${evidence.validationAnalysis.checks
            .map((check) => `- ${check.passed ? "pass" : "fail"} ${check.id}: ${check.detail}`)
            .join("\n")}`
        : "",
      "",
      `## Incident Agent`,
      evidence.incidentReport?.summary ?? "",
      evidence.incidentReport
        ? `${evidence.incidentReport.severity} ${evidence.incidentReport.status}: ${evidence.incidentReport.whatHappened}`
        : "",
      "",
      `## Bug`,
      input.message ? `Message: ${input.message}` : "",
      `Parsed: ${evidence.error.type ?? "Error"}: ${evidence.error.message}`,
      evidence.error.language ? `Language: ${evidence.error.language}` : "",
      input.failingTest ? `Failing test: ${input.failingTest}` : "",
      input.extraContext ? `Context: ${input.extraContext}` : "",
      "",
      `## Stack frames`,
      frames || "(none parsed)",
      "",
      `## Reproduction`,
      reproduction.summary,
      reproduction.command ? `Command: ${reproduction.command}` : "",
      reproduction.output ? `Output:\n${truncate(reproduction.output, 4000)}` : "",
      "",
      `## Source`,
      snippets || "(no source snippets)",
      "",
      `## Git`,
      evidence.git.available
        ? `Branch ${evidence.git.branch ?? "?"} @ ${evidence.git.head ?? "?"}`
        : "Not a git repository",
      evidence.git.status ? `Status:\n${evidence.git.status}` : "",
      commits ? `Commits:\n${commits}` : "",
      blame ? `Blame:\n${blame}` : "",
      "",
      `## Recent PRs`,
      prs || "(none or gh unavailable)",
      "",
      `## Tests`,
      `Runner: ${evidence.tests.runner ?? "unknown"}`,
      `Command: ${evidence.tests.testCommand ?? "unknown"}`,
      tests || "(no related tests found)",
      "",
      `## Dependencies`,
      deps || "(no overlapping dependencies)",
      "",
      `## Runtime`,
      `${evidence.runtime.os}/${evidence.runtime.arch} node=${evidence.runtime.node ?? "n/a"} python=${evidence.runtime.python ?? "n/a"} ci=${evidence.runtime.ci}`,
      evidence.runtime.envHints.join(", "),
      "",
      `## Logs`,
      truncate(evidence.logs.excerpt, 3000),
    ]
      .filter((line) => line !== "")
      .join("\n"),
    24_000,
  );
}

export function rcaSystemPrompt(): string {
  return `You are a staff software engineer performing root-cause analysis.
Investigate like an engineer: use the evidence, do not speculate beyond it, and rank competing hypotheses.
Return ONLY valid JSON with this shape:
{
  "summary": "one paragraph",
  "rootCause": "the single most likely root cause",
  "confidence": 0.0,
  "hypotheses": [
    { "id": "H1", "description": "...", "evidence": ["..."], "likelihood": 0.0 }
  ],
  "affectedFiles": ["path"],
  "reproSteps": ["step"]
}
confidence and likelihood are numbers between 0 and 1.
Prefer project frames over framework/library frames.
Recent git blame + failing tests that overlap a stack frame are strong evidence.
If Git Investigator names an introducing commit, treat that as historical context, not proof by itself.
If Dependency Analyst marks a likely dependency bug, prefer install/version hypotheses over application-code patches.
Start from Root Cause Agent's ranked causes and only reorder them when new evidence in this brief contradicts them.
Follow Reproduction Agent steps when listing reproSteps.`;
}

export function fixSystemPrompt(): string {
  return `You are a staff software engineer proposing a minimal, verified-ready fix.
Return ONLY valid JSON with this shape:
{
  "summary": "what the fix does",
  "rationale": "why this addresses the root cause",
  "edits": [
    { "path": "relative/path.ext", "oldString": "exact existing text", "newString": "replacement" }
  ],
  "testPlan": ["how to verify"],
  "risks": ["risk"]
}
Rules:
- oldString must match the file contents in the evidence EXACTLY, including whitespace.
- Prefer the smallest correct change.
- Do not change unrelated files.
- Fix Agent will apply this as a minimal patch; keep edits to the crash expression when possible.
- Do not include markdown fences in JSON strings unless they already exist in the source.
- If you cannot produce a safe edit, return an empty edits array and explain in summary.`;
}

export function parseJsonObject<T>(text: string): T {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end < 0) {
    throw new Error("Model did not return JSON");
  }
  return JSON.parse(stripped.slice(start, end + 1)) as T;
}
