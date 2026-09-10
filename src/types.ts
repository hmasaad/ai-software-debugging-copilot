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
  language?: "javascript" | "python" | "java" | "go" | "unknown";
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
}

export type InvestigatorKind = "auto" | "heuristic" | "openai" | "anthropic" | "cursor";

export type PipelineStage =
  | "log-analyzer"
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

export type AgentId = "log-analyzer";

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
