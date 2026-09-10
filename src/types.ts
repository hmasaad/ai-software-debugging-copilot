/** Input describing a bug, crash, or failing test. */
export interface BugInput {
  repoPath: string;
  message?: string;
  stackTrace?: string;
  logText?: string;
  logPath?: string;
  failingTest?: string;
  extraContext?: string;
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

export interface IterationRecord {
  index: number;
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
}

export type InvestigatorKind = "auto" | "heuristic" | "openai" | "anthropic" | "cursor";

export type PipelineStage =
  | "log-analyzer"
  | "code-investigator"
  | "git-investigator"
  | "dependency-analyst"
  | "reproduction-agent"
  | "root-cause-agent"
  | "fix-agent"
  | "test-agent"
  | "validation-agent"
  | "incident-agent"
  | "sandbox"
  | "autonomous"
  | "collect"
  | "reproduce"
  | "analyze"
  | "fix"
  | "test"
  | "verify"
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

/** Output of the Git Investigator: commits/PRs that likely introduced the problem. */
export interface GitInvestigation {
  evidence: GitEvidence;
  pullRequests: PullRequestEvidence[];
  suspects: GitSuspect[];
  introducing?: GitSuspect;
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

export type ReproductionMethod = "failing-test" | "related-test" | "test-suite" | "error-as-repro";

/** Output of the Reproduction Agent: how to reproduce the issue. */
export interface ReproductionAnalysis {
  result: ReproductionResult;
  method: ReproductionMethod;
  command?: string;
  runner?: string;
  relatedTests: RelatedTest[];
  steps: string[];
  summary: string;
  handoff: string[];
}

export type CauseKind =
  | "crash-site"
  | "null-deref"
  | "introducing-commit"
  | "dependency"
  | "environment"
  | "unreproducible"
  | "untested";

export interface RankedCause {
  id: string;
  kind: CauseKind;
  description: string;
  evidence: string[];
  likelihood: number;
}

/** Output of the Root Cause Agent: ranked possible causes. */
export interface CauseAnalysis {
  causes: RankedCause[];
  leading?: RankedCause;
  confidence: number;
  affectedFiles: string[];
  summary: string;
  handoff: string[];
}

export type FixStrategy = "optional-chain" | "nullish-default" | "investigator" | "dependency-install" | "none";

/** Output of the Fix Agent: a minimal code fix. */
export interface FixAnalysis {
  proposal: FixProposal;
  strategy: FixStrategy;
  source: "investigator" | "heuristic";
  summary: string;
  handoff: string[];
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
