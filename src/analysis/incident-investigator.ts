import { crashFingerprint, mergeProductionInput, recommendProductionAction } from "./production.js";
import {
  collectCorrelationEvents,
  correlateIncident,
  isPotentialIncident,
  renderCorrelationAscii,
} from "./correlation-engine.js";
import { detectFirstBadVersion, previousPatch, renderFirstBadVersionAscii } from "./first-bad-version.js";
import { buildRollbackIntelligence, renderRollbackIntelligenceAscii } from "./rollback-intelligence.js";
import { buildIncidentTimeline, renderIncidentTimelineAscii } from "./incident-timeline.js";
import type {
  BlastRadiusAnalysis,
  BugInput,
  CauseAnalysis,
  CodeInvestigation,
  DebuggingMemory,
  DependencyAnalysis,
  EnvironmentAnalysis,
  FirstBadVersion,
  FixAnalysis,
  GitInvestigation,
  IncidentDetection,
  IncidentSignal,
  LogAnalysis,
  ProductionInvestigation,
  ProductionMetrics,
  RollbackPlan,
  RootCauseAnalysis,
  ValidationAnalysis,
} from "../types.js";

export {
  collectCorrelationEvents,
  correlateIncident,
  isPotentialIncident,
  renderCorrelationAscii,
} from "./correlation-engine.js";

export const PRODUCTION_INVESTIGATOR_FLOW = [
  "                 PRODUCTION INCIDENT",
  "                         │",
  "                         ↓",
  "                 Incident Detection",
  "                         │",
  "          ┌──────────────┼──────────────┐",
  "          ↓              ↓              ↓",
  "       Logs           Crashes          Metrics",
  "          │              │              │",
  "          └──────────────┼──────────────┘",
  "                         ↓",
  "                 Correlation Engine",
  "                         ↓",
  "                  Root Cause Analysis",
  "                         ↓",
  "                  Blast-Radius Analysis",
  "                         ↓",
  "                  Regression Detection",
  "                         ↓",
  "                 Fix / Rollback Plan",
  "                         ↓",
  "                    Validation",
  "                         ↓",
  "                  Incident Report",
].join("\n");

export function parseProductionMetrics(text?: string, explicit?: ProductionMetrics): ProductionMetrics | undefined {
  const parsed = text ? parseMetricsFromText(text) : {};
  const metrics: ProductionMetrics = { ...parsed, ...compactMetrics(explicit) };
  return hasMetrics(metrics) ? metrics : undefined;
}

export function detectIncident(input: {
  bug: BugInput;
  logAnalysis?: LogAnalysis;
  metrics?: ProductionMetrics;
  gitInvestigation?: GitInvestigation;
  dependencyAnalysis?: DependencyAnalysis;
}): IncidentDetection {
  const bug = mergeProductionInput(input.bug);
  const metrics = input.metrics ?? parseProductionMetrics(blobFrom(bug), bug.metrics);
  const signals = collectIncidentSignals({ bug, logAnalysis: input.logAnalysis, metrics });
  const spike = isErrorSpike(metrics);
  const crashFreeDrop = (metrics?.crashFreeUsers ?? 1) < 0.99 && (metrics?.crashes ?? 0) > 0;
  const overlapping = collectCorrelationEvents({
    bug,
    blob: blobFrom(bug),
    logAnalysis: input.logAnalysis,
    gitInvestigation: input.gitInvestigation,
    dependencyAnalysis: input.dependencyAnalysis,
    metrics,
  });
  const potential = isPotentialIncident(overlapping);
  const detected = Boolean(
    bug.incidentSource ||
      bug.version ||
      bug.affectedUsers != null ||
      bug.firstSeen ||
      spike ||
      crashFreeDrop ||
      potential,
  );
  const users = bug.affectedUsers ?? 0;
  const severity =
    users >= 100 || (metrics?.errorRate ?? 0) >= 0.05
      ? "sev-1"
      : users >= 20 || spike || potential
        ? "sev-2"
        : detected
          ? "sev-3"
          : "sev-4";
  const presentLabels = overlapping.filter((event) => event.present).map((event) => event.label);
  const reason = !detected
    ? "No production signals, crash backend, or metric spike."
    : potential
      ? `Overlapping signals: ${presentLabels.join(" + ")}.`
      : spike
        ? "Error-rate spike correlated with a production crash."
        : users >= 100
          ? `${users} affected users in production.`
          : bug.incidentSource
            ? `Inbound ${bug.incidentSource} incident.`
            : "Production version / first-seen markers present.";
  return {
    detected,
    severity,
    reason,
    signals,
    summary: detected ? `Incident detected (${severity}): ${reason}` : "Not a production incident.",
  };
}

export function collectIncidentSignals(input: {
  bug: BugInput;
  logAnalysis?: LogAnalysis;
  metrics?: ProductionMetrics;
}): IncidentSignal[] {
  const bug = mergeProductionInput(input.bug);
  const logs: IncidentSignal[] = [];
  const analysis = input.logAnalysis;
  if (analysis?.summary) {
    logs.push({
      kind: "log",
      source: analysis.logs.sources[0] ?? bug.incidentSource ?? "logs",
      summary: analysis.summary,
      weight: 0.7,
      at: analysis.timestamps[0],
    });
  } else if (bug.logText || bug.message) {
    logs.push({
      kind: "log",
      source: bug.incidentSource ?? "logs",
      summary: clip(bug.message ?? firstLine(bug.logText) ?? "Log excerpt captured.", 160),
      weight: 0.5,
    });
  }
  for (const repeating of analysis?.repeating ?? []) {
    logs.push({
      kind: "log",
      source: "repeating",
      summary: `x${repeating.count} ${clip(repeating.message, 120)}`,
      weight: Math.min(0.9, 0.4 + repeating.count / 20),
    });
  }

  const crashes: IncidentSignal[] = [];
  if (analysis?.crashSite) {
    const loc = `${analysis.crashSite.file}${analysis.crashSite.line ? `:${analysis.crashSite.line}` : ""}`;
    crashes.push({
      kind: "crash",
      source: bug.incidentSource ?? "crash",
      summary: `${analysis.error.type ?? "Error"} at ${loc}`,
      weight: 0.9,
    });
  } else if (analysis?.error.message) {
    crashes.push({
      kind: "crash",
      source: bug.incidentSource ?? "crash",
      summary: `${analysis.error.type ?? "Error"}: ${clip(analysis.error.message, 120)}`,
      weight: 0.7,
    });
  }
  for (const ex of analysis?.exceptionChain ?? []) {
    crashes.push({
      kind: "crash",
      source: ex.role,
      summary: `${ex.type ?? "Error"}: ${clip(ex.message, 100)}`,
      weight: ex.role === "primary" ? 0.85 : 0.55,
    });
  }

  const metrics = input.metrics;
  const metricSignals: IncidentSignal[] = [];
  if (metrics?.errorRate != null) {
    metricSignals.push({
      kind: "metric",
      source: "error-rate",
      summary: `Error rate ${pct(metrics.errorRate)}${metrics.baselineErrorRate != null ? ` (baseline ${pct(metrics.baselineErrorRate)})` : ""}`,
      weight: isErrorSpike(metrics) ? 0.9 : 0.5,
    });
  }
  if (metrics?.latencyP95Ms != null) {
    metricSignals.push({
      kind: "metric",
      source: "latency",
      summary: `p95 ${Math.round(metrics.latencyP95Ms)}ms`,
      weight: metrics.latencyP95Ms >= 1000 ? 0.7 : 0.4,
    });
  }
  if (metrics?.crashFreeUsers != null) {
    metricSignals.push({
      kind: "metric",
      source: "crash-free",
      summary: `Crash-free users ${pct(metrics.crashFreeUsers)}`,
      weight: metrics.crashFreeUsers < 0.99 ? 0.8 : 0.4,
    });
  }
  if (metrics?.crashes != null) {
    metricSignals.push({
      kind: "metric",
      source: "crashes",
      summary: `${metrics.crashes} crashes${metrics.requests != null ? ` / ${metrics.requests} requests` : ""}`,
      weight: metrics.crashes > 0 ? 0.75 : 0.2,
    });
  }

  return [...logs, ...crashes, ...metricSignals];
}

export function buildRollbackPlan(input: {
  bug: BugInput;
  gitInvestigation?: GitInvestigation;
  blastRadius?: BlastRadiusAnalysis;
  rootCause?: RootCauseAnalysis;
  fixAnalysis?: FixAnalysis;
  validation?: ValidationAnalysis;
  metrics?: ProductionMetrics;
}): RollbackPlan {
  const bug = mergeProductionInput(input.bug);
  const introducing = input.gitInvestigation?.introducing;
  const action = recommendProductionAction({
    affectedUsers: bug.affectedUsers,
    introducing: Boolean(introducing),
    hasFix: Boolean(input.fixAnalysis?.proposal.summary || input.rootCause),
  });
  const previous =
    input.gitInvestigation?.firstBadVersion?.lastHealthy ??
    detectFirstBadVersion({ current: bug.version, extraContext: blobFrom(bug) })?.lastHealthy ??
    previousPatch(bug.version);
  const target =
    action === "rollback"
      ? previous ?? (introducing ? introducing.sha.slice(0, 8) : undefined)
      : action === "hotfix"
        ? input.fixAnalysis?.proposal.edits[0]?.path ?? introducing?.sha.slice(0, 8)
        : undefined;

  const steps =
    action === "rollback"
      ? [
          introducing
            ? `Revert ${introducing.sha.slice(0, 8)} (${introducing.subject})`
            : "Roll back the latest production release",
          previous ? `Ship ${previous}` : "Ship the last known-good build",
          "Watch crash-free users and error rate until they recover",
          "Follow with a targeted hotfix on a later release",
        ]
      : action === "hotfix"
        ? [
            input.fixAnalysis?.proposal.summary || input.rootCause?.rootCause || "Ship a targeted production hotfix",
            "Gate the rollout and watch error rate / p95",
            input.blastRadius?.high[0] ? `Verify ${input.blastRadius.high[0]} after deploy` : "Verify the failing surface after deploy",
          ]
        : [
            "Keep investigating until a deploy, crash fingerprint, or metric spike lines up",
            "Do not roll back until the introducing change is identified",
          ];

  const risks = [
    ...(input.blastRadius?.high ?? []).map((surface) => `HIGH ${surface}`),
    ...(input.validation && !input.validation.resolved ? ["Fix not yet validated in this environment"] : []),
    isErrorSpike(input.metrics) ? "Error rate is still elevated" : undefined,
  ].filter((item): item is string => Boolean(item));

  const summary =
    action === "rollback"
      ? `Rollback to ${target ?? "the previous release"} (${bug.affectedUsers ?? 0} users).`
      : action === "hotfix"
        ? `Hotfix ${target ?? "the failing path"}; skip a full rollback.`
        : "Investigate before changing production.";

  return { action, target, steps, risks, summary };
}

export function investigateProductionIncident(input: {
  bug: BugInput;
  logAnalysis?: LogAnalysis;
  gitInvestigation?: GitInvestigation;
  dependencyAnalysis?: DependencyAnalysis;
  memory?: DebuggingMemory;
  rootCause?: RootCauseAnalysis;
  blastRadius?: BlastRadiusAnalysis;
  fixAnalysis?: FixAnalysis;
  validation?: ValidationAnalysis;
  causeAnalysis?: CauseAnalysis;
  environment?: EnvironmentAnalysis;
  codeInvestigation?: CodeInvestigation;
}): ProductionInvestigation | undefined {
  const bug = mergeProductionInput(input.bug);
  const metrics = parseProductionMetrics(blobFrom(bug), bug.metrics);
  const detection = detectIncident({
    bug,
    logAnalysis: input.logAnalysis,
    metrics,
    gitInvestigation: input.gitInvestigation,
    dependencyAnalysis: input.dependencyAnalysis,
  });
  if (!detection.detected) return undefined;

  const signals = detection.signals;
  const correlation = correlateIncident({
    bug,
    logAnalysis: input.logAnalysis,
    gitInvestigation: input.gitInvestigation,
    dependencyAnalysis: input.dependencyAnalysis,
    memory: input.memory,
    metrics,
    fingerprint: crashFingerprint({
      errorType: input.logAnalysis?.error.type,
      errorMessage: input.logAnalysis?.error.message ?? bug.message,
      file: input.logAnalysis?.crashSite?.file,
    }),
  });
  const rollbackPlan = buildRollbackPlan({
    bug,
    gitInvestigation: input.gitInvestigation,
    blastRadius: input.blastRadius,
    rootCause: input.rootCause,
    fixAnalysis: input.fixAnalysis,
    validation: input.validation,
    metrics,
  });
  const firstBadVersion = resolveFirstBadVersion(bug, input.gitInvestigation);
  const rollbackIntelligence = buildRollbackIntelligence({
    bug,
    gitInvestigation: input.gitInvestigation,
    blastRadius: input.blastRadius,
    fixAnalysis: input.fixAnalysis,
    validation: input.validation,
    causeAnalysis: input.causeAnalysis,
    environment: input.environment,
    dependencyAnalysis: input.dependencyAnalysis,
    codeInvestigation: input.codeInvestigation,
  });
  const incidentTimeline = buildIncidentTimeline({
    bug,
    metrics,
    logAnalysis: input.logAnalysis,
    gitInvestigation: input.gitInvestigation,
    correlation,
    fixAnalysis: input.fixAnalysis,
    validation: input.validation,
  });

  return {
    detection,
    logs: signals.filter((signal) => signal.kind === "log"),
    crashes: signals.filter((signal) => signal.kind === "crash"),
    metrics,
    correlation,
    firstBadVersion,
    rollbackPlan,
    rollbackIntelligence,
    incidentTimeline,
    summary: `${detection.summary} ${correlation.summary} ${rollbackPlan.summary} ${rollbackIntelligence.summary}${incidentTimeline ? ` ${incidentTimeline.summary}` : ""}`,
  };
}

export function renderProductionInvestigatorAscii(investigation?: ProductionInvestigation): string {
  if (!investigation) return PRODUCTION_INVESTIGATOR_FLOW;
  return [
    PRODUCTION_INVESTIGATOR_FLOW,
    "",
    renderDetectionAscii(investigation),
    "",
    renderCorrelationAscii(investigation.correlation),
    investigation.firstBadVersion ? ["", renderFirstBadVersionAscii(investigation.firstBadVersion)].join("\n") : undefined,
    "",
    renderRollbackPlanAscii(investigation.rollbackPlan),
    investigation.rollbackIntelligence
      ? ["", renderRollbackIntelligenceAscii(investigation.rollbackIntelligence)].join("\n")
      : undefined,
    investigation.incidentTimeline
      ? ["", renderIncidentTimelineAscii(investigation.incidentTimeline)].join("\n")
      : undefined,
  ]
    .filter((block): block is string => Boolean(block))
    .join("\n");
}

export function renderDetectionAscii(investigation: ProductionInvestigation): string {
  const metrics = investigation.metrics;
  return [
    "Incident Detection",
    "",
    investigation.detection.summary,
    `Logs: ${investigation.logs.length || "none"}`,
    `Crashes: ${investigation.crashes.length || "none"}`,
    `Metrics: ${
      metrics
        ? [
            metrics.errorRate != null ? `error rate ${pct(metrics.errorRate)}` : undefined,
            metrics.latencyP95Ms != null ? `p95 ${Math.round(metrics.latencyP95Ms)}ms` : undefined,
            metrics.crashFreeUsers != null ? `crash-free ${pct(metrics.crashFreeUsers)}` : undefined,
          ]
            .filter(Boolean)
            .join(" · ") || "captured"
        : "none"
    }`,
  ].join("\n");
}

export function renderRollbackPlanAscii(plan: RollbackPlan): string {
  const action =
    plan.action === "rollback" ? "Rollback / hotfix" : plan.action === "hotfix" ? "Hotfix" : "Investigate";
  return [
    "Fix / Rollback Plan",
    "",
    `Action: ${action}${plan.target ? ` → ${plan.target}` : ""}`,
    plan.summary,
    "",
    "Steps:",
    ...plan.steps.map((step, index) => `${index + 1}. ${step}`),
    ...(plan.risks.length ? ["", "Risks:", ...plan.risks.map((risk) => `- ${risk}`)] : []),
  ].join("\n");
}

function parseMetricsFromText(text: string): ProductionMetrics {
  const fromJson = parseMetricsJson(text);
  const errorRate = fromJson.errorRate ?? parsePercent(text, /error[_\s-]?rate\s*[:=]\s*([\d.]+)\s*%?/i);
  const baselineErrorRate =
    fromJson.baselineErrorRate ?? parsePercent(text, /baseline(?:\s+error[_\s-]?rate)?\s*[:=]\s*([\d.]+)\s*%?/i);
  const latencyP95Ms =
    fromJson.latencyP95Ms ??
    parseNumber(text.match(/\b(?:p95|latency(?:[_\s-]?p95)?)\s*[:=]\s*([\d.]+)\s*ms\b/i)?.[1]);
  const baselineLatencyP95Ms =
    fromJson.baselineLatencyP95Ms ??
    parseNumber(text.match(/\bbaseline(?:\s+(?:p95|latency))?[^\n]{0,20}?[:=]\s*([\d.]+)\s*ms\b/i)?.[1]);
  const crashFreeUsers =
    fromJson.crashFreeUsers ?? parsePercent(text, /crash[_\s-]?free(?:\s+users)?\s*[:=]\s*([\d.]+)\s*%?/i);
  const requests = fromJson.requests ?? parseNumber(text.match(/\brequests?\s*[:=]\s*(\d+)/i)?.[1]);
  const crashes = fromJson.crashes ?? parseNumber(text.match(/\bcrashes?\s*[:=]\s*(\d+)/i)?.[1]);
  const deployedMinutesAgo =
    fromJson.deployedMinutesAgo ??
    parseNumber(
      text.match(/deploy(?:ed|ment)?[^\n]{0,60}?(\d+)\s*minutes?\s+(?:ago|earlier|before)/i)?.[1] ??
        text.match(/(\d+)\s*minutes?\s+(?:ago|earlier)[^\n]{0,40}deploy/i)?.[1],
    );
  const newDependency =
    fromJson.newDependency ??
    text.match(/\bnew dependency\s*[:=]?\s*([A-Za-z0-9_@/.:-]+)/i)?.[1] ??
    text.match(/\badded (?:package|dependency)\s+[:=]?\s*([A-Za-z0-9_@/.:-]+)/i)?.[1];
  return compactMetrics({
    errorRate,
    baselineErrorRate,
    latencyP95Ms,
    baselineLatencyP95Ms,
    crashFreeUsers,
    requests,
    crashes,
    deployedMinutesAgo,
    newDependency,
  });
}

function parseMetricsJson(text: string): ProductionMetrics {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return {};
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const obj = Array.isArray(parsed) ? (parsed[0] as Record<string, unknown> | undefined) : parsed;
    if (!obj || typeof obj !== "object") return {};
    return compactMetrics({
      errorRate: asRate(obj.errorRate ?? obj.error_rate),
      baselineErrorRate: asRate(obj.baselineErrorRate ?? obj.baseline_error_rate),
      latencyP95Ms: asNumber(obj.latencyP95Ms ?? obj.p95 ?? obj.p95Ms),
      baselineLatencyP95Ms: asNumber(obj.baselineLatencyP95Ms ?? obj.baseline_p95 ?? obj.p95Baseline),
      crashFreeUsers: asRate(obj.crashFreeUsers ?? obj.crash_free_users),
      requests: asNumber(obj.requests),
      crashes: asNumber(obj.crashes),
      deployedMinutesAgo: asNumber(obj.deployedMinutesAgo ?? obj.deployed_minutes_ago),
      newDependency: typeof obj.newDependency === "string" ? obj.newDependency : typeof obj.new_dependency === "string" ? obj.new_dependency : undefined,
    });
  } catch {
    return {};
  }
}

function isErrorSpike(metrics?: ProductionMetrics): boolean {
  if (metrics?.errorRate == null) return false;
  if (metrics.baselineErrorRate != null) {
    return metrics.errorRate >= Math.max(metrics.baselineErrorRate * 2, 0.01);
  }
  return metrics.errorRate >= 0.02;
}

function resolveFirstBadVersion(bug: BugInput, git?: GitInvestigation): FirstBadVersion | undefined {
  if (git?.firstBadVersion) return git.firstBadVersion;
  return detectFirstBadVersion({ current: bug.version, extraContext: blobFrom(bug) });
}

function blobFrom(bug: BugInput): string {
  return [bug.extraContext, bug.logText, bug.message].filter(Boolean).join("\n");
}

function compactMetrics(metrics?: ProductionMetrics): ProductionMetrics {
  if (!metrics) return {};
  return Object.fromEntries(Object.entries(metrics).filter(([, value]) => value != null)) as ProductionMetrics;
}

function hasMetrics(metrics: ProductionMetrics): boolean {
  return Object.values(metrics).some((value) => value != null);
}

function parsePercent(text: string, pattern: RegExp): number | undefined {
  const match = text.match(pattern);
  if (!match?.[1]) return undefined;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return undefined;
  if (/%/.test(match[0]) || value > 1) return value / 100;
  return value;
}

function parseNumber(raw?: string): number | undefined {
  if (!raw) return undefined;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : undefined;
}

function asRate(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1 ? value / 100 : value;
  if (typeof value === "string") {
    const numeric = Number.parseFloat(value.replace("%", ""));
    if (!Number.isFinite(numeric)) return undefined;
    return /%/.test(value) || numeric > 1 ? numeric / 100 : numeric;
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) return Number.parseFloat(value);
  return undefined;
}

function pct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function firstLine(text?: string): string | undefined {
  return text
    ?.split("\n")
    .map((line) => line.trim())
    .find(Boolean);
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
