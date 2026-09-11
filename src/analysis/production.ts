import type {
  BugInput,
  DebuggingMemory,
  GitInvestigation,
  ProductionIncident,
  RootCauseAnalysis,
} from "../types.js";

export function mergeProductionInput(bug: BugInput): BugInput {
  const parsed = parseProductionSignals([bug.extraContext, bug.logText, bug.message].filter(Boolean).join("\n"));
  return {
    ...bug,
    version: bug.version ?? parsed.version,
    affectedUsers: bug.affectedUsers ?? parsed.affectedUsers,
    firstSeen: bug.firstSeen ?? parsed.firstSeen,
    incidentSource: bug.incidentSource ?? parsed.incidentSource,
  };
}

export function parseProductionSignals(text?: string): Partial<
  Pick<BugInput, "version" | "affectedUsers" | "firstSeen" | "incidentSource">
> {
  if (!text?.trim()) return {};
  const fromJson = parseJsonSignals(text);
  const version =
    fromJson.version ??
    text.match(/\b(?:app[_\s-]?version|version|release)\s*[:=]\s*v?([\d]+(?:\.[\d]+){1,3})\b/i)?.[1];
  const affectedUsers = parseAffectedUsers(text, fromJson.affectedUsers);
  const firstSeen =
    fromJson.firstSeen ??
    text.match(/\bfirst\s+seen\s*[:=]\s*([^\n]+)/i)?.[1]?.trim() ??
    text.match(/\bfirstSeen\s*[:=]\s*["']?([^\n"']+)/i)?.[1]?.trim();
  const incidentSource = fromJson.incidentSource ?? inferSource(text);
  return { version, affectedUsers, firstSeen, incidentSource };
}

export function crashFingerprint(input: { errorType?: string; errorMessage?: string; file?: string }): string {
  const tokens = tokenize(input.errorMessage ?? "").slice(0, 6).join("-");
  return [input.errorType ?? "Error", input.file ? fileName(input.file) : "", tokens].filter(Boolean).join("|");
}

export function groupSimilarCrashes(
  memory?: DebuggingMemory,
  fingerprint?: string,
): { count: number; fingerprint?: string } {
  const count = memory?.matches.length ?? 0;
  return { count, fingerprint };
}

export function buildProductionIncident(input: {
  bug: BugInput;
  rootCause?: RootCauseAnalysis;
  gitInvestigation?: GitInvestigation;
  memory?: DebuggingMemory;
  suggestedFix?: string;
  groupedCount?: number;
  fingerprint?: string;
}): ProductionIncident | undefined {
  const bug = mergeProductionInput(input.bug);
  const version = bug.version;
  const affectedUsers = bug.affectedUsers;
  const introducing = input.gitInvestigation?.introducing;
  const firstSeen = bug.firstSeen ?? introducing?.date;
  const source = bug.incidentSource;
  const grouped = groupSimilarCrashes(input.memory, input.fingerprint);
  const groupedCount = input.groupedCount ?? (grouped.count || undefined);
  if (!version && affectedUsers == null && !firstSeen && !source) return undefined;

  const likelyCause = likelyCauseFrom(introducing?.subject, input.rootCause?.rootCause);
  const users = affectedUsers ?? 0;
  const recent = Boolean(introducing);
  const recommendedAction = recommendProductionAction({
    affectedUsers,
    introducing: recent,
    hasFix: Boolean(input.suggestedFix || input.rootCause),
  });
  const confidence = scoreProductionConfidence({
    source,
    version,
    firstSeen,
    users,
    recent,
    groupedCount: groupedCount ?? 0,
  });

  return {
    source: source ?? "local",
    version,
    affectedUsers,
    firstSeen,
    groupedCount,
    fingerprint: input.fingerprint ?? grouped.fingerprint,
    likelyCause,
    suggestedFix: input.suggestedFix,
    confidence,
    recommendedAction,
    summary: [
      version ? `Version ${version}` : undefined,
      affectedUsers != null ? `${affectedUsers} affected users` : undefined,
      firstSeen ? `first seen ${firstSeen}` : undefined,
      groupedCount ? `${groupedCount} similar crash${groupedCount === 1 ? "" : "es"}` : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

export function recommendProductionAction(input: {
  affectedUsers?: number;
  introducing?: boolean;
  hasFix?: boolean;
}): ProductionIncident["recommendedAction"] {
  const users = input.affectedUsers ?? 0;
  if (users >= 100 && input.introducing) return "rollback";
  if (input.hasFix) return "hotfix";
  return "investigate";
}

export function renderProductionIncidentAscii(incident: ProductionIncident): string {
  const action =
    incident.recommendedAction === "rollback"
      ? "Rollback / hotfix"
      : incident.recommendedAction === "hotfix"
        ? "Hotfix"
        : "Investigate";
  const lines = [
    "Production Crash",
    "",
    `Version: ${incident.version ?? "unknown"}`,
    `Affected users: ${incident.affectedUsers ?? "unknown"}`,
    `First seen: ${incident.firstSeen ?? "unknown"}`,
    incident.groupedCount ? `Similar crashes: ${incident.groupedCount}` : undefined,
    "",
    "Likely cause:",
    incident.likelyCause,
    "",
    `Confidence: ${Math.round(incident.confidence * 100)}%`,
    "",
    "Recommended action:",
    action,
  ];
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function likelyCauseFrom(subject?: string, rootCause?: string): string {
  if (subject) {
    const trimmed = subject.replace(/\.$/, "");
    return /^recent\b/i.test(trimmed) ? trimmed : `Recent ${trimmed}`;
  }
  return rootCause ?? "Cause not yet ranked.";
}

function scoreProductionConfidence(input: {
  source?: BugInput["incidentSource"];
  version?: string;
  firstSeen?: string;
  users: number;
  recent: boolean;
  groupedCount: number;
}): number {
  let confidence = 0.55;
  if (input.recent) confidence += 0.18;
  if (input.users >= 100) confidence += 0.08;
  if (input.source === "crashlytics" || input.source === "sentry") confidence += 0.04;
  if (input.version) confidence += 0.03;
  if (input.firstSeen) confidence += 0.03;
  if (input.groupedCount > 0) confidence += 0.04;
  return Math.min(0.96, Math.max(0.05, confidence));
}

function parseJsonSignals(text: string): Partial<Pick<BugInput, "version" | "affectedUsers" | "firstSeen" | "incidentSource">> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return {};
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const obj = Array.isArray(parsed) ? (parsed[0] as Record<string, unknown> | undefined) : parsed;
    if (!obj || typeof obj !== "object") return {};
    const version = stringField(obj, ["appVersion", "version", "release", "app_version"]);
    const affectedUsers = numberField(obj, ["affectedUsers", "users", "userCount", "numberOfUsers", "count"]);
    const firstSeen = stringField(obj, ["firstSeen", "first_seen", "datetime", "received", "timestamp"]);
    const logger = stringField(obj, ["logger", "source", "platform"]);
    const incidentSource = inferSource(`${logger ?? ""} ${JSON.stringify(obj)}`);
    return { version, affectedUsers, firstSeen, incidentSource };
  } catch {
    return {};
  }
}

function parseAffectedUsers(text: string, fallback?: number): number | undefined {
  if (fallback != null) return fallback;
  const match =
    text.match(/\baffected\s+users\s*[:=]\s*(\d+)/i)?.[1] ??
    text.match(/\busersAffected\s*[:=]\s*(\d+)/i)?.[1] ??
    text.match(/\b(\d+)\s+affected users\b/i)?.[1] ??
    text.match(/\buserCount\s*[:=]\s*(\d+)/i)?.[1];
  return match ? Number.parseInt(match, 10) : undefined;
}

function inferSource(text: string): BugInput["incidentSource"] | undefined {
  if (/crashlytics/i.test(text)) return "crashlytics";
  if (/\bsentry\b/i.test(text)) return "sentry";
  if (/\b(production logs|from logs|source[:\s]+logs)\b/i.test(text)) return "logs";
  return undefined;
}

function stringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function numberField(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  }
  return undefined;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 3);
}

function fileName(file: string): string {
  return file.replace(/\\/g, "/").split("/").pop() ?? file;
}
