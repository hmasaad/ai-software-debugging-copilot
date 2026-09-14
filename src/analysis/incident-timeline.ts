import { mergeProductionInput } from "./production.js";
import type {
  BugInput,
  FixAnalysis,
  GitInvestigation,
  IncidentCorrelation,
  IncidentTimeline,
  IncidentTimelineEvent,
  LogAnalysis,
  ProductionMetrics,
  ValidationAnalysis,
} from "../types.js";

const MINUTES_IN_DAY = 24 * 60;
const DEFAULT_DEPLOY_LEAD = 13;
const DEPLOY_DURATION = 5;
const ERROR_LEAD = 4;
const CRASH_LEAD = 2;
const REGRESSION_LAG = 3;
const FIX_LAG = 8;
const VALIDATED_LAG = 12;

export const TIMELINE_EVENTS = [
  "Deployment started",
  "Deployment completed",
  "Error rate increased",
  "Crash threshold exceeded",
  "First customer impact detected",
  "Regression identified",
  "Fix generated",
  "Fix validated",
] as const;

export type TimelineLabel = (typeof TIMELINE_EVENTS)[number];

/**
 * 14:02  Deployment started
 * 14:07  Deployment completed
 * 14:11  Error rate increased
 * 14:13  Crash threshold exceeded
 * 14:15  First customer impact detected
 * 14:18  Regression identified
 * 14:23  Fix generated
 * 14:27  Fix validated
 */
export function renderIncidentTimelineAscii(timeline?: IncidentTimeline): string {
  if (!timeline?.events.length) return "";
  return timeline.events.map((event) => `${event.at}  ${event.label}`).join("\n");
}

export function buildIncidentTimeline(input: {
  bug?: BugInput;
  metrics?: ProductionMetrics;
  logAnalysis?: LogAnalysis;
  gitInvestigation?: GitInvestigation;
  correlation?: IncidentCorrelation;
  fixAnalysis?: FixAnalysis;
  validation?: ValidationAnalysis;
}): IncidentTimeline | undefined {
  const bug = input.bug ? mergeProductionInput(input.bug) : undefined;
  const blob = [bug?.extraContext, bug?.logText, bug?.message].filter(Boolean).join("\n");
  const reported = parseReportedEvents(blob);
  const impact = impactMinutes(bug, input.logAnalysis, reported);
  const derived = impact != null ? deriveEvents(impact, { ...input, bug, blob }) : [];
  const merged = mergeEvents(reported, derived);
  if (!merged.length) return undefined;

  const first = merged[0];
  const last = merged[merged.length - 1];
  const impactEvent = merged.find((event) => event.label === "First customer impact detected");
  return {
    events: merged,
    impactAt: impactEvent?.at ?? (impact != null ? formatClock(impact) : undefined),
    summary: first && last ? `${first.at} ${first.label} → ${last.at} ${last.label}.` : "Incident timeline.",
  };
}

function deriveEvents(
  impact: number,
  input: {
    bug?: BugInput;
    blob: string;
    metrics?: ProductionMetrics;
    logAnalysis?: LogAnalysis;
    gitInvestigation?: GitInvestigation;
    correlation?: IncidentCorrelation;
    fixAnalysis?: FixAnalysis;
    validation?: ValidationAnalysis;
  },
): IncidentTimelineEvent[] {
  const events: IncidentTimelineEvent[] = [];
  const deployLead = deployLeadMinutes(input);
  const hasDeploy = deployLead != null || hasDeploySignal(input);
  if (hasDeploy) {
    const lead = deployLead ?? DEFAULT_DEPLOY_LEAD;
    const start = addMinutes(impact, -lead);
    const duration = Math.min(DEPLOY_DURATION, Math.max(1, lead - ERROR_LEAD - 1));
    events.push(clockEvent(start, "Deployment started"));
    events.push(clockEvent(addMinutes(start, duration), "Deployment completed"));
  }
  if (isErrorSpike(input.metrics, input.blob)) {
    events.push(clockEvent(addMinutes(impact, -ERROR_LEAD), "Error rate increased"));
  }
  if (isCrashThreshold(input.metrics, input.logAnalysis, input.blob)) {
    events.push(clockEvent(addMinutes(impact, -CRASH_LEAD), "Crash threshold exceeded"));
  }
  if (input.bug?.firstSeen || (input.bug?.affectedUsers ?? 0) > 0) {
    events.push(clockEvent(impact, "First customer impact detected"));
  }
  if (input.gitInvestigation?.introducing || input.gitInvestigation?.regression || input.gitInvestigation?.firstBadVersion) {
    events.push(clockEvent(addMinutes(impact, REGRESSION_LAG), "Regression identified"));
  }
  if (input.fixAnalysis?.proposal.edits.length) {
    events.push(clockEvent(addMinutes(impact, FIX_LAG), "Fix generated"));
  }
  if (input.validation?.resolved || input.validation?.verdict === "likely-resolved") {
    events.push(clockEvent(addMinutes(impact, VALIDATED_LAG), "Fix validated"));
  }
  return events;
}

function deployLeadMinutes(input: {
  metrics?: ProductionMetrics;
  correlation?: IncidentCorrelation;
  blob: string;
}): number | undefined {
  if (input.metrics?.deployedMinutesAgo != null && Number.isFinite(input.metrics.deployedMinutesAgo)) {
    return Math.max(1, Math.round(input.metrics.deployedMinutesAgo));
  }
  if (input.correlation?.deploy?.minutesBefore != null) {
    return Math.max(1, Math.round(input.correlation.deploy.minutesBefore));
  }
  const fromText =
    input.blob.match(/deploy(?:ed|ment)?[^\n]{0,60}?(\d+)\s*minutes?\s+(?:ago|earlier|before)/i)?.[1] ??
    input.blob.match(/(\d+)\s*minutes?\s+(?:ago|earlier)[^\n]{0,40}deploy/i)?.[1];
  if (fromText) return Number.parseInt(fromText, 10);
  return undefined;
}

function hasDeploySignal(input: {
  gitInvestigation?: GitInvestigation;
  correlation?: IncidentCorrelation;
  blob: string;
  bug?: BugInput;
}): boolean {
  if (input.gitInvestigation?.introducing) return true;
  if (input.correlation?.events.some((event) => event.kind === "deployment" && event.present)) return true;
  if (input.bug?.version && input.bug.incidentSource) return true;
  return /deploy(?:ed|ment)/i.test(input.blob);
}

function isErrorSpike(metrics?: ProductionMetrics, blob = ""): boolean {
  if (/error[_\s-]?rate\s+(?:increased|spike)/i.test(blob)) return true;
  if (metrics?.errorRate == null) return false;
  if (metrics.baselineErrorRate != null) {
    return metrics.errorRate >= Math.max(metrics.baselineErrorRate * 2, 0.01);
  }
  return metrics.errorRate >= 0.02;
}

function isCrashThreshold(metrics?: ProductionMetrics, logs?: LogAnalysis, blob = ""): boolean {
  if (/crash threshold/i.test(blob)) return true;
  if ((metrics?.crashes ?? 0) > 0) return true;
  if ((metrics?.crashFreeUsers ?? 1) < 0.99) return true;
  return (logs?.logLevels.fatal ?? 0) + (logs?.logLevels.error ?? 0) >= 1;
}

function impactMinutes(
  bug?: BugInput,
  logs?: LogAnalysis,
  reported: IncidentTimelineEvent[] = [],
): number | undefined {
  const reportedImpact = reported.find((event) => event.label === "First customer impact detected");
  if (reportedImpact) return reportedImpact.minutes;
  return parseClock(bug?.firstSeen) ?? parseClock(logs?.timestamps[0]);
}

function parseReportedEvents(blob: string): IncidentTimelineEvent[] {
  if (!blob.trim()) return [];
  const found = new Map<string, IncidentTimelineEvent>();
  const line = /^(\d{1,2}):(\d{2})(?:\:\d{2})?\s+(.+?)\s*$/gm;
  let match: RegExpExecArray | null = line.exec(blob);
  while (match) {
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const label = canonicalizeLabel(match[3] ?? "");
    if (label && hours <= 23 && minutes <= 59) {
      const total = hours * 60 + minutes;
      found.set(label, clockEvent(total, label));
    }
    match = line.exec(blob);
  }
  const labeled = new RegExp(`(${TIMELINE_EVENTS.map(escapeRegExp).join("|")})\\s*[:=]\\s*(\\d{1,2}:\\d{2})`, "gi");
  let named: RegExpExecArray | null = labeled.exec(blob);
  while (named) {
    const label = canonicalizeLabel(named[1] ?? "");
    const minutes = parseClock(named[2]);
    if (label && minutes != null) found.set(label, clockEvent(minutes, label));
    named = labeled.exec(blob);
  }
  return TIMELINE_EVENTS.map((label) => found.get(label)).filter((event): event is IncidentTimelineEvent => Boolean(event));
}

function mergeEvents(reported: IncidentTimelineEvent[], derived: IncidentTimelineEvent[]): IncidentTimelineEvent[] {
  const byLabel = new Map<string, IncidentTimelineEvent>();
  for (const event of derived) byLabel.set(event.label, event);
  for (const event of reported) byLabel.set(event.label, event);
  return TIMELINE_EVENTS.map((label) => byLabel.get(label)).filter((event): event is IncidentTimelineEvent => Boolean(event));
}

function canonicalizeLabel(raw: string): TimelineLabel | undefined {
  const text = raw.replace(/\s+/g, " ").trim();
  const exact = TIMELINE_EVENTS.find((label) => label.toLowerCase() === text.toLowerCase());
  if (exact) return exact;
  if (/deploy.*start/i.test(text)) return "Deployment started";
  if (/deploy.*complet/i.test(text)) return "Deployment completed";
  if (/error rate/i.test(text)) return "Error rate increased";
  if (/crash threshold/i.test(text)) return "Crash threshold exceeded";
  if (/customer impact|first seen/i.test(text)) return "First customer impact detected";
  if (/regression/i.test(text)) return "Regression identified";
  if (/fix generated|patch generated/i.test(text)) return "Fix generated";
  if (/fix validated|validated the fix/i.test(text)) return "Fix validated";
  return undefined;
}

function parseClock(value?: string): number | undefined {
  if (!value?.trim()) return undefined;
  if (/T/.test(value)) {
    const iso = Date.parse(value);
    if (Number.isFinite(iso)) {
      const date = new Date(iso);
      return date.getUTCHours() * 60 + date.getUTCMinutes();
    }
  }
  const clock = value.match(/\b(\d{1,2}):(\d{2})\b/);
  if (clock?.[1] == null || clock[2] == null) return undefined;
  const hours = Number(clock[1]);
  const minutes = Number(clock[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

function clockEvent(minutes: number, label: TimelineLabel): IncidentTimelineEvent {
  const wrapped = addMinutes(minutes, 0);
  return { at: formatClock(wrapped), minutes: wrapped, label };
}

function addMinutes(base: number, delta: number): number {
  return ((base + delta) % MINUTES_IN_DAY + MINUTES_IN_DAY) % MINUTES_IN_DAY;
}

function formatClock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
