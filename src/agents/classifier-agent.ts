import type { AgentRun, FailureClassification, LogAnalysis } from "../types.js";
import { classifyFailure } from "../analysis/classify.js";
import { CLASSIFIER, type AgentContext, type SpecialistAgent } from "./types.js";

export class ClassifierAgent implements SpecialistAgent<FailureClassification> {
  readonly id = CLASSIFIER.id;
  readonly name = CLASSIFIER.name;
  readonly responsibility = CLASSIFIER.responsibility;

  async run(ctx: AgentContext): Promise<{ result: FailureClassification; run: AgentRun }> {
    const started = Date.now();
    const result = this.analyze(ctx.input, ctx.logAnalysis);
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

  analyze(input: AgentContext["input"], logAnalysis?: LogAnalysis): FailureClassification {
    return classifyFailure({
      error: logAnalysis?.error,
      logAnalysis,
      message: input.message,
      stackTrace: input.stackTrace,
      extraContext: input.extraContext,
    });
  }
}
