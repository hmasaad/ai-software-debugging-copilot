import type {
  AgentRun,
  CauseAnalysis,
  CodeInvestigation,
  DebuggingMemory,
  DependencyAnalysis,
  FixAnalysis,
  GitInvestigation,
  IncidentEvent,
  IncidentReport,
  IncidentSeverity,
  IncidentStatus,
  LogAnalysis,
  ReproductionAnalysis,
  RootCauseAnalysis,
  TestAnalysis,
  ValidationAnalysis,
} from "../types.js";
import { buildProductionIncident, crashFingerprint } from "../analysis/production.js";
import { INCIDENT_AGENT, type AgentContext, type SpecialistAgent } from "./types.js";

/**
 * Incident Agent — produces an engineer-friendly incident report from specialist findings.
 */
export class IncidentAgent implements SpecialistAgent<IncidentReport> {
  readonly id = INCIDENT_AGENT.id;
  readonly name = INCIDENT_AGENT.name;
  readonly responsibility = INCIDENT_AGENT.responsibility;

  async run(ctx: AgentContext): Promise<{ result: IncidentReport; run: AgentRun }> {
    const started = Date.now();
    const result = this.analyze(ctx);
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

  analyze(ctx: AgentContext): IncidentReport {
    const fingerprint = crashFingerprint({
      errorType: ctx.logAnalysis?.error.type,
      errorMessage: ctx.logAnalysis?.error.message ?? ctx.input.message,
      file: ctx.logAnalysis?.crashSite?.file ?? ctx.codeInvestigation?.origin?.file,
    });
    const production = buildProductionIncident({
      bug: ctx.input,
      rootCause: ctx.rootCause,
      gitInvestigation: ctx.gitInvestigation,
      memory: ctx.memory,
      suggestedFix: ctx.fixAnalysis?.proposal.summary,
      fingerprint,
    });
    const report = buildIncidentReport({
      logAnalysis: ctx.logAnalysis,
      codeInvestigation: ctx.codeInvestigation,
      gitInvestigation: ctx.gitInvestigation,
      dependencyAnalysis: ctx.dependencyAnalysis,
      reproduction: ctx.reproduction,
      causeAnalysis: ctx.causeAnalysis,
      rootCause: ctx.rootCause,
      fixAnalysis: ctx.fixAnalysis,
      testAnalysis: ctx.testAnalysis,
      validation: ctx.validationAnalysis,
      memory: ctx.memory,
      production,
    });
    return report;
  }
}

export function buildIncidentReport(input: {
  logAnalysis?: LogAnalysis;
  codeInvestigation?: CodeInvestigation;
  gitInvestigation?: GitInvestigation;
  dependencyAnalysis?: DependencyAnalysis;
  reproduction?: ReproductionAnalysis;
  causeAnalysis?: CauseAnalysis;
  rootCause?: RootCauseAnalysis;
  fixAnalysis?: FixAnalysis;
  testAnalysis?: TestAnalysis;
  validation?: ValidationAnalysis;
  memory?: DebuggingMemory;
  production?: ReturnType<typeof buildProductionIncident>;
}): IncidentReport {
  const error = input.logAnalysis?.error;
  const crash = input.logAnalysis?.crashSite ?? input.codeInvestigation?.origin;
  const loc = crash ? `${crash.file}${crash.line ? `:${crash.line}` : ""}` : undefined;
  const type = error?.type ?? "Error";
  const message = (error?.message ?? "Unknown failure").replace(/\s+/g, " ").trim();
  const title = `${type}: ${clip(message, 100)}${loc ? ` @ ${pathTail(loc)}` : ""}`;

  const severity = classifySeverity({
    type,
    message,
    reproduced: input.reproduction?.result.reproduced,
    dependency: input.dependencyAnalysis?.likelyDependencyBug,
    resolved: input.validation?.resolved,
    affectedUsers: input.production?.affectedUsers,
  });
  const status = classifyStatus(input.validation?.verdict, Boolean(input.causeAnalysis?.leading), Boolean(input.fixAnalysis?.proposal.edits.length));

  const impact = buildImpact(type, loc, input.reproduction);
  const whatHappened = buildWhatHappened(type, message, loc, input.codeInvestigation, input.reproduction);
  const rootCause =
    input.causeAnalysis?.leading?.description ??
    input.rootCause?.rootCause ??
    input.causeAnalysis?.summary ??
    "Root cause not yet ranked.";
  const fix = buildFix(input.fixAnalysis);
  const validation = input.validation?.summary ?? "Validation has not run.";
  const timeline = buildTimeline(input);
  const followUps = buildFollowUps(input);
  const body = [
    `## Incident`,
    `**${severity.toUpperCase()}** · ${status}`,
    "",
    `### What happened`,
    whatHappened,
    "",
    `### Impact`,
    impact,
    "",
    `### Root cause`,
    rootCause,
    "",
    `### Fix`,
    fix,
    "",
    `### Validation`,
    validation,
    "",
    `### Timeline`,
    ...timeline.map((event) => `- **${event.label}:** ${event.detail}`),
    "",
    input.production
      ? [
          `### Production`,
          `Source: ${input.production.source ?? "local"}`,
          `Version: ${input.production.version ?? "unknown"}`,
          `Affected users: ${input.production.affectedUsers ?? "unknown"}`,
          `First seen: ${input.production.firstSeen ?? "unknown"}`,
          input.production.groupedCount ? `Similar crashes: ${input.production.groupedCount}` : undefined,
          `Likely cause: ${input.production.likelyCause}`,
          `Recommended action: ${input.production.recommendedAction}`,
          input.production.suggestedFix ? `Suggested fix: ${input.production.suggestedFix}` : undefined,
          "",
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n")
      : "",
    `### Follow-ups`,
    ...(followUps.length ? followUps.map((item) => `- ${item}`) : ["- None."]),
  ].join("\n");

  const summary = `${severity.toUpperCase()} ${status}: ${clip(whatHappened, 160)}`;
  const handoff = followUps.slice(0, 4);

  return {
    title,
    severity,
    status,
    impact,
    whatHappened,
    rootCause,
    fix,
    validation,
    timeline,
    followUps,
    body,
    summary,
    handoff: handoff.length ? handoff : ["Incident write-up is ready to share."],
    production: input.production,
  };
}

function classifySeverity(input: {
  type: string;
  message: string;
  reproduced?: boolean;
  dependency?: boolean;
  resolved?: boolean;
  affectedUsers?: number;
}): IncidentSeverity {
  if ((input.affectedUsers ?? 0) >= 100) return "sev-1";
  const crash = /TypeError|ReferenceError|Panic|FATAL|NullPointer|segfault/i.test(input.type) || /undefined|null/i.test(input.message);
  if (input.dependency) return "sev-2";
  if (crash && input.reproduced) return "sev-2";
  if (crash) return "sev-3";
  if (input.reproduced) return "sev-3";
  return "sev-4";
}

function classifyStatus(
  verdict: ValidationAnalysis["verdict"] | undefined,
  identified: boolean,
  patched: boolean,
): IncidentStatus {
  if (verdict === "resolved") return "resolved";
  if (verdict === "likely-resolved") return "monitoring";
  if (verdict === "unresolved") return "investigating";
  if (identified && patched) return "identified";
  if (identified) return "identified";
  return "investigating";
}

function buildImpact(type: string, loc: string | undefined, reproduction: ReproductionAnalysis | undefined): string {
  const where = loc ? ` at ${pathTail(loc)}` : "";
  if (reproduction?.result.reproduced) {
    return `${type} is reproducible${where}${reproduction.command ? ` via \`${reproduction.command}\`` : ""}.`;
  }
  return `${type} reported${where}; live reproduction did not run or did not fail.`;
}

function buildWhatHappened(
  type: string,
  message: string,
  loc: string | undefined,
  code: CodeInvestigation | undefined,
  reproduction: ReproductionAnalysis | undefined,
): string {
  const site = loc ? ` Crash site ${pathTail(loc)}.` : "";
  const expr = code?.trace.find((step) => step.role === "crash-site")?.expression;
  const expression = expr ? ` Expression: \`${expr}\`.` : "";
  const repro = reproduction?.result.reproduced ? " The failure reproduced locally." : "";
  return `${type}: ${message}.${site}${expression}${repro}`;
}

function buildFix(fix: FixAnalysis | undefined): string {
  if (!fix) return "No fix proposed yet.";
  const edit = fix.proposal.edits[0];
  if (!edit) return fix.summary;
  const applied = fix.proposal.applied ? "applied" : "not applied";
  return `${fix.summary} \`${oneLine(edit.oldString)}\` → \`${oneLine(edit.newString)}\` (${applied}).`;
}

function buildTimeline(input: Parameters<typeof buildIncidentReport>[0]): IncidentEvent[] {
  const events: IncidentEvent[] = [];
  if (input.logAnalysis?.crashSite || input.logAnalysis?.summary) {
    events.push({ label: "Detected", detail: input.logAnalysis.summary });
  }
  if (input.codeInvestigation?.summary) {
    events.push({ label: "Traced", detail: input.codeInvestigation.summary });
  }
  if (input.gitInvestigation?.introducing) {
    const commit = input.gitInvestigation.introducing;
    events.push({
      label: "Introduced",
      detail: `${commit.sha.slice(0, 8)} ${commit.subject} (${commit.author}, ${commit.date})`,
    });
  }
  if (input.production) {
    events.push({
      label: "Production",
      detail: [
        input.production.source,
        input.production.version ? `version ${input.production.version}` : undefined,
        input.production.affectedUsers != null ? `${input.production.affectedUsers} users` : undefined,
        input.production.firstSeen ? `first seen ${input.production.firstSeen}` : undefined,
        input.production.groupedCount ? `${input.production.groupedCount} similar` : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
  if (input.reproduction?.summary) {
    events.push({ label: "Reproduced", detail: input.reproduction.summary });
  }
  if (input.causeAnalysis?.leading) {
    events.push({
      label: "Diagnosed",
      detail: `${input.causeAnalysis.leading.id} ${input.causeAnalysis.leading.kind}: ${input.causeAnalysis.leading.description}`,
    });
  }
  if (input.fixAnalysis?.summary) {
    events.push({ label: "Patched", detail: input.fixAnalysis.summary });
  }
  if (input.testAnalysis?.summary) {
    events.push({ label: "Tested", detail: input.testAnalysis.summary });
  }
  if (input.validation?.summary) {
    events.push({ label: "Validated", detail: input.validation.summary });
  }
  return events;
}

function buildFollowUps(input: Parameters<typeof buildIncidentReport>[0]): string[] {
  const notes = [
    ...(input.validation?.handoff ?? []),
    ...(input.fixAnalysis?.proposal.applied ? [] : ["Apply the patch with --apply and re-run validation."]),
    ...(input.testAnalysis?.proposedTest && !input.testAnalysis.proposedTest.created
      ? [`Add regression coverage: ${input.testAnalysis.proposedTest.path}.`]
      : []),
    ...(input.gitInvestigation?.introducing
      ? [`Consider a regression note on ${input.gitInvestigation.introducing.sha.slice(0, 8)}.`]
      : []),
    ...(input.production?.recommendedAction === "rollback"
      ? ["Ship a rollback or a targeted hotfix; do not wait on a large application patch."]
      : []),
    ...(input.memory?.matches.length
      ? [`${input.memory.matches.length} similar historical crash${input.memory.matches.length === 1 ? "" : "es"} grouped with this incident.`]
      : []),
  ];
  return unique(notes).slice(0, 6);
}

function pathTail(loc: string): string {
  const parts = loc.replace(/\\/g, "/").split("/");
  return parts.slice(-2).join("/");
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}
