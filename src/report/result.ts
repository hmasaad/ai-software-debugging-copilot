import type { DebuggingReport, IncidentSeverity } from "../types.js";

const INNER = 38;

export function renderDebugResult(report: DebuggingReport): string {
  const severity = displaySeverity(report.incidentReport.severity);
  const confidence = Math.round(Math.max(report.rootCause.confidence, report.causeAnalysis.confidence) * 100);

  const lines: string[] = [
    "DEBUGGING RESULT",
    "",
    `Severity: ${severity}`,
    `Confidence: ${confidence}%`,
    "",
    "Root Cause:",
    ...wrap(report.rootCause.rootCause || report.causeAnalysis.summary),
    "",
    "Introduced:",
    ...wrap(introducedLine(report)),
    "",
    "Reproduction:",
    report.reproduction.reproduced
      ? "✓ Reproduced locally"
      : report.reproduction.attempted
        ? "✗ Did not reproduce"
        : "— Not run",
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
  const commit = report.gitInvestigation.introducing;
  const pr = report.gitInvestigation.pullRequests[0];
  const parts: string[] = [];
  if (commit) parts.push(`Commit ${commit.sha.slice(0, 7)}`);
  if (pr) parts.push(`PR #${pr.number}`);
  if (parts.length) return parts.join(" ");
  const blame = report.evidence.git.blame[0];
  if (blame) return `Commit ${blame.sha.slice(0, 7)}`;
  const recent = report.gitInvestigation.suspects[0] ?? report.evidence.git.commitsTouchingSuspects[0];
  if (recent) return `Commit ${recent.sha.slice(0, 7)}`;
  return "Unknown";
}

function validationLines(report: DebuggingReport): string[] {
  const existing = report.testAnalysis.relatedTests.length > 0 || report.evidence.tests.relatedTests.length > 0;
  const regression = Boolean(report.testAnalysis.proposedTest);
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
