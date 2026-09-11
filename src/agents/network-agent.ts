import type { AgentRun, LogAnalysis, NetworkAnalysis } from "../types.js";
import { NETWORK_AGENT, type AgentContext, type SpecialistAgent } from "./types.js";

export class NetworkAgent implements SpecialistAgent<NetworkAnalysis> {
  readonly id = NETWORK_AGENT.id;
  readonly name = NETWORK_AGENT.name;
  readonly responsibility = NETWORK_AGENT.responsibility;

  async run(ctx: AgentContext): Promise<{ result: NetworkAnalysis; run: AgentRun }> {
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

  analyze(log?: LogAnalysis, extra?: string): NetworkAnalysis {
    const blob = `${log?.error.message ?? ""} ${log?.logs.excerpt ?? ""} ${extra ?? ""}`;
    const status = blob.match(/\b(status(?: code)?|HTTP)\s*[:=]?\s*(\d{3})\b/i)?.[2];
    const endpoint = blob.match(/https?:\/\/[^\s)'"]+/)?.[0];
    const protocol = /dioexception|\bdio\b/i.test(blob)
      ? "dio"
      : /socketexception|econnrefused/i.test(blob)
        ? "tcp"
        : endpoint
          ? "http"
          : undefined;
    return {
      protocol,
      status,
      endpoint,
      summary: `Network agent: ${protocol ?? "request"} failure${status ? ` (${status})` : ""}${endpoint ? ` at ${endpoint}` : ""}.`,
      handoff: [
        "Check timeout, base URL, and auth headers before patching UI state.",
        status ? `HTTP ${status} suggests a backend/contract issue.` : "No HTTP status captured from logs.",
      ],
    };
  }
}
