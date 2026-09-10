import type { BugInput, GitInvestigation, ProductionIncident, RootCauseAnalysis } from "../types.js";

export function buildProductionIncident(input: {
  bug: BugInput;
  rootCause?: RootCauseAnalysis;
  gitInvestigation?: GitInvestigation;
  groupedCount?: number;
  confidence?: number;
}): ProductionIncident | undefined {
  const version = input.bug.version;
  const affectedUsers = input.bug.affectedUsers;
  const firstSeen = input.bug.firstSeen;
  const source = input.bug.incidentSource;
  if (!version && affectedUsers == null && !firstSeen && !source) return undefined;

  const introducing = input.gitInvestigation?.introducing?.subject;
  const likelyCause =
    introducing && /firebase|init|config|release/i.test(introducing)
      ? introducing
      : input.rootCause?.rootCause ?? introducing ?? "Cause not yet ranked.";
  const users = affectedUsers ?? 0;
  const recent = Boolean(input.gitInvestigation?.introducing);
  const recommendedAction = users >= 100 && recent ? "rollback" : input.rootCause ? "hotfix" : "investigate";
  const confidence = input.confidence ?? (recent ? 0.86 : 0.6);

  return {
    source: source ?? "local",
    version,
    affectedUsers,
    firstSeen,
    groupedCount: input.groupedCount,
    likelyCause,
    confidence,
    recommendedAction,
    summary: [
      version ? `Version ${version}` : undefined,
      affectedUsers != null ? `${affectedUsers} affected users` : undefined,
      firstSeen ? `first seen ${firstSeen}` : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

export function renderProductionIncidentAscii(incident: ProductionIncident): string {
  const action =
    incident.recommendedAction === "rollback"
      ? "Rollback / hotfix"
      : incident.recommendedAction === "hotfix"
        ? "Hotfix"
        : "Investigate";
  return [
    "Production Crash",
    "",
    `Version: ${incident.version ?? "unknown"}`,
    `Affected users: ${incident.affectedUsers ?? "unknown"}`,
    `First seen: ${incident.firstSeen ?? "unknown"}`,
    incident.groupedCount ? `Similar crashes: ${incident.groupedCount}` : "",
    "",
    "Likely cause:",
    incident.likelyCause,
    "",
    `Confidence: ${Math.round(incident.confidence * 100)}%`,
    "",
    "Recommended action:",
    action,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
