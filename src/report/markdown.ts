import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderEnvironmentAscii } from "../collectors/runtime.js";
import { renderProductionIncidentAscii } from "../analysis/production.js";
import { renderBlastRadiusAscii } from "../analysis/blast-radius.js";
import type { DebuggingReport } from "../types.js";

export function renderMarkdownReport(report: DebuggingReport): string {
  const e = report.evidence;
  const rca = report.rootCause;
  const fix = report.proposedFix;

  const hypotheses = rca.hypotheses
    .map((h) => `- **${h.id}** (${pct(h.likelihood)}) ${h.description}\n  - Evidence: ${h.evidence.join("; ") || "n/a"}`)
    .join("\n");

  const frames = e.error.frames
    .slice(0, 15)
    .map((f) => `- \`${f.file}${f.line ? `:${f.line}` : ""}\`${f.functionName ? ` — ${f.functionName}` : ""}${f.inProject ? " *(project)*" : ""}`)
    .join("\n");

  const snippets = e.sourceSnippets
    .map((s) => `### ${s.file}${s.focusLine ? `:${s.focusLine}` : ""}\n\n\`\`\`${s.language ?? ""}\n${s.content}\n\`\`\``)
    .join("\n\n");

  const commits = e.git.commitsTouchingSuspects
    .concat(e.git.recentCommits)
    .filter((c, i, arr) => arr.findIndex((x) => x.sha === c.sha) === i)
    .slice(0, 10)
    .map((c) => `- \`${c.sha.slice(0, 8)}\` ${c.date} ${c.author}: ${c.subject}`)
    .join("\n");

  const blame = e.git.blame
    .map((b) => `- \`${b.file}:${b.line}\` ${b.sha} ${b.author} (${b.date}) ${b.summary}`)
    .join("\n");

  const prs = e.pullRequests
    .map((pr) => `- [#${pr.number}](${pr.url}) ${pr.title} (${pr.state}${pr.author ? `, ${pr.author}` : ""})`)
    .join("\n");

  const tests = e.tests.relatedTests.map((t) => `- \`${t.file}\` — ${t.reason}`).join("\n");
  const deps = e.dependencies.hits.map((d) => `- ${d.name}${d.version ? ` @ ${d.version}` : ""}`).join("\n");
  const edits = fix.edits
    .map((edit) => `### ${edit.path}\n\n\`\`\`diff\n- ${oneLine(edit.oldString)}\n+ ${oneLine(edit.newString)}\n\`\`\``)
    .join("\n\n");

  const iterationNotes = report.iterations
    .map((it) => {
      const status = it.verification.passed ? "passed" : it.verification.testsRan ? "failed" : "not run";
      return `- Pass ${it.index + 1}: ${it.rootCause.investigator} — tests ${status}. ${it.fix.summary}`;
    })
    .join("\n");

  return [
    `# ${report.title}`,
    "",
    `_Generated ${report.createdAt} on \`${report.repoPath}\`_`,
    "",
    "## Outcome",
    "",
    `- **Root cause** (${pct(rca.confidence)} confidence, ${rca.investigator}): ${rca.rootCause}`,
    `- **Fix:** ${fix.summary}${fix.applied ? " *(applied)*" : " *(not applied)*"}`,
    `- **Verification:** ${report.verification.summary}`,
    ...report.notes.map((note) => `- ${note}`),
    "",
    report.classification
      ? `## Failure classification\n\n**${report.classification.summary}** (${pct(report.classification.confidence)})\nRouted: ${report.classification.routedAgents.join(", ") || "core agents"}`
      : "",
    "",
    report.specialists
      ? [
          "## Specialized agents",
          "",
          "Debugging Orchestrator → Crash · Network · DB · Flutter · Dependency → Root Cause Agent",
          report.specialists.crash ? `\n**Crash Agent:** ${report.specialists.crash.summary}` : "",
          report.specialists.network ? `\n**Network Agent:** ${report.specialists.network.summary}` : "",
          report.specialists.database ? `\n**Database Agent:** ${report.specialists.database.summary}` : "",
          report.specialists.flutter
            ? `\n**Flutter Debugging Agent:** ${report.specialists.flutter.summary}${
                report.specialists.flutter.handoff.length
                  ? `\n${report.specialists.flutter.handoff.map((note) => `- ${note}`).join("\n")}`
                  : ""
              }`
            : "",
          report.specialists.dependency ? `\n**Dependency Analyst:** ${report.specialists.dependency.summary}` : "",
        ].join("\n")
      : "",
    "",
    report.iterations.length
      ? `## Patch → test → verify\n\n${report.iterations.map((it) => `- ${it.summary}`).join("\n")}`
      : "",
    "",
    report.environment
      ? `## Environment\n\n${renderEnvironmentAscii(report.environment)}${
          report.environment.mismatches.length ? `\n\n${report.environment.summary}` : ""
        }`
      : "",
    "",
    report.blastRadius
      ? `## Blast radius\n\n${renderBlastRadiusAscii(report.blastRadius)}`
      : "",
    "",
    report.memory ? `## Debugging memory\n\n${report.memory.summary}` : "",
    "",
    report.production
      ? `## Production incident\n\n${renderProductionIncidentAscii(report.production)}${
          report.production.suggestedFix ? `\n\nSuggested fix: ${report.production.suggestedFix}` : ""
        }${
          report.production.groupedCount
            ? `\n\nGrouped ${report.production.groupedCount} similar crash${report.production.groupedCount === 1 ? "" : "es"}.`
            : ""
        }`
      : "",
    "",
    report.agentRuns.length
      ? `## Core agents\n\n${report.agentRuns
          .map((run) => `- **${run.name}** — ${run.responsibility}\n  ${run.summary}`)
          .join("\n")}`
      : "",
    "",
    report.logAnalysis
      ? [
          "## Log Analyzer",
          "",
          report.logAnalysis.summary,
          report.logAnalysis.crashSite
            ? `\nCrash site: \`${report.logAnalysis.crashSite.file}${report.logAnalysis.crashSite.line ? `:${report.logAnalysis.crashSite.line}` : ""}\``
            : "",
          report.logAnalysis.exceptionChain.length
            ? `\nException chain:\n${report.logAnalysis.exceptionChain
                .map((ex) => `- ${ex.role}: \`${ex.type ?? "Error"}\`: ${ex.message}`)
                .join("\n")}`
            : "",
          report.logAnalysis.handoff.length
            ? `\nHandoff:\n${report.logAnalysis.handoff.map((note) => `- ${note}`).join("\n")}`
            : "",
        ].join("\n")
      : "",
    "",
    report.codeInvestigation
      ? [
          "## Code Investigator",
          "",
          report.codeInvestigation.summary,
          report.codeInvestigation.trace.length
            ? `\nTrace:\n${report.codeInvestigation.trace
                .map(
                  (step) =>
                    `- **${step.role}** \`${step.file}${step.line ? `:${step.line}` : ""}\`${step.functionName ? ` ${step.functionName}` : ""} — ${step.note}`,
                )
                .join("\n")}`
            : "",
          report.codeInvestigation.suspects.length
            ? `\nSuspects: ${report.codeInvestigation.suspects.map((name) => `\`${name}\``).join(", ")}`
            : "",
          report.codeInvestigation.handoff.length
            ? `\nHandoff:\n${report.codeInvestigation.handoff.map((note) => `- ${note}`).join("\n")}`
            : "",
        ].join("\n")
      : "",
    "",
    report.gitInvestigation
      ? [
          "## Git Investigator",
          "",
          report.gitInvestigation.summary,
          report.gitInvestigation.regression
            ? [
                "",
                "Likely introduced by:",
                "",
                `- **Commit:** \`${report.gitInvestigation.regression.commit.sha.slice(0, 7)}\``,
                `- **Author:** ${report.gitInvestigation.regression.commit.author}`,
                `- **PR:** ${report.gitInvestigation.regression.pullRequest ? `#${report.gitInvestigation.regression.pullRequest.number}` : "none"}`,
                report.gitInvestigation.regression.changed.length
                  ? `\nChanged:\n${report.gitInvestigation.regression.changed.map((file) => `- \`${file}\``).join("\n")}`
                  : "",
                `\nConfidence: ${Math.round(report.gitInvestigation.regression.confidence * 100)}%`,
                report.gitInvestigation.regression.pullRequest?.title
                  ? `\nPR inspection: [#${report.gitInvestigation.regression.pullRequest.number} ${report.gitInvestigation.regression.pullRequest.title}](${report.gitInvestigation.regression.pullRequest.url})${report.gitInvestigation.regression.pullRequest.author ? ` (${report.gitInvestigation.regression.pullRequest.author})` : ""}`
                  : "",
                report.gitInvestigation.regression.pullRequest?.body
                  ? `\n${report.gitInvestigation.regression.pullRequest.body.split("\n").slice(0, 8).join("\n")}`
                  : "",
                report.gitInvestigation.regression.diffExcerpt
                  ? `\nDiff excerpt:\n\`\`\`\n${report.gitInvestigation.regression.diffExcerpt}\n\`\`\``
                  : "",
              ].join("\n")
            : report.gitInvestigation.introducing
              ? `\nLikely introducing commit: \`${report.gitInvestigation.introducing.sha.slice(0, 8)}\` ${report.gitInvestigation.introducing.author} (${report.gitInvestigation.introducing.date}): ${report.gitInvestigation.introducing.subject}`
              : "",
          report.gitInvestigation.suspects.length
            ? `\nSuspects:\n${report.gitInvestigation.suspects
                .map(
                  (commit) =>
                    `- \`${commit.sha.slice(0, 8)}\` ${commit.date} ${commit.author}: ${commit.subject} — ${commit.reasons.join("; ")}`,
                )
                .join("\n")}`
            : "",
          report.gitInvestigation.pullRequests.length
            ? `\nRelated PRs:\n${report.gitInvestigation.pullRequests
                .map((pr) => `- [#${pr.number}](${pr.url}) ${pr.title} (${pr.state})`)
                .join("\n")}`
            : "",
          report.gitInvestigation.handoff.length
            ? `\nHandoff:\n${report.gitInvestigation.handoff.map((note) => `- ${note}`).join("\n")}`
            : "",
        ].join("\n")
      : "",
    "",
    report.dependencyAnalysis
      ? [
          "## Dependency Analyst",
          "",
          report.dependencyAnalysis.summary,
          report.dependencyAnalysis.issues.length
            ? `\nIssues:\n${report.dependencyAnalysis.issues
                .map(
                  (issue) =>
                    `- **${issue.kind}**${issue.package ? ` \`${issue.package}\`` : ""} (${pct(issue.likelihood)}): ${issue.detail}`,
                )
                .join("\n")}`
            : "",
          report.dependencyAnalysis.handoff.length
            ? `\nHandoff:\n${report.dependencyAnalysis.handoff.map((note) => `- ${note}`).join("\n")}`
            : "",
        ].join("\n")
      : "",
    "",
    report.reproductionAnalysis
      ? [
          "## Reproduction Agent",
          "",
          report.reproductionAnalysis.summary,
          `\nMethod: \`${report.reproductionAnalysis.method}\` · match \`${report.reproductionAnalysis.match}\` (${pct(report.reproductionAnalysis.confidence)})${report.reproductionAnalysis.command ? ` · \`${report.reproductionAnalysis.command}\`` : ""}`,
          `\nSymptoms: ${report.reproductionAnalysis.symptoms.summary}`,
          `\nScenario: ${report.reproductionAnalysis.scenario.title}`,
          report.reproductionAnalysis.steps.length
            ? `\nSteps:\n${report.reproductionAnalysis.steps.map((step) => `- ${step}`).join("\n")}`
            : "",
          report.reproductionAnalysis.relatedTests.length
            ? `\nRelated tests:\n${report.reproductionAnalysis.relatedTests.map((t) => `- \`${t.file}\` — ${t.reason}`).join("\n")}`
            : "",
          report.reproductionAnalysis.generatedTest
            ? `\n${report.reproductionAnalysis.generatedTest.created ? "Wrote" : "Proposed"} repro test: \`${report.reproductionAnalysis.generatedTest.path}\`\n\n\`\`\`\n${report.reproductionAnalysis.generatedTest.content}\n\`\`\``
            : "",
          report.reproductionAnalysis.capturedFailure
            ? `\nCaptured: ${report.reproductionAnalysis.capturedFailure.type ?? "failure"}: ${report.reproductionAnalysis.capturedFailure.message ?? report.reproductionAnalysis.capturedFailure.excerpt}`
            : "",
          `\nCompare: ${report.reproductionAnalysis.matchDetail}`,
          report.reproductionAnalysis.handoff.length
            ? `\nHandoff:\n${report.reproductionAnalysis.handoff.map((note) => `- ${note}`).join("\n")}`
            : "",
        ].join("\n")
      : "",
    "",
    report.causeAnalysis
      ? [
          "## Root Cause Agent",
          "",
          report.causeAnalysis.summary,
          report.causeAnalysis.graph
            ? [
                "",
                "### Evidence graph",
                "",
                report.causeAnalysis.graph.nodes.map((node) => node.label).join(" → "),
                "",
                `**Root Cause:** ${report.causeAnalysis.graph.claim}`,
                `**Confidence:** ${pct(report.causeAnalysis.graph.confidence)}`,
                "",
                "Evidence:",
                ...report.causeAnalysis.graph.supporting.map(
                  (check) => `- ${check.present && check.supports ? "✓" : "✗"} **${check.label}**: ${check.detail}`,
                ),
                "",
                "Contradicting evidence:",
                ...(report.causeAnalysis.graph.contradicting.length
                  ? report.causeAnalysis.graph.contradicting.map((check) => `- ✗ **${check.label}**: ${check.detail}`)
                  : ["- None"]),
              ].join("\n")
            : "",
          report.causeAnalysis.causes.length
            ? `\nRanked causes:\n${report.causeAnalysis.causes
                .map(
                  (cause) =>
                    `- **${cause.id}** \`${cause.kind}\` (${pct(cause.likelihood)}): ${cause.description}`,
                )
                .join("\n")}`
            : "",
          report.causeAnalysis.affectedFiles.length
            ? `\nAffected files: ${report.causeAnalysis.affectedFiles.map((file) => `\`${file}\``).join(", ")}`
            : "",
          report.causeAnalysis.handoff.length
            ? `\nHandoff:\n${report.causeAnalysis.handoff.map((note) => `- ${note}`).join("\n")}`
            : "",
        ].join("\n")
      : "",
    "",
    report.fixAnalysis
      ? [
          "## Fix Agent",
          "",
          report.fixAnalysis.summary,
          `\nStrategy: \`${report.fixAnalysis.strategy}\` (${report.fixAnalysis.source})`,
          report.fixAnalysis.proposal.edits.length
            ? `\nEdits:\n${report.fixAnalysis.proposal.edits
                .map((edit) => `- \`${edit.path}\`\n\`\`\`diff\n- ${oneLine(edit.oldString)}\n+ ${oneLine(edit.newString)}\n\`\`\``)
                .join("\n")}`
            : "",
          report.fixAnalysis.handoff.length
            ? `\nHandoff:\n${report.fixAnalysis.handoff.map((note) => `- ${note}`).join("\n")}`
            : "",
        ].join("\n")
      : "",
    "",
    report.testAnalysis
      ? [
          "## Test Agent",
          "",
          report.testAnalysis.summary,
          report.testAnalysis.proposedTest
            ? `\n${report.testAnalysis.proposedTest.created ? "Created" : "Proposed"} test: \`${report.testAnalysis.proposedTest.path}\` — ${report.testAnalysis.proposedTest.reason}`
            : "",
          report.testAnalysis.handoff.length
            ? `\nHandoff:\n${report.testAnalysis.handoff.map((note) => `- ${note}`).join("\n")}`
            : "",
        ].join("\n")
      : "",
    "",
    report.validationAnalysis
      ? [
          "## Validation Agent",
          "",
          report.validationAnalysis.summary,
          `\nVerdict: \`${report.validationAnalysis.verdict}\``,
          report.validationAnalysis.checks.length
            ? `\nChecks:\n${report.validationAnalysis.checks
                .map((check) => `- ${check.passed ? "pass" : "fail"} **${check.id}**: ${check.detail}`)
                .join("\n")}`
            : "",
          report.validationAnalysis.residualRisks.length
            ? `\nResidual risks:\n${report.validationAnalysis.residualRisks.map((risk) => `- ${risk}`).join("\n")}`
            : "",
        ].join("\n")
      : "",
    "",
    report.incidentReport
      ? [
          "## Incident Agent",
          "",
          `**${report.incidentReport.severity.toUpperCase()}** · ${report.incidentReport.status}`,
          "",
          report.incidentReport.body,
        ].join("\n")
      : "",
    "",
    report.sandbox
      ? [
          "## Autonomous sandbox",
          "",
          `- **Kind:** ${report.sandbox.kind}`,
          `- **Workspace:** \`${report.sandbox.path}\``,
          `- **Promoted:** ${report.sandbox.promoted ? "yes" : "no"}`,
          `- **Reverted:** ${report.sandbox.reverted ? "yes" : "no"}`,
          report.sandbox.actions.length
            ? `\nActions:\n${report.sandbox.actions
                .map((action) => `- ${action.ok ? "ok" : "fail"} **${action.tool}**: ${action.detail}`)
                .join("\n")}`
            : "",
        ].join("\n")
      : "",
    "",
    "## Error",
    "",
    `\`\`\`\n${e.error.type ? `${e.error.type}: ` : ""}${e.error.message}\n\`\`\``,
    "",
    frames ? `### Stack frames\n\n${frames}` : "",
    "",
    "## Reproduction",
    "",
    report.reproduction.summary,
    report.reproduction.command ? `\nCommand: \`${report.reproduction.command}\`` : "",
    report.reproduction.output ? `\n\n\`\`\`\n${report.reproduction.output}\n\`\`\`` : "",
    "",
    "## Root cause analysis",
    "",
    rca.summary,
    "",
    hypotheses ? `### Hypotheses\n\n${hypotheses}` : "",
    "",
    rca.affectedFiles.length ? `Affected files: ${rca.affectedFiles.map((f) => `\`${f}\``).join(", ")}` : "",
    rca.reproSteps.length ? `\n### Repro steps\n\n${rca.reproSteps.map((s) => `- ${s}`).join("\n")}` : "",
    "",
    "## Proposed fix",
    "",
    fix.rationale,
    "",
    edits || "_No file edits were generated._",
    "",
    fix.testPlan.length ? `### Test plan\n\n${fix.testPlan.map((s) => `- ${s}`).join("\n")}` : "",
    fix.risks.length ? `\n### Risks\n\n${fix.risks.map((s) => `- ${s}`).join("\n")}` : "",
    fix.applyErrors.length ? `\n### Apply errors\n\n${fix.applyErrors.map((s) => `- ${s}`).join("\n")}` : "",
    "",
    "## Verification",
    "",
    report.verification.command ? `Command: \`${report.verification.command}\`` : "",
    "",
    report.verification.output ? `\`\`\`\n${report.verification.output}\n\`\`\`` : report.verification.summary,
    "",
    iterationNotes ? `### Iterations\n\n${iterationNotes}` : "",
    "",
    "## Evidence",
    "",
    "### Source",
    "",
    snippets || "_No source snippets._",
    "",
    "### Git history",
    "",
    e.git.available ? `Branch \`${e.git.branch ?? "?"}\` @ \`${e.git.head ?? "?"}\`` : "Git history unavailable.",
    e.git.status ? `\n\nWorking tree:\n\`\`\`\n${e.git.status}\n\`\`\`` : "",
    commits ? `\n\n${commits}` : "",
    blame ? `\n\nBlame:\n${blame}` : "",
    "",
    "### Recent PRs",
    "",
    prs || "_None collected (install GitHub CLI `gh` and authenticate to include PRs)._",
    "",
    "### Tests",
    "",
    `Runner: \`${e.tests.runner ?? "unknown"}\` — command: \`${e.tests.testCommand ?? "n/a"}\``,
    tests ? `\n\n${tests}` : "",
    "",
    "### Dependencies",
    "",
    deps || "_No overlapping dependencies._",
    "",
    "### Runtime context",
    "",
    `- OS: ${e.runtime.os}/${e.runtime.arch}`,
    `- Node: ${e.runtime.node ?? "n/a"}`,
    `- Python: ${e.runtime.python ?? "n/a"}`,
    `- CI: ${e.runtime.ci}`,
    e.runtime.envHints.length ? `- Env: ${e.runtime.envHints.join(", ")}` : "",
    "",
    "### Logs",
    "",
    e.logs.sources.length ? `Sources: ${e.logs.sources.join(", ")}` : "",
    "",
    e.logs.excerpt ? `\`\`\`\n${e.logs.excerpt}\n\`\`\`` : "_No logs._",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

export async function writeReports(
  report: DebuggingReport,
  paths: { markdownPath?: string; jsonPath?: string },
): Promise<void> {
  if (paths.markdownPath) {
    await mkdir(path.dirname(path.resolve(paths.markdownPath)), { recursive: true });
    await writeFile(paths.markdownPath, renderMarkdownReport(report), "utf8");
  }
  if (paths.jsonPath) {
    await mkdir(path.dirname(path.resolve(paths.jsonPath)), { recursive: true });
    await writeFile(paths.jsonPath, JSON.stringify(report, null, 2), "utf8");
  }
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function oneLine(text: string): string {
  return text.replace(/\n/g, "\\n");
}
