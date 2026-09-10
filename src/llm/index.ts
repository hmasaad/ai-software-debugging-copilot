import type { Investigator, InvestigatorKind, PipelineOptions } from "../types.js";
import { loadConfig, type CopilotConfig } from "../config.js";
import { HeuristicInvestigator } from "./heuristic.js";
import { anthropicComplete, LlmInvestigator, openaiComplete } from "./openai.js";
import { CursorInvestigator } from "./cursor.js";

export function createInvestigator(
  options: PipelineOptions,
  config: CopilotConfig = loadConfig(options),
): Investigator {
  const kind: InvestigatorKind = config.investigator;

  if (kind === "heuristic") {
    return new HeuristicInvestigator();
  }

  if (kind === "cursor") {
    if (!config.cursorApiKey) {
      throw new Error("CURSOR_API_KEY is required for the Cursor investigator.");
    }
    return new CursorInvestigator({
      apiKey: config.cursorApiKey,
      model: config.cursorModel,
      repoPath: options.repoPath,
    });
  }

  if (kind === "anthropic") {
    if (!config.anthropicApiKey) {
      throw new Error("ANTHROPIC_API_KEY is required for the Anthropic investigator.");
    }
    return new LlmInvestigator("anthropic", (messages) =>
      anthropicComplete({ apiKey: config.anthropicApiKey!, model: config.anthropicModel }, messages),
    );
  }

  if (kind === "openai") {
    if (!config.openaiApiKey) {
      throw new Error("OPENAI_API_KEY is required for the OpenAI investigator.");
    }
    return new LlmInvestigator("openai", (messages, json) =>
      openaiComplete(
        { apiKey: config.openaiApiKey!, baseUrl: config.openaiBaseUrl, model: config.openaiModel },
        messages,
        json,
      ),
    );
  }

  return new HeuristicInvestigator();
}

export { HeuristicInvestigator } from "./heuristic.js";
export { LlmInvestigator } from "./openai.js";
export { CursorInvestigator } from "./cursor.js";
