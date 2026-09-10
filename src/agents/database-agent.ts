import type { AgentRun, DatabaseAnalysis, LogAnalysis } from "../types.js";
import { DATABASE_AGENT, type AgentContext, type SpecialistAgent } from "./types.js";

export class DatabaseAgent implements SpecialistAgent<DatabaseAnalysis> {
  readonly id = DATABASE_AGENT.id;
  readonly name = DATABASE_AGENT.name;
  readonly responsibility = DATABASE_AGENT.responsibility;

  async run(ctx: AgentContext): Promise<{ result: DatabaseAnalysis; run: AgentRun }> {
    const started = Date.now();
    const result = this.analyze(ctx.logAnalysis, ctx.input.extraContext);
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

  analyze(log?: LogAnalysis, extra?: string): DatabaseAnalysis {
    const blob = `${log?.error.message ?? ""} ${log?.logs.excerpt ?? ""} ${extra ?? ""}`;
    const engine = /\bdrift\b/i.test(blob)
      ? "drift"
      : /postgres/i.test(blob)
        ? "postgres"
        : /sqlite/i.test(blob)
          ? "sqlite"
          : /mongo/i.test(blob)
            ? "mongodb"
            : "unknown";
    const operation = blob.match(/\b(select|insert|update|delete|migration)\b/i)?.[1];
    return {
      engine,
      operation,
      summary: `Database agent: ${engine}${operation ? ` ${operation}` : ""} issue.`,
      handoff: [
        "Inspect schema/migrations and nullability of the failing query.",
        engine === "drift" ? "Check Drift generated tables against the model." : "Confirm the database is reachable in this environment.",
      ],
    };
  }
}
