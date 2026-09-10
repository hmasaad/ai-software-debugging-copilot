import type { AgentId, AgentRun, BugInput, CodeInvestigation, DependencyAnalysis, GitInvestigation, LogAnalysis } from "../types.js";

export interface AgentContext {
  input: BugInput;
  logAnalysis?: LogAnalysis;
  codeInvestigation?: CodeInvestigation;
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

export type { AgentId, AgentRun, LogAnalysis, CodeInvestigation, GitInvestigation, DependencyAnalysis };
