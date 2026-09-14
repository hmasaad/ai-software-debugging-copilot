import type {
  BlastRadiusAnalysis,
  CauseAnalysis,
  CodeInvestigation,
  FileEdit,
  FixAnalysis,
  GitInvestigation,
  IncidentResponse,
  IncidentResponseAction,
  IncidentResponsePath,
  IncidentResponseStage,
  LogAnalysis,
  ReproductionAnalysis,
  RollbackIntelligence,
  RootCauseAnalysis,
  TestAnalysis,
  ValidationAnalysis,
} from "../types.js";

const GATE_COL = 26;

export const INCIDENT_RESPONSE_FLOW = [
  "             Detection",
  "                 ↓",
  "          Investigation",
  "                 ↓",
  "            Diagnosis",
  "                 ↓",
  "          Risk Analysis",
  "                 ↓",
  "       ┌─────────┴─────────┐",
  "       ↓                   ↓",
  "    Rollback             Fix",
  "       │                   │",
  "       └─────────┬─────────┘",
  "                 ↓",
  "             Validation",
  "                 ↓",
  "            Monitoring",
  "                 ↓",
  "              RESOLVED",
].join("\n");

export const RESPONSE_GATES = [
  { id: "read-logs" as const, label: "Read logs", gate: "AUTO" as const },
  { id: "investigate" as const, label: "Investigate", gate: "AUTO" as const },
  { id: "create-reproduction" as const, label: "Create reproduction", gate: "AUTO" as const },
  { id: "generate-patch" as const, label: "Generate patch", gate: "AUTO" as const },
  { id: "run-tests" as const, label: "Run tests", gate: "AUTO" as const },
  { id: "create-pr" as const, label: "Create PR", gate: "AUTO" as const },
  { id: "deploy" as const, label: "Deploy", gate: "APPROVAL" as const },
  { id: "rollback-production" as const, label: "Rollback production", gate: "APPROVAL" as const },
  { id: "delete-modify-data" as const, label: "Delete/modify data", gate: "APPROVAL" as const },
];

export const INCIDENT_RESPONSE_GATES = RESPONSE_GATES.map((action) => `${action.label.padEnd(GATE_COL)}${action.gate}`).join(
  "\n",
);

const DATA_MUTATION =
  /\b(DELETE\s+FROM|DROP\s+(TABLE|DATABASE)|TRUNCATE\s+|unlinkSync\s*\(|rmSync\s*\(|fs\.rm\s*\(|rm\s+-rf)\b/i;

export function looksLikeDataMutation(edits: FileEdit[] = []): boolean {
  return edits.some((edit) => DATA_MUTATION.test(edit.newString) || DATA_MUTATION.test(edit.oldString));
}

export function canExecuteAutonomously(action: IncidentResponseAction["id"] | string): boolean {
  return RESPONSE_GATES.find((item) => item.id === action)?.gate === "AUTO";
}

export function buildIncidentResponse(input: {
  logAnalysis?: LogAnalysis;
  codeInvestigation?: CodeInvestigation;
  gitInvestigation?: GitInvestigation;
  reproduction?: ReproductionAnalysis | { attempted?: boolean; reproduced?: boolean; result?: { attempted?: boolean } };
  causeAnalysis?: CauseAnalysis;
  rootCause?: RootCauseAnalysis;
  blastRadius?: BlastRadiusAnalysis;
  fixAnalysis?: FixAnalysis;
  testAnalysis?: TestAnalysis;
  validation?: ValidationAnalysis;
  rollbackIntelligence?: RollbackIntelligence;
  production?: boolean;
}): IncidentResponse {
  const production = Boolean(input.production);
  const mutating = looksLikeDataMutation(input.fixAnalysis?.proposal.edits);
  const path: IncidentResponsePath =
    production && input.rollbackIntelligence && !input.rollbackIntelligence.canSafelyPatch ? "rollback" : "fix";
  const validated = Boolean(input.validation?.resolved || input.validation?.verdict === "likely-resolved");
  const stage = resolveStage({ ...input, production, path, validated });
  const actions = RESPONSE_GATES.map((spec) =>
    decorateAction(spec, { ...input, production, path, validated, mutating }),
  );
  const waiting = actions.filter((action) => action.status === "waiting-approval").map((action) => action.label);
  const reason =
    mutating
      ? "Delete/modify data requires human approval."
      : path === "rollback"
        ? input.rollbackIntelligence?.reason ?? "Containment needs a human before production changes."
        : validated
          ? production
            ? "Fix is ready; production deploy still needs approval."
            : "Smallest safe fix ran autonomously."
          : "Autonomous path through investigation, diagnosis, and risk analysis.";
  const summary = waiting.length
    ? `Autonomous response: ${pathTitle(path)} path at ${stage}. Waiting for approval: ${waiting.join(", ")}.`
    : `Autonomous response: ${pathTitle(path)} path at ${stage}. Waiting for approval: none.`;
  return { path, stage, actions, waiting, reason, summary };
}

export function renderIncidentResponseAscii(response?: IncidentResponse): string {
  const locked = [INCIDENT_RESPONSE_FLOW, INCIDENT_RESPONSE_GATES].join("\n\n");
  if (!response) return locked;
  return [
    locked,
    "",
    `Path: ${pathTitle(response.path)}`,
    `Stage: ${response.stage}`,
    `Waiting for approval: ${response.waiting.length ? response.waiting.join(", ") : "none"}`,
    `Reason: ${response.reason}`,
  ].join("\n");
}

function pathTitle(path: IncidentResponsePath): string {
  return path === "rollback" ? "Rollback" : "Fix";
}

function resolveStage(input: {
  logAnalysis?: LogAnalysis;
  codeInvestigation?: CodeInvestigation;
  gitInvestigation?: GitInvestigation;
  causeAnalysis?: CauseAnalysis;
  rootCause?: RootCauseAnalysis;
  blastRadius?: BlastRadiusAnalysis;
  fixAnalysis?: FixAnalysis;
  rollbackIntelligence?: RollbackIntelligence;
  production: boolean;
  path: IncidentResponsePath;
  validated: boolean;
}): IncidentResponseStage {
  if (!input.logAnalysis) return "Detection";
  if (!input.codeInvestigation && !input.gitInvestigation) return "Investigation";
  if (!input.rootCause && !input.causeAnalysis?.leading) return "Diagnosis";
  if (!input.rollbackIntelligence && !input.fixAnalysis?.risk && !input.blastRadius) return "Risk Analysis";
  if (input.path === "rollback") {
    if (input.validated) return input.production ? "Monitoring" : "RESOLVED";
    return "Rollback";
  }
  if (!input.fixAnalysis?.proposal.edits.length) return "Fix";
  if (!input.validated) return "Validation";
  if (input.production) return "Monitoring";
  return "RESOLVED";
}

function decorateAction(
  spec: (typeof RESPONSE_GATES)[number],
  input: {
    logAnalysis?: LogAnalysis;
    codeInvestigation?: CodeInvestigation;
    gitInvestigation?: GitInvestigation;
    reproduction?: ReproductionAnalysis | { attempted?: boolean; reproduced?: boolean; result?: { attempted?: boolean } };
    causeAnalysis?: CauseAnalysis;
    rootCause?: RootCauseAnalysis;
    fixAnalysis?: FixAnalysis;
    testAnalysis?: TestAnalysis;
    production: boolean;
    path: IncidentResponsePath;
    validated: boolean;
    mutating: boolean;
  },
): IncidentResponseAction {
  const diagnosed = Boolean(input.rootCause || input.causeAnalysis?.leading);
  const patched = Boolean(input.fixAnalysis?.proposal.edits.length);
  const tested = Boolean(input.testAnalysis?.verification.testsRan);
  const reproduced = Boolean(
    input.reproduction &&
      ("result" in input.reproduction
        ? input.reproduction.result?.attempted
        : input.reproduction.attempted || input.reproduction.reproduced),
  );

  if (spec.id === "read-logs") {
    return action(spec, input.logAnalysis ? "done" : "ready", input.logAnalysis ? "Logs collected." : "Ready to read logs.");
  }
  if (spec.id === "investigate") {
    return action(
      spec,
      input.codeInvestigation || input.gitInvestigation ? "done" : "ready",
      "Code, git, and correlation may run without approval.",
    );
  }
  if (spec.id === "create-reproduction") {
    return action(spec, reproduced ? "done" : "ready", "Reproduction scenarios run autonomously.");
  }
  if (spec.id === "generate-patch") {
    const status = patched ? "done" : diagnosed ? "ready" : "blocked";
    return action(spec, status, patched ? "Patch generated." : "Safe code edits may be generated autonomously.");
  }
  if (spec.id === "run-tests") {
    const status = tested ? "done" : patched ? "ready" : "blocked";
    return action(spec, status, tested ? "Tests ran." : "Tests run autonomously against the patch.");
  }
  if (spec.id === "create-pr") {
    const status = patched && (input.validated || input.fixAnalysis?.proposal.applied) ? "ready" : "blocked";
    return action(spec, status, "Opening a PR is allowed without extra approval.");
  }
  if (spec.id === "deploy") {
    if (!input.production || input.path !== "fix") {
      return action(spec, "skipped", "Not a production deploy. Local --apply is not a release.");
    }
    return action(
      spec,
      input.validated ? "waiting-approval" : "blocked",
      "Production deploy requires a human.",
    );
  }
  if (spec.id === "rollback-production") {
    if (!input.production || input.path !== "rollback") {
      return action(spec, "skipped", "No production rollback requested.");
    }
    return action(spec, "waiting-approval", "Rolling back production requires a human.");
  }
  return action(
    spec,
    input.mutating ? "waiting-approval" : "skipped",
    input.mutating ? "This patch mutates data and is blocked until a human approves." : "No data mutation proposed.",
  );
}

function action(
  spec: (typeof RESPONSE_GATES)[number],
  status: IncidentResponseAction["status"],
  detail: string,
): IncidentResponseAction {
  return { id: spec.id, label: spec.label, gate: spec.gate, status, detail };
}
