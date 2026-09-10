import type { AgentId, AgentRun, BugInput, LogAnalysis } from "../types.js";

export interface SpecialistAgent<T> {
  readonly id: AgentId;
  readonly name: string;
  readonly responsibility: string;
  run(input: BugInput): Promise<{ result: T; run: AgentRun }>;
}

export const LOG_ANALYZER = {
  id: "log-analyzer" as const satisfies AgentId,
  name: "Log Analyzer",
  responsibility: "Understand logs, exceptions and stack traces",
};

export type { AgentId, AgentRun, LogAnalysis };
