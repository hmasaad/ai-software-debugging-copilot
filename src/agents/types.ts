import type {
  AgentId,
  AgentRun,
  BugInput,
  CauseAnalysis,
  CodeInvestigation,
  DependencyAnalysis,
  EvidenceBundle,
  FixAnalysis,
  GitInvestigation,
  IncidentReport,
  Investigator,
  LogAnalysis,
  ReproductionAnalysis,
  RootCauseAnalysis,
  TestAnalysis,
  ValidationAnalysis,
} from "../types.js";

export interface AgentContext {
  input: BugInput;
  logAnalysis?: LogAnalysis;
  codeInvestigation?: CodeInvestigation;
  gitInvestigation?: GitInvestigation;
  dependencyAnalysis?: DependencyAnalysis;
  evidence?: EvidenceBundle;
  reproduction?: ReproductionAnalysis;
  causeAnalysis?: CauseAnalysis;
  rootCause?: RootCauseAnalysis;
  fixAnalysis?: FixAnalysis;
  testAnalysis?: TestAnalysis;
  validationAnalysis?: ValidationAnalysis;
  incidentReport?: IncidentReport;
  investigator?: Investigator;
  runTests?: boolean;
  apply?: boolean;
  previousFailure?: string;
}

export interface SpecialistAgent<T> {
  readonly id: AgentId;
  readonly name: string;
  readonly responsibility: string;
  run(ctx: AgentContext): Promise<{ result: T; run: AgentRun }>;
}

export const LOG_ANALYZER = {
  id: "log-analyzer" as const satisfies AgentId,
  name: "Log Analyzer",
  responsibility: "Understand logs, exceptions and stack traces",
};

export const CODE_INVESTIGATOR = {
  id: "code-investigator" as const satisfies AgentId,
  name: "Code Investigator",
  responsibility: "Trace the error through the codebase",
};

export const GIT_INVESTIGATOR = {
  id: "git-investigator" as const satisfies AgentId,
  name: "Git Investigator",
  responsibility: "Find commits/PRs that introduced the problem",
};

export const DEPENDENCY_ANALYST = {
  id: "dependency-analyst" as const satisfies AgentId,
  name: "Dependency Analyst",
  responsibility: "Detect dependency/version-related issues",
};

export const REPRODUCTION_AGENT = {
  id: "reproduction-agent" as const satisfies AgentId,
  name: "Reproduction Agent",
  responsibility: "Determine how to reproduce the issue",
};

export const ROOT_CAUSE_AGENT = {
  id: "root-cause-agent" as const satisfies AgentId,
  name: "Root Cause Agent",
  responsibility: "Build and rank possible causes",
};

export const FIX_AGENT = {
  id: "fix-agent" as const satisfies AgentId,
  name: "Fix Agent",
  responsibility: "Generate a minimal code fix",
};

export const TEST_AGENT = {
  id: "test-agent" as const satisfies AgentId,
  name: "Test Agent",
  responsibility: "Create/run tests against the fix",
};

export const VALIDATION_AGENT = {
  id: "validation-agent" as const satisfies AgentId,
  name: "Validation Agent",
  responsibility: "Check whether the fix actually resolves the issue",
};

export const INCIDENT_AGENT = {
  id: "incident-agent" as const satisfies AgentId,
  name: "Incident Agent",
  responsibility: "Produce an engineer-friendly incident report",
};

export type {
  AgentId,
  AgentRun,
  LogAnalysis,
  CodeInvestigation,
  GitInvestigation,
  DependencyAnalysis,
  ReproductionAnalysis,
  CauseAnalysis,
  FixAnalysis,
  TestAnalysis,
  ValidationAnalysis,
  IncidentReport,
};
