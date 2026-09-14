import { crashFingerprint, mergeProductionInput } from "./production.js";
import type {
  BugInput,
  CorrelationEvent,
  CorrelationEventKind,
  CorrelationLink,
  DependencyAnalysis,
  GitInvestigation,
  IncidentCorrelation,
  LogAnalysis,
  ProductionMetrics,
} from "../types.js";

const EVENT_ORDER: CorrelationEventKind[] = [
  "crash-spike",
  "latency-spike",
  "deployment",
  "new-dependency",
  "app-version",
];

/**
 * Turn independent production signals into one incident when they line up.
 *
 * Crash spike + API latency spike + a deploy 15 minutes earlier + a new
 * dependency + a specific app version → potential incident.
 */
export function correlateIncident(input: {
  bug: BugInput;
  logAnalysis?: LogAnalysis;
  gitInvestigation?: GitInvestigation;
  dependencyAnalysis?: DependencyAnalysis;
  memory?: { matches: unknown[]; summary: string };
  metrics?: ProductionMetrics;
  fingerprint?: string;
}): IncidentCorrelation {
  const bug = mergeProductionInput(input.bug);
  const blob = blobFrom(bug);
  const version =
    bug.version ?? blob.match(/\b(?:app[_\s-]?version|version|release)\s*[:=]?\s*v?(\d+\.\d+(?:\.\d+)?)/i)?.[1];
  const scoped = version && !bug.version ? { ...bug, version } : bug;
  const metrics = input.metrics;
  const events = collectCorrelationEvents({
    bug: scoped,
    blob,
    logAnalysis: input.logAnalysis,
    gitInvestigation: input.gitInvestigation,
    dependencyAnalysis: input.dependencyAnalysis,
    metrics,
  });
  const present = events.filter((event) => event.present);
  const introducing = input.gitInvestigation?.introducing;
  const minutesBefore = deployMinutes(blob, metrics, scoped, input.logAnalysis, input.gitInvestigation);
  const newDependency = present.find((event) => event.kind === "new-dependency")?.detail;
  const fingerprint =
    input.fingerprint ??
    crashFingerprint({
      errorType: input.logAnalysis?.error.type,
      errorMessage: input.logAnalysis?.error.message ?? scoped.message,
      file: input.logAnalysis?.crashSite?.file,
    });

  const deploy = introducing
    ? { sha: introducing.sha, version: scoped.version, at: introducing.date, minutesBefore }
    : scoped.version || minutesBefore != null
      ? { version: scoped.version, at: scoped.firstSeen, minutesBefore }
      : undefined;

  const links = buildLinks({
    bug: scoped,
    events: present,
    fingerprint,
    crashFile: input.logAnalysis?.crashSite?.file,
    introducing,
    metrics,
    traceId: input.logAnalysis?.correlationIds[0],
    memorySummary: input.memory?.matches.length ? input.memory.summary : undefined,
    minutesBefore,
    newDependency,
  });

  const potentialIncident = isPotentialIncident(present);
  const correlated = potentialIncident || links.filter((link) => link.strength >= 0.7).length >= 2;
  const labels = present.map((event) => event.label);
  const summary = potentialIncident
    ? `Potential incident: ${joinAnd(labels)}.`
    : present.length
      ? `Saw ${joinAnd(labels)}, but not enough overlapping signals yet.`
      : "Not enough production signals to correlate.";

  return {
    fingerprint,
    deploy,
    events,
    links,
    correlated,
    potentialIncident,
    newDependency: newDependency && newDependency !== "New dependency" ? newDependency : undefined,
    summary,
  };
}

export function collectCorrelationEvents(input: {
  bug: BugInput;
  blob: string;
  logAnalysis?: LogAnalysis;
  gitInvestigation?: GitInvestigation;
  dependencyAnalysis?: DependencyAnalysis;
  metrics?: ProductionMetrics;
}): CorrelationEvent[] {
  const minutes = deployMinutes(
    input.blob,
    input.metrics,
    input.bug,
    input.logAnalysis,
    input.gitInvestigation,
  );
  const dependency = resolveNewDependency(input.blob, input.metrics, input.dependencyAnalysis, input.gitInvestigation);
  const version =
    input.bug.version ??
    input.blob.match(/\b(?:app[_\s-]?version|version|release)\s*[:=]?\s*v?(\d+\.\d+(?:\.\d+)?)/i)?.[1];
  const introducing = input.gitInvestigation?.introducing;

  return EVENT_ORDER.map((kind) => {
    if (kind === "crash-spike") {
      const present = isCrashSpike(input.metrics, input.blob);
      return event(kind, "Crash spike", crashSpikeDetail(input.metrics, input.blob), present, present ? 0.9 : 0);
    }
    if (kind === "latency-spike") {
      const present = isLatencySpike(input.metrics, input.blob);
      return event(
        kind,
        "API latency spike",
        input.metrics?.latencyP95Ms != null ? `p95 ${Math.round(input.metrics.latencyP95Ms)}ms` : "API latency spike",
        present,
        present ? 0.88 : 0,
      );
    }
    if (kind === "deployment") {
      const present = minutes != null || Boolean(introducing);
      const label =
        minutes != null ? `Deployment ${minutes} minute${minutes === 1 ? "" : "s"} earlier` : "Deployment";
      const detail = introducing
        ? `${introducing.sha.slice(0, 8)} ${introducing.subject}${minutes != null ? ` · ${minutes}m before the crash` : ""}`
        : minutes != null
          ? `Deployed ${minutes} minutes before the crash`
          : "Deployment";
      return event(kind, label, detail, present, present ? (minutes != null && minutes <= 30 ? 0.92 : 0.8) : 0, introducing?.date);
    }
    if (kind === "new-dependency") {
      const present = Boolean(dependency);
      return event(kind, "New dependency", dependency ?? "New dependency", present, present ? 0.86 : 0);
    }
    const present = Boolean(version);
    return event(kind, "Specific app version", version ?? "unknown", present, present ? 0.84 : 0);
  });
}

export function renderCorrelationAscii(correlation: IncidentCorrelation): string {
  const present = correlation.events.filter((event) => event.present);
  const header = ["Correlation Engine", ""];
  if (!present.length) {
    return [...header, "No overlapping signals yet."].join("\n");
  }
  const chain: string[] = [];
  for (const [index, item] of present.entries()) {
    if (index > 0) chain.push("   +");
    chain.push(item.label);
  }
  return [
    ...header,
    ...chain,
    "        ↓",
    correlation.potentialIncident ? "Potential incident" : "Not yet an incident",
    "",
    correlation.summary,
  ].join("\n");
}

export function isPotentialIncident(events: CorrelationEvent[]): boolean {
  const present = events.filter((event) => event.present);
  if (present.length >= 3) return true;
  const kinds = new Set(present.map((event) => event.kind));
  return kinds.has("crash-spike") && kinds.has("deployment") && present.length >= 2;
}

function buildLinks(input: {
  bug: BugInput;
  events: CorrelationEvent[];
  fingerprint?: string;
  crashFile?: string;
  introducing?: GitInvestigation["introducing"];
  metrics?: ProductionMetrics;
  traceId?: string;
  memorySummary?: string;
  minutesBefore?: number;
  newDependency?: string;
}): CorrelationLink[] {
  const links: CorrelationLink[] = [];
  const kinds = new Set(input.events.map((event) => event.kind));
  if (input.fingerprint && input.crashFile) {
    links.push({
      left: "crash",
      right: "logs",
      reason: `Fingerprint ${input.fingerprint} at ${fileName(input.crashFile)}`,
      strength: 0.86,
    });
  }
  if (input.introducing && input.bug.version) {
    links.push({
      left: "deploy",
      right: "crash",
      reason: `Version ${input.bug.version} introduced by ${input.introducing.sha.slice(0, 8)} (${input.introducing.subject})`,
      strength: 0.9,
    });
  }
  if (input.introducing && input.bug.firstSeen) {
    links.push({
      left: "first-seen",
      right: "git",
      reason:
        input.minutesBefore != null
          ? `Crash ${input.minutesBefore} minutes after ${input.introducing.sha.slice(0, 8)}`
          : `First seen ${input.bug.firstSeen} near ${input.introducing.date}`,
      strength: input.minutesBefore != null && input.minutesBefore <= 30 ? 0.93 : 0.72,
    });
  }
  if (kinds.has("crash-spike") && (kinds.has("deployment") || input.bug.version)) {
    links.push({
      left: "metrics",
      right: "deploy",
      reason: `Crash spike after ${input.bug.version ?? input.introducing?.sha.slice(0, 8) ?? "the latest deploy"}`,
      strength: 0.9,
    });
  } else if (isErrorSpike(input.metrics) && (input.introducing || input.bug.version)) {
    links.push({
      left: "metrics",
      right: "deploy",
      reason: `Error rate ${pct(input.metrics?.errorRate ?? 0)} rose after ${input.bug.version ?? input.introducing?.sha.slice(0, 8)}`,
      strength: 0.84,
    });
  }
  if (kinds.has("latency-spike") && (kinds.has("deployment") || kinds.has("crash-spike"))) {
    links.push({
      left: "latency",
      right: kinds.has("deployment") ? "deploy" : "crash",
      reason: `API latency spike lined up with the ${kinds.has("deployment") ? "deploy" : "crash spike"}`,
      strength: 0.88,
    });
  }
  if (input.newDependency && (kinds.has("deployment") || kinds.has("app-version"))) {
    links.push({
      left: "dependency",
      right: "deploy",
      reason: `New dependency ${input.newDependency} shipped with ${input.bug.version ?? "this deploy"}`,
      strength: 0.87,
    });
  }
  if (kinds.has("app-version") && kinds.has("crash-spike")) {
    links.push({
      left: "version",
      right: "crash",
      reason: `Crashes concentrated on ${input.bug.version ?? "this app version"}`,
      strength: 0.85,
    });
  }
  if (input.traceId) {
    links.push({
      left: "logs",
      right: "traces",
      reason: `Correlation id ${input.traceId}`,
      strength: 0.7,
    });
  }
  if (input.memorySummary) {
    links.push({
      left: "memory",
      right: "crash",
      reason: input.memorySummary,
      strength: 0.78,
    });
  }
  return links;
}

function event(
  kind: CorrelationEventKind,
  label: string,
  detail: string,
  present: boolean,
  weight: number,
  at?: string,
): CorrelationEvent {
  return { kind, label, detail, present, weight, at };
}

function isCrashSpike(metrics: ProductionMetrics | undefined, blob: string): boolean {
  if (/crash(?:es)?\s+spike/i.test(blob)) return true;
  if ((metrics?.crashes ?? 0) >= 10) return true;
  if ((metrics?.crashFreeUsers ?? 1) < 0.99 && (metrics?.crashes ?? 0) > 0) return true;
  return isErrorSpike(metrics) && (metrics?.crashes ?? 0) > 0;
}

function crashSpikeDetail(metrics: ProductionMetrics | undefined, blob: string): string {
  if (metrics?.crashes != null) {
    return `${metrics.crashes} crashes${metrics.requests != null ? ` / ${metrics.requests} requests` : ""}`;
  }
  if (/crash(?:es)?\s+spike/i.test(blob)) return "Crash spike reported";
  return "Crash spike";
}

function isLatencySpike(metrics: ProductionMetrics | undefined, blob: string): boolean {
  if (/(?:api\s+)?latency\s+spike/i.test(blob)) return true;
  if (metrics?.latencyP95Ms == null) return false;
  if (metrics.baselineLatencyP95Ms != null) {
    return metrics.latencyP95Ms >= Math.max(metrics.baselineLatencyP95Ms * 2, 400);
  }
  return metrics.latencyP95Ms >= 1000;
}

function isErrorSpike(metrics?: ProductionMetrics): boolean {
  if (metrics?.errorRate == null) return false;
  if (metrics.baselineErrorRate != null) {
    return metrics.errorRate >= Math.max(metrics.baselineErrorRate * 2, 0.01);
  }
  return metrics.errorRate >= 0.02;
}

function deployMinutes(
  blob: string,
  metrics: ProductionMetrics | undefined,
  bug: BugInput,
  logs?: LogAnalysis,
  git?: GitInvestigation,
): number | undefined {
  if (metrics?.deployedMinutesAgo != null && Number.isFinite(metrics.deployedMinutesAgo)) {
    return Math.round(metrics.deployedMinutesAgo);
  }
  const fromText =
    blob.match(/deploy(?:ed|ment)?[^\n]{0,60}?(\d+)\s*minutes?\s+(?:ago|earlier|before)/i)?.[1] ??
    blob.match(/(\d+)\s*minutes?\s+(?:ago|earlier)[^\n]{0,40}deploy/i)?.[1];
  if (fromText) return Number.parseInt(fromText, 10);
  const start = parseInstant(git?.introducing?.date) ?? parseInstant(jsonString(blob, "deployedAt"));
  const end = parseInstant(bug.firstSeen) ?? parseInstant(logs?.timestamps[0]);
  if (!start || !end) return undefined;
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  if (minutes < 1 || minutes > 180) return undefined;
  return minutes;
}

function resolveNewDependency(
  blob: string,
  metrics: ProductionMetrics | undefined,
  deps?: DependencyAnalysis,
  git?: GitInvestigation,
): string | undefined {
  if (metrics?.newDependency?.trim()) return metrics.newDependency.trim();
  const named =
    blob.match(/\bnew dependency\s*[:=]?\s*([A-Za-z0-9_@/.:-]+)/i)?.[1] ??
    blob.match(/\badded (?:package|dependency)\s+[:=]?\s*([A-Za-z0-9_@/.:-]+)/i)?.[1] ??
    jsonString(blob, "newDependency");
  if (named) return named;
  const issue = deps?.issues.find((item) => item.package && item.kind !== "none");
  if (deps?.likelyDependencyBug && issue?.package) return issue.package;
  const subject = git?.introducing?.subject ?? "";
  if (/\b(bump|upgrade|chore\(deps\)|add(?:ed)?)\b/i.test(subject)) {
    const tokens = subject.match(/[a-z][a-z0-9_:-]*[a-z0-9]/gi) ?? [];
    const pkg = tokens.find((token) => !/^(bump|upgrade|added|add|chore|deps|dependency)$/i.test(token));
    if (pkg) return pkg;
  }
  return undefined;
}

function parseInstant(value?: string): Date | undefined {
  if (!value?.trim()) return undefined;
  const iso = Date.parse(value);
  if (Number.isFinite(iso) && /T|\d{4}-\d{2}-\d{2}/.test(value) && !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return new Date(iso);
  }
  const clock = value.match(/\b(\d{1,2}):(\d{2})(?:\s*(UTC|Z))?\b/i);
  const day = value.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (clock?.[1] != null && clock[2] != null && day?.[1]) {
    return new Date(`${day[1]}T${clock[1].padStart(2, "0")}:${clock[2]}:00Z`);
  }
  return undefined;
}

function jsonString(text: string, key: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

function blobFrom(bug: BugInput): string {
  return [bug.extraContext, bug.logText, bug.message].filter(Boolean).join("\n");
}

function joinAnd(items: string[]): string {
  const last = items.at(-1);
  if (!last) return "";
  if (items.length === 1) return last;
  if (items.length === 2) return `${items[0]} and ${last}`;
  return `${items.slice(0, -1).join(", ")}, and ${last}`;
}

function fileName(file: string): string {
  return file.replace(/\\/g, "/").split("/").pop() ?? file;
}

function pct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}
