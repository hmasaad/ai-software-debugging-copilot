import type { AgentRun, CrashAnalysis, LogAnalysis } from "../types.js";
import { CRASH_AGENT, type AgentContext, type SpecialistAgent } from "./types.js";

export class CrashAgent implements SpecialistAgent<CrashAnalysis> {
  readonly id = CRASH_AGENT.id;
  readonly name = CRASH_AGENT.name;
  readonly responsibility = CRASH_AGENT.responsibility;

  async run(ctx: AgentContext): Promise<{ result: CrashAnalysis; run: AgentRun }> {
    const started = Date.now();
    const result = this.analyze(ctx.logAnalysis);
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

  analyze(log?: LogAnalysis): CrashAnalysis {
    const error = log?.error;
    const blob = `${error?.type ?? ""} ${error?.message ?? ""}`;
    const kind = /anr|not responding/i.test(blob)
      ? "anr"
      : /null|undefined/i.test(blob)
        ? "null-crash"
        : error?.type
          ? "exception"
          : "unknown";
    const crashSite = log?.crashSite
      ? `${log.crashSite.file}${log.crashSite.line ? `:${log.crashSite.line}` : ""}`
      : undefined;
    return {
      kind,
      crashSite,
      exceptionType: error?.type,
      summary: `Crash agent: ${kind}${crashSite ? ` at ${crashSite}` : ""}.`,
      handoff: [
        crashSite ? `Inspect crash site ${crashSite}.` : "No project crash site parsed.",
        kind === "null-crash" ? "Guard null/undefined before dereference." : "Capture the top project frame and exception chain.",
      ],
    };
  }
}
