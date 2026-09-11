import path from "node:path";
import type { DebuggingReport, IncidentSeverity } from "../types.js";

const INNER = 38;

export function renderDebugResult(report: DebuggingReport): string {
  const graph = report.causeAnalysis.graph;
  const severity = displaySeverity(report.incidentReport.severity);
  const confidence = Math.round((graph?.confidence ?? Math.max(report.rootCause.confidence, report.causeAnalysis.confidence)) * 100);
  const supporting = graph?.supporting ?? [];
  const contradicting = graph?.contradicting ?? [];

  const lines: string[] = [
    "DEBUGGING RESULT",
    "",
    `Severity: ${severity}`,
    `Confidence: ${confidence}%`,
    "",
    ...(report.classification
      ? ["Class:", ...wrap(report.classification.summary), ""]
      : []),
    "Root Cause:",
    ...wrap(graph?.claim || report.rootCause.rootCause || report.causeAnalysis.summary),
    "",
    "Introduced:",
    ...wrap(introducedLine(report)),
    "",
    ...(report.iterations.length
      ? ["Attempts:", ...report.iterations.map((iteration) => iteration.summary), ""]
      : []),
    "Reproduction:",
    report.reproduction.reproduced
      ? report.reproductionAnalysis.match === "matched"
        ? "✓ Reproduced locally"
        : "✓ Failed locally (partial match)"
      : report.reproduction.attempted
        ? "✗ Did not reproduce"
        : "— Not run",
    "",
    "Evidence:",
    ...(supporting.length
      ? supporting.map((check) => mark(check.present && check.supports, check.label))
      : ["—"]),
    "",
    "Contradicting evidence:",
    ...(contradicting.length ? contradicting.map((check) => `✗ ${check.label}`) : ["None"]),
    "",
    "Recommended Fix:",
    ...wrap(report.proposedFix.rationale || report.proposedFix.summary || "No fix proposed."),
    "",
    "Validation:",
    ...validationLines(report),
    "",
    "Risk:",
    riskLine(report),
  ];

  return paint(lines);
}

function displaySeverity(severity: IncidentSeverity): string {
  switch (severity) {
    case "sev-1":
      return "CRITICAL";
    case "sev-2":
      return "HIGH";
    case "sev-3":
      return "MEDIUM";
    default:
      return "LOW";
  }
}

function introducedLine(report: DebuggingReport): string {
  const regression = report.gitInvestigation.regression;
  if (regression) {
    const parts = [`Commit ${regression.commit.sha.slice(0, 7)}`, regression.commit.author];
    if (regression.pullRequest) parts.push(`PR #${regression.pullRequest.number}`);
    const files = regression.changed.slice(0, 3).map((file) => path.basename(file));
    if (files.length) parts.push(files.join(", "));
    parts.push(`${Math.round(regression.confidence * 100)}%`);
    return parts.filter(Boolean).join(" ");
  }
  const commit = report.gitInvestigation.introducing;
  if (commit) {
    const pr = report.gitInvestigation.pullRequests.find((item) => item.overlap?.length);
    return [`Commit ${commit.sha.slice(0, 7)}`, commit.author, pr ? `PR #${pr.number}` : ""]
      .filter(Boolean)
      .join(" ");
  }
  const blame = report.evidence.git.blame[0];
  if (blame) return `Commit ${blame.sha.slice(0, 7)}`;
  const recent = report.gitInvestigation.suspects[0] ?? report.evidence.git.commitsTouchingSuspects[0];
  if (recent) return `Commit ${recent.sha.slice(0, 7)}`;
  return "Unknown";
}

function validationLines(report: DebuggingReport): string[] {
  const existing = report.testAnalysis.relatedTests.length > 0 || report.evidence.tests.relatedTests.length > 0;
  const regression = Boolean(report.testAnalysis.proposedTest || report.reproductionAnalysis.generatedTest);
  const suiteRan = report.verification.testsRan;
  const passed = report.verification.passed;
  const resolved = report.validationAnalysis.resolved || report.validationAnalysis.verdict === "likely-resolved";
  const lines = [
    mark(existing, "Existing tests"),
    mark(regression, "New regression test"),
    mark(suiteRan && passed, suiteRan ? "Full test suite" : "Full test suite (not run)"),
  ];
  if (report.sandbox?.reverted) lines.push("✗ Reverted (validation failed)");
  else if (report.sandbox?.promoted) lines.push("✓ Promoted to original repo");
  else if (resolved && report.proposedFix.edits.length > 0 && !report.proposedFix.applied) {
    lines.push("✓ Sandbox only (not promoted)");
  }
  return lines;
}

function riskLine(report: DebuggingReport): string {
  if (report.sandbox?.reverted) return "HIGH";
  if (report.validationAnalysis.residualRisks.length > 0) return "MEDIUM";
  if (report.validationAnalysis.resolved || report.validationAnalysis.verdict === "likely-resolved") return "LOW";
  if (report.validationAnalysis.verdict === "unresolved") return "HIGH";
  return "MEDIUM";
}

function mark(ok: boolean, label: string): string {
  return `${ok ? "✓" : "✗"} ${label}`;
}

function wrap(text: string, width = INNER - 1): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let rest = paragraph.replace(/\s+/g, " ").trim();
    if (!rest) continue;
    while (rest.length > width) {
      let cut = rest.lastIndexOf(" ", width);
      if (cut < Math.floor(width / 2)) cut = width;
      lines.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) lines.push(rest);
  }
  return lines.length ? lines : ["—"];
}

function paint(lines: string[]): string {
  const bar = "═".repeat(INNER);
  const body = lines.map((line) => `║${pad(line)}║`).join("\n");
  return `╔${bar}╗\n${body}\n╚${bar}╝`;
}

function pad(line: string): string {
  const body = line.length ? ` ${line}` : "";
  const chars = Array.from(body);
  if (chars.length >= INNER) return chars.slice(0, INNER).join("");
  return body + " ".repeat(INNER - chars.length);
}
