/** Input describing a bug, crash, or failing test. */
export interface BugInput {
  repoPath: string;
  message?: string;
  stackTrace?: string;
  logText?: string;
  logPath?: string;
  failingTest?: string;
  extraContext?: string;
  version?: string;
  affectedUsers?: number;
  firstSeen?: string;
  incidentSource?: "crashlytics" | "sentry" | "logs";
  metrics?: ProductionMetrics;
}

export interface StackFrame {
  file: string;
  line?: number;
  column?: number;
  functionName?: string;
  raw: string;
  inProject: boolean;
}

export interface ParsedError {
  type?: string;
  message: string;
  stackTrace?: string;
  frames: StackFrame[];
  language?: "javascript" | "python" | "java" | "go" | "dart" | "unknown";
}

export interface SourceSnippet {
  file: string;
  startLine: number;
  endLine: number;
  focusLine?: number;
  content: string;
  language?: string;
}

export interface GitCommit {
  sha: string;
  author: string;
  date: string;
  subject: string;
  files?: string[];
}

export interface GitBlameLine {
  file: string;
  line: number;
  sha: string;
  author: string;
  date: string;
  summary: string;
}

export interface GitEvidence {
  available: boolean;
  branch?: string;
  head?: string;
  status?: string;
  recentCommits: GitCommit[];
  commitsTouchingSuspects: GitCommit[];
  blame: GitBlameLine[];
}

export interface PullRequestEvidence {
  number: number;
  title: string;
  url: string;
  state: string;
  author?: string;
  mergedAt?: string;
  files?: string[];
  body?: string;
  overlap?: string[];
}

export interface RelatedTest {
  file: string;
  reason: string;
}

export interface TestEvidence {
  runner?: string;
  testCommand?: string;
  relatedTests: RelatedTest[];
}

export interface DependencyHit {
  name: string;
  version?: string;
  source: string;
}

export interface DependencyEvidence {
  ecosystem?: string;
  manifest?: string;
  hits: DependencyHit[];
}

export interface RuntimeContext {
  os: string;
  arch: string;
  node?: string;
  python?: string;
  flutter?: string;
  dart?: string;
  xcode?: string;
  gradle?: string;
  kotlin?: string;
  device?: string;
  flavor?: string;
  gitBranch?: string;
  gitSha?: string;
  dependencies?: Array<{ name: string; version: string }>;
  cwd: string;
  ci: boolean;
  envHints: string[];
}

export interface LogEvidence {
  sources: string[];
  excerpt: string;
}

export interface EvidenceBundle {
  collectedAt: string;
  repoPath: string;
  error: ParsedError;
  logs: LogEvidence;
  sourceSnippets: SourceSnippet[];
  git: GitEvidence;
  pullRequests: PullRequestEvidence[];
  tests: TestEvidence;
  dependencies: DependencyEvidence;
  runtime: RuntimeContext;
  logAnalysis?: LogAnalysis;
  codeInvestigation?: CodeInvestigation;
  gitInvestigation?: GitInvestigation;
  dependencyAnalysis?: DependencyAnalysis;
  reproductionAnalysis?: ReproductionAnalysis;
  causeAnalysis?: CauseAnalysis;
  fixAnalysis?: FixAnalysis;
  testAnalysis?: TestAnalysis;
  validationAnalysis?: ValidationAnalysis;
  incidentReport?: IncidentReport;
  classification?: FailureClassification;
  environment?: EnvironmentAnalysis;
  specialists?: SpecialistFindings;
  blastRadius?: BlastRadiusAnalysis;
  memory?: DebuggingMemory;
  productionInvestigation?: ProductionInvestigation;
  rollbackIntelligence?: RollbackIntelligence;
  incidentTimeline?: IncidentTimeline;
  incidentResponse?: IncidentResponse;
  knowledgeGraph?: KnowledgeGraph;
}

export interface ReproductionResult {
  attempted: boolean;
  reproduced: boolean;
  command?: string;
  exitCode?: number;
  output: string;
  summary: string;
}

export interface Hypothesis {
  id: string;
  description: string;
  evidence: string[];
  likelihood: number;
}

export interface RootCauseAnalysis {
  summary: string;
  rootCause: string;
  confidence: number;
  hypotheses: Hypothesis[];
  affectedFiles: string[];
  reproSteps: string[];
  investigator: string;
}

export interface FileEdit {
  path: string;
  oldString: string;
  newString: string;
}

export interface FixProposal {
  summary: string;
  rationale: string;
  edits: FileEdit[];
  testPlan: string[];
  risks: string[];
  applied: boolean;
  applyErrors: string[];
}

export interface VerificationResult {
  testsRan: boolean;
  passed: boolean;
  command?: string;
  output: string;
  summary: string;
}

export type AttemptOutcome = "tests-failed" | "tests-passed" | "not-run";

export interface IterationRecord {
  index: number;
  attempt: number;
  outcome: AttemptOutcome;
  summary: string;
  rootCause: RootCauseAnalysis;
  fix: FixProposal;
  verification: VerificationResult;
}

export interface DebuggingReport {
  title: string;
  createdAt: string;
  repoPath: string;
  error: ParsedError;
  evidence: EvidenceBundle;
  reproduction: ReproductionResult;
  rootCause: RootCauseAnalysis;
  proposedFix: FixProposal;
  verification: VerificationResult;
  iterations: IterationRecord[];
  notes: string[];
  agentRuns: AgentRun[];
  logAnalysis: LogAnalysis;
  codeInvestigation: CodeInvestigation;
  gitInvestigation: GitInvestigation;
  dependencyAnalysis: DependencyAnalysis;
  reproductionAnalysis: ReproductionAnalysis;
  causeAnalysis: CauseAnalysis;
  fixAnalysis: FixAnalysis;
  testAnalysis: TestAnalysis;
  validationAnalysis: ValidationAnalysis;
  incidentReport: IncidentReport;
  sandbox?: SandboxSession;
  classification?: FailureClassification;
  environment?: EnvironmentAnalysis;
  specialists?: SpecialistFindings;
  blastRadius?: BlastRadiusAnalysis;
  memory?: DebuggingMemory;
  production?: ProductionIncident;
  productionInvestigation?: ProductionInvestigation;
  rollbackIntelligence?: RollbackIntelligence;
  incidentTimeline?: IncidentTimeline;
  incidentResponse?: IncidentResponse;
  knowledgeGraph?: KnowledgeGraph;
}

export interface PipelineOptions {
  repoPath: string;
  apply?: boolean;
  maxIterations?: number;
  runTests?: boolean;
  reportPath?: string;
  jsonReportPath?: string;
  investigator?: InvestigatorKind;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  onEvent?: (event: PipelineEvent) => void;
  investigatorInstance?: Investigator;
  autonomous?: boolean;
  keepSandbox?: boolean;
  baselineEnvPath?: string;
}

export type InvestigatorKind = "auto" | "heuristic" | "openai" | "anthropic" | "cursor";

export type PipelineStage =
  | "log-analyzer"
  | "classifier"
  | "environment"
  | "crash-agent"
  | "network-agent"
  | "database-agent"
  | "flutter-agent"
  | "code-investigator"
  | "git-investigator"
  | "first-bad-version"
  | "git-bisect"
  | "dependency-analyst"
  | "reproduction-agent"
  | "root-cause-agent"
  | "fix-agent"
  | "test-agent"
  | "validation-agent"
  | "blast-radius"
  | "memory"
  | "knowledge-graph"
  | "incident-detect"
  | "correlation"
  | "rollback-plan"
  | "rollback-intelligence"
  | "incident-timeline"
  | "incident-response"
  | "incident-agent"
  | "sandbox"
  | "autonomous"
  | "collect"
  | "reproduce"
  | "analyze"
  | "fix"
  | "test"
  | "verify"
  | "evals"
  | "report";

export interface PipelineEvent {
  stage: PipelineStage;
  agent?: string;
  message: string;
}

export interface Investigator {
  readonly name: string;
  analyze(input: BugInput, evidence: EvidenceBundle, reproduction: ReproductionResult): Promise<RootCauseAnalysis>;
  proposeFix(
    input: BugInput,
    evidence: EvidenceBundle,
    rca: RootCauseAnalysis,
    previousFailure?: string,
  ): Promise<FixProposal>;
}

export type AgentId =
  | "log-analyzer"
  | "classifier"
  | "crash-agent"
  | "network-agent"
  | "database-agent"
  | "flutter-agent"
  | "code-investigator"
  | "git-investigator"
  | "dependency-analyst"
  | "reproduction-agent"
  | "root-cause-agent"
  | "fix-agent"
  | "test-agent"
  | "validation-agent"
  | "incident-agent";

export interface AgentRun {
  id: AgentId;
  name: string;
  responsibility: string;
  status: "ok" | "error";
  summary: string;
  durationMs: number;
}

export interface ExceptionRecord {
  type?: string;
  message: string;
  role: "primary" | "caused-by" | "suppressed";
}

export interface LogLevelCounts {
  fatal: number;
  error: number;
  warn: number;
  info: number;
  debug: number;
}

export interface RepeatingLogLine {
  message: string;
  count: number;
}

/** Output of the Log Analyzer agent: logs, exceptions, and stack traces only. */
export interface LogAnalysis {
  error: ParsedError;
  logs: LogEvidence;
  crashSite?: StackFrame;
  exceptionChain: ExceptionRecord[];
  logLevels: LogLevelCounts;
  timestamps: string[];
  correlationIds: string[];
  repeating: RepeatingLogLine[];
  summary: string;
  handoff: string[];
}

export type TraceRole = "entry" | "caller" | "crash-site" | "callee";

export interface TraceStep {
  file: string;
  line?: number;
  functionName?: string;
  role: TraceRole;
  expression?: string;
  note: string;
}

export interface FunctionSpan {
  file: string;
  name: string;
  startLine: number;
  endLine: number;
  signature: string;
}

export interface CodeCaller {
  file: string;
  line: number;
  text: string;
}

/** Output of the Code Investigator: a path from the crash through source. */
export interface CodeInvestigation {
  origin?: StackFrame;
  trace: TraceStep[];
  functions: FunctionSpan[];
  callers: CodeCaller[];
  suspects: string[];
  snippets: SourceSnippet[];
  summary: string;
  handoff: string[];
}

export interface GitSuspect {
  sha: string;
  author: string;
  date: string;
  subject: string;
  score: number;
  reasons: string[];
}

/** Ranked git regression: when the bug likely appeared. */
export interface GitRegression {
  commit: GitSuspect;
  filesChanged: string[];
  changed: string[];
  diffExcerpt?: string;
  pullRequest?: PullRequestEvidence;
  confidence: number;
  summary: string;
}

export type VersionHealthStatus = "healthy" | "crashes" | "unknown";

export interface VersionHealth {
  version: string;
  status: VersionHealthStatus;
  source?: "reported" | "inferred" | "current";
}

/** First crashing release after a known-healthy one, plus the git window to inspect. */
export interface FirstBadVersion {
  lastHealthy?: string;
  firstBad: string;
  laterBad: string[];
  versions: VersionHealth[];
  commitCount: number;
  commits: GitCommit[];
  fromRef?: string;
  toRef?: string;
  inferredLastHealthy?: boolean;
  summary: string;
}

export type BisectVerdict = "good" | "bad" | "skip";

export interface GitBisectStep {
  sha: string;
  subject: string;
  verdict: BisectVerdict;
  remaining: number;
  detail?: string;
}

/** Automatic git bisect: binary-search the first commit that introduced the regression. */
export interface GitBisect {
  goodRef: string;
  badRef: string;
  steps: GitBisectStep[];
  firstBad?: GitCommit;
  testsRun: number;
  method: "source" | "test";
  summary: string;
}

/** Output of the Git Investigator: commits/PRs that likely introduced the problem. */
export interface GitInvestigation {
  evidence: GitEvidence;
  pullRequests: PullRequestEvidence[];
  suspects: GitSuspect[];
  introducing?: GitSuspect;
  regression?: GitRegression;
  firstBadVersion?: FirstBadVersion;
  bisect?: GitBisect;
  summary: string;
  handoff: string[];
}

export type DependencyIssueKind =
  | "missing-module"
  | "version-mismatch"
  | "peer-dependency"
  | "esm-cjs"
  | "lockfile-drift"
  | "none";

export interface DependencyIssue {
  kind: DependencyIssueKind;
  package?: string;
  detail: string;
  likelihood: number;
}

/** Output of the Dependency Analyst: version/install related issues. */
export interface DependencyAnalysis {
  evidence: DependencyEvidence;
  issues: DependencyIssue[];
  likelyDependencyBug: boolean;
  summary: string;
  handoff: string[];
}

export type ReproductionMethod =
  | "failing-test"
  | "related-test"
  | "test-suite"
  | "generated-test"
  | "error-as-repro";

export type ReproductionMatch = "matched" | "partial" | "unmatched" | "not-run";

export interface ReproductionSymptom {
  summary: string;
  errorType?: string;
  errorMessage: string;
  crashSite?: string;
  language?: ParsedError["language"];
  signals: string[];
}

export interface ReproductionScenario {
  title: string;
  setup: string[];
  action: string;
  expectedFailure: string;
}

export interface CapturedFailure {
  type?: string;
  message?: string;
  file?: string;
  line?: number;
  excerpt: string;
}

/** Output of the Reproduction Agent: how to reproduce the issue. */
export interface ReproductionAnalysis {
  result: ReproductionResult;
  method: ReproductionMethod;
  command?: string;
  runner?: string;
  relatedTests: RelatedTest[];
  steps: string[];
  symptoms: ReproductionSymptom;
  scenario: ReproductionScenario;
  generatedTest?: ProposedTest;
  capturedFailure?: CapturedFailure;
  match: ReproductionMatch;
  matchDetail: string;
  confidence: number;
  summary: string;
  handoff: string[];
}

export type CauseKind =
  | "crash-site"
  | "null-deref"
  | "introducing-commit"
  | "dependency"
  | "environment"
  | "api"
  | "database"
  | "flutter"
  | "known-incident"
  | "unreproducible"
  | "untested";

export interface RankedCause {
  id: string;
  kind: CauseKind;
  description: string;
  evidence: string[];
  likelihood: number;
}

/** Output of the Root Cause Agent: ranked possible causes plus an evidence graph. */
export interface CauseAnalysis {
  causes: RankedCause[];
  leading?: RankedCause;
  confidence: number;
  affectedFiles: string[];
  graph: EvidenceGraph;
  summary: string;
  handoff: string[];
}

export type EvidenceGraphNodeKind =
  | "crash"
  | "function"
  | "repository"
  | "api"
  | "source"
  | "null-value"
  | "commit"
  | "pr"
  | "dependency"
  | "environment"
  | "memory";

export interface EvidenceGraphNode {
  id: string;
  kind: EvidenceGraphNodeKind;
  label: string;
  detail?: string;
}

export interface EvidenceCheck {
  id: string;
  label: string;
  present: boolean;
  supports: boolean;
  detail: string;
}

/** Causal chain from the crash to the claimed root cause, with supporting and contradicting evidence. */
export interface EvidenceGraph {
  claim: string;
  confidence: number;
  nodes: EvidenceGraphNode[];
  supporting: EvidenceCheck[];
  contradicting: EvidenceCheck[];
  summary: string;
}

export type FixStrategy =
  | "optional-chain"
  | "nullish-default"
  | "investigator"
  | "dependency-install"
  | "environment-align"
  | "none";

export type FixRiskLevel = "LOW" | "MEDIUM" | "HIGH";

export interface FixRisk {
  label: string;
  files: number;
  tests: number;
  modules: number;
  level: FixRiskLevel;
  confidence: number;
  preferred: boolean;
  filePaths: string[];
  reasons: string[];
}

/** Output of the Fix Agent: a minimal code fix. */
export interface FixAnalysis {
  proposal: FixProposal;
  strategy: FixStrategy;
  source: "investigator" | "heuristic";
  summary: string;
  handoff: string[];
  risk?: FixRisk;
  alternatives?: FixRisk[];
}

export interface ProposedTest {
  path: string;
  content: string;
  reason: string;
  created: boolean;
}

/** Output of the Test Agent: tests created and/or run against the fix. */
export interface TestAnalysis {
  verification: VerificationResult;
  relatedTests: RelatedTest[];
  proposedTest?: ProposedTest;
  createdFiles: string[];
  summary: string;
  handoff: string[];
}

export type ValidationVerdict = "resolved" | "likely-resolved" | "unresolved" | "inconclusive";

export interface ValidationCheck {
  id: string;
  passed: boolean;
  detail: string;
}

/** Output of the Validation Agent: did the fix actually resolve the issue? */
export interface ValidationAnalysis {
  verdict: ValidationVerdict;
  resolved: boolean;
  checks: ValidationCheck[];
  residualRisks: string[];
  summary: string;
  handoff: string[];
}

export type IncidentSeverity = "sev-1" | "sev-2" | "sev-3" | "sev-4";
export type IncidentStatus = "investigating" | "identified" | "monitoring" | "resolved";

export interface IncidentEvent {
  label: string;
  detail: string;
}

/** Output of the Incident Agent: an engineer-friendly incident report. */
export interface IncidentReport {
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  impact: string;
  whatHappened: string;
  rootCause: string;
  fix: string;
  validation: string;
  timeline: IncidentEvent[];
  followUps: string[];
  body: string;
  summary: string;
  handoff: string[];
  production?: ProductionIncident;
}

export type FailureFamily = "runtime" | "build" | "logic" | "dependency" | "other";

export type FailureCategory =
  | "runtime-crash"
  | "build-failure"
  | "dependency-issue"
  | "api-backend-issue"
  | "database-issue"
  | "ui-issue"
  | "state-management-issue"
  | "performance-issue"
  | "concurrency-race"
  | "configuration-environment"
  | "security-issue"
  | "logic-error";

export interface FailureClassification {
  family: FailureFamily;
  category: FailureCategory;
  subtype?: string;
  confidence: number;
  signals: string[];
  routedAgents: AgentId[];
  summary: string;
}

export interface EnvironmentMismatch {
  tool: string;
  expected: string;
  actual: string;
}

export interface EnvironmentAnalysis {
  local: RuntimeContext;
  baseline?: RuntimeContext;
  localLabel: string;
  baselineLabel?: string;
  mismatches: EnvironmentMismatch[];
  summary: string;
}

export interface CrashAnalysis {
  kind: "null-crash" | "anr" | "exception" | "unknown";
  crashSite?: string;
  exceptionType?: string;
  summary: string;
  handoff: string[];
}

export interface NetworkAnalysis {
  protocol?: string;
  status?: string;
  endpoint?: string;
  summary: string;
  handoff: string[];
}

export interface DatabaseAnalysis {
  engine?: string;
  operation?: string;
  summary: string;
  handoff: string[];
}

export type FlutterDomain =
  | "bloc"
  | "dio"
  | "drift"
  | "di"
  | "lifecycle"
  | "widget"
  | "async"
  | "platform-channel"
  | "ios-build"
  | "android-build";

export interface FlutterAnalysis {
  usesBloc: boolean;
  usesDio: boolean;
  usesDrift: boolean;
  usesDi: boolean;
  usesPlatformChannels: boolean;
  usesLifecycle: boolean;
  usesAsync: boolean;
  iosBuild: boolean;
  androidBuild: boolean;
  implicated: FlutterDomain[];
  widgets: string[];
  blocs: string[];
  summary: string;
  handoff: string[];
}

export interface SpecialistFindings {
  crash?: CrashAnalysis;
  network?: NetworkAnalysis;
  database?: DatabaseAnalysis;
  flutter?: FlutterAnalysis;
  dependency?: DependencyAnalysis;
}

export interface BlastRadiusNode {
  name: string;
  kind: "symbol" | "file" | "bloc" | "screen";
  impact: "high" | "low";
  surface: string;
}

export type BlastRadiusSeverity = "HIGH" | "MEDIUM" | "LOW";

export type BlastRadiusLayerId =
  | "function"
  | "call-graph"
  | "modules"
  | "features"
  | "apis"
  | "database"
  | "users";

export interface BlastRadiusLayer {
  id: BlastRadiusLayerId;
  label: string;
  items: string[];
}

export interface BlastRadiusAnalysis {
  origin: string;
  usedBy: BlastRadiusNode[];
  high: string[];
  low: string[];
  direct: string[];
  indirect: string[];
  severity: BlastRadiusSeverity;
  workflowShare: number;
  workflowLabel: string;
  layers: BlastRadiusLayer[];
  question: string;
  summary: string;
}

export interface IncidentMemoryEntry {
  id: string;
  createdAt: string;
  errorType?: string;
  errorMessage: string;
  category: FailureCategory;
  rootCause: string;
  fix: string;
  resolution: string;
  files: string[];
  fingerprint?: string;
  commit?: string;
  components?: string[];
}

export interface MemoryMatch {
  entry: IncidentMemoryEntry;
  score: number;
}

export interface DebuggingMemory {
  stored: boolean;
  latest?: IncidentMemoryEntry;
  matches: MemoryMatch[];
  summary: string;
}

export type KnowledgeGraphKind =
  | "incident"
  | "root-cause"
  | "commit"
  | "fix"
  | "affected-components"
  | "resolution";

export interface KnowledgeGraphNode {
  kind: KnowledgeGraphKind;
  label: string;
  detail: string;
}

export interface KnowledgeGraph {
  nodes: KnowledgeGraphNode[];
  similarCount: number;
  similar: MemoryMatch[];
  summary: string;
}

export interface ProductionIncident {
  source?: "crashlytics" | "sentry" | "logs" | "local";
  version?: string;
  affectedUsers?: number;
  firstSeen?: string;
  groupedCount?: number;
  fingerprint?: string;
  likelyCause: string;
  suggestedFix?: string;
  confidence: number;
  recommendedAction: "rollback" | "hotfix" | "investigate";
  summary: string;
}

export type IncidentSignalKind = "log" | "crash" | "metric";

export interface IncidentSignal {
  kind: IncidentSignalKind;
  source: string;
  at?: string;
  summary: string;
  weight: number;
}

export interface ProductionMetrics {
  errorRate?: number;
  baselineErrorRate?: number;
  latencyP95Ms?: number;
  baselineLatencyP95Ms?: number;
  crashFreeUsers?: number;
  requests?: number;
  crashes?: number;
  deployedMinutesAgo?: number;
  newDependency?: string;
}

export interface IncidentDetection {
  detected: boolean;
  severity: IncidentSeverity;
  reason: string;
  signals: IncidentSignal[];
  summary: string;
}

export type CorrelationEventKind =
  | "crash-spike"
  | "latency-spike"
  | "deployment"
  | "new-dependency"
  | "app-version";

export interface CorrelationEvent {
  kind: CorrelationEventKind;
  label: string;
  detail: string;
  present: boolean;
  weight: number;
  at?: string;
}

export interface CorrelationLink {
  left: string;
  right: string;
  reason: string;
  strength: number;
}

export interface IncidentCorrelation {
  fingerprint?: string;
  deploy?: { sha?: string; version?: string; at?: string; minutesBefore?: number };
  events: CorrelationEvent[];
  links: CorrelationLink[];
  correlated: boolean;
  potentialIncident: boolean;
  newDependency?: string;
  summary: string;
}

export interface RollbackPlan {
  action: "rollback" | "hotfix" | "investigate";
  target?: string;
  steps: string[];
  risks: string[];
  summary: string;
}

export type MitigationAction = "patch" | "rollback" | "feature-flag" | "configuration" | "disable";

export interface RollbackIntelligence {
  canSafelyPatch: boolean;
  action: MitigationAction;
  target?: string;
  reason: string;
  fallbacks: MitigationAction[];
  steps: string[];
  summary: string;
}

export interface IncidentTimelineEvent {
  at: string;
  minutes: number;
  label: string;
}

export interface IncidentTimeline {
  events: IncidentTimelineEvent[];
  impactAt?: string;
  summary: string;
}

export type IncidentResponsePath = "rollback" | "fix";

export type IncidentResponseStage =
  | "Detection"
  | "Investigation"
  | "Diagnosis"
  | "Risk Analysis"
  | "Rollback"
  | "Fix"
  | "Validation"
  | "Monitoring"
  | "RESOLVED";

export type ResponseGate = "AUTO" | "APPROVAL";

export type ResponseActionId =
  | "read-logs"
  | "investigate"
  | "create-reproduction"
  | "generate-patch"
  | "run-tests"
  | "create-pr"
  | "deploy"
  | "rollback-production"
  | "delete-modify-data";

export interface IncidentResponseAction {
  id: ResponseActionId;
  label: string;
  gate: ResponseGate;
  status: "done" | "ready" | "blocked" | "waiting-approval" | "skipped";
  detail: string;
}

export interface IncidentResponse {
  path: IncidentResponsePath;
  stage: IncidentResponseStage;
  actions: IncidentResponseAction[];
  waiting: string[];
  reason: string;
  summary: string;
}

export interface ProductionInvestigation {
  detection: IncidentDetection;
  logs: IncidentSignal[];
  crashes: IncidentSignal[];
  metrics?: ProductionMetrics;
  correlation: IncidentCorrelation;
  firstBadVersion?: FirstBadVersion;
  rollbackPlan: RollbackPlan;
  rollbackIntelligence?: RollbackIntelligence;
  incidentTimeline?: IncidentTimeline;
  incidentResponse?: IncidentResponse;
  summary: string;
}

export interface EvalDimensions {
  rootCause?: boolean;
  reproduction?: boolean;
  fix?: boolean;
  test?: boolean;
  /** True when this case is a false-positive mistake (bad). */
  falsePositive?: boolean;
  /** True when a human still has to act (approval, toolchain, build, or unfinished fix). */
  humanIntervention?: boolean;
  iterations?: number;
}

export interface EvalCaseResult {
  id: string;
  title: string;
  passed: boolean;
  detail: string;
  durationMs: number;
  required?: boolean;
  dimensions?: EvalDimensions;
}

export interface EvalMetrics {
  rootCauseAccuracy: number;
  reproductionRate: number;
  fixSuccessRate: number;
  regressionTestRate: number;
  falsePositiveRate: number;
  avgDebugTimeMs: number;
  humanInterventionRate: number;
  avgIterations: number;
  caseCount: number;
  passedCount: number;
}

export interface EvalRun {
  cases: EvalCaseResult[];
  metrics: EvalMetrics;
  summary: string;
}

export type SandboxKind = "worktree" | "clone" | "copy";

export type SandboxTool =
  | "inspect-repo"
  | "search-code"
  | "inspect-git"
  | "run-tests"
  | "reproduce"
  | "modify-code"
  | "inspect-diff"
  | "revert";

export interface SandboxAction {
  tool: SandboxTool;
  detail: string;
  ok: boolean;
}

export interface SandboxSession {
  originRepo: string;
  path: string;
  kind: SandboxKind;
  promoted: boolean;
  reverted: boolean;
  actions: SandboxAction[];
}

export interface AutonomousDebugResult {
  report: DebuggingReport;
  originRepo: string;
  sandboxPath: string;
  sandboxKind: SandboxKind;
  promoted: boolean;
  reverted: boolean;
  diff: string;
  actions: SandboxAction[];
}
