import type {
  AgentId,
  AgentRun,
  BugInput,
  CauseAnalysis,
  CodeInvestigation,
  CrashAnalysis,
  DatabaseAnalysis,
  DebuggingMemory,
  DependencyAnalysis,
  EnvironmentAnalysis,
  EvidenceBundle,
  FailureClassification,
  FixAnalysis,
  FlutterAnalysis,
  GitInvestigation,
  IncidentReport,
  Investigator,
  LogAnalysis,
  NetworkAnalysis,
  ProductionInvestigation,
  ReproductionAnalysis,
  RootCauseAnalysis,
  SpecialistFindings,
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
  classification?: FailureClassification;
  environment?: EnvironmentAnalysis;
  specialists?: SpecialistFindings;
  memory?: DebuggingMemory;
  investigation?: ProductionInvestigation;
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

export const CLASSIFIER = {
  id: "classifier" as const satisfies AgentId,
  name: "Failure Classifier",
  responsibility: "Classify the failure before investigation and route specialists",
};

export const CRASH_AGENT = {
  id: "crash-agent" as const satisfies AgentId,
  name: "Crash Agent",
  responsibility: "Specialize in runtime crashes, null derefs, and ANRs",
};

export const NETWORK_AGENT = {
  id: "network-agent" as const satisfies AgentId,
  name: "Network Agent",
  responsibility: "Specialize in API, HTTP, and backend failures",
};

export const DATABASE_AGENT = {
  id: "database-agent" as const satisfies AgentId,
  name: "Database Agent",
  responsibility: "Specialize in database and persistence failures",
};

export const FLUTTER_AGENT = {
  id: "flutter-agent" as const satisfies AgentId,
  name: "Flutter Debugging Agent",
  responsibility: "Understand Bloc, Dio, Drift, DI, lifecycle, widgets, async, platform channels, and iOS/Android builds",
};

export const CODE_INVESTIGATOR = {
  id: "code-investigator" as const satisfies AgentId,
  name: "Code Investigator",
  responsibility: "Trace the error through the codebase",
};

export const GIT_INVESTIGATOR = {
  id: "git-investigator" as const satisfies AgentId,
  name: "Git Investigator",
  responsibility: "Find when the bug appeared (git regression)",
};

export const DEPENDENCY_ANALYST = {
  id: "dependency-analyst" as const satisfies AgentId,
  name: "Dependency Analyst",
  responsibility: "Detect dependency/version-related issues",
};

export const REPRODUCTION_AGENT = {
  id: "reproduction-agent" as const satisfies AgentId,
  name: "Reproduction Agent",
  responsibility: "Reproduce the issue and match it against the reported failure",
};

export const ROOT_CAUSE_AGENT = {
  id: "root-cause-agent" as const satisfies AgentId,
  name: "Root Cause Agent",
  responsibility: "Build an evidence graph and rank possible causes",
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
  responsibility: "Triage production crashes and write an engineer-friendly incident report",
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
  FailureClassification,
  CrashAnalysis,
  NetworkAnalysis,
  DatabaseAnalysis,
  FlutterAnalysis,
};
