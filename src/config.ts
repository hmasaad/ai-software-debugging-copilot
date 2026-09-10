import { existsSync } from "node:fs";
import path from "node:path";
import type { InvestigatorKind, PipelineOptions } from "./types.js";

export interface CopilotConfig {
  investigator: InvestigatorKind;
  openaiApiKey?: string;
  openaiBaseUrl: string;
  openaiModel: string;
  anthropicApiKey?: string;
  anthropicModel: string;
  cursorApiKey?: string;
  cursorModel: string;
}

export function loadConfig(overrides: Partial<PipelineOptions> = {}): CopilotConfig {
  const openaiApiKey = overrides.apiKey ?? process.env.OPENAI_API_KEY;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const cursorApiKey = process.env.CURSOR_API_KEY;

  let investigator: InvestigatorKind = overrides.investigator ?? "auto";
  if (investigator === "auto") {
    if (cursorApiKey) investigator = "cursor";
    else if (openaiApiKey) investigator = "openai";
    else if (anthropicApiKey) investigator = "anthropic";
    else investigator = "heuristic";
  }

  return {
    investigator,
    openaiApiKey,
    openaiBaseUrl: overrides.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    openaiModel: overrides.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1",
    anthropicApiKey,
    anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
    cursorApiKey,
    cursorModel: process.env.CURSOR_MODEL ?? "composer-2.5",
  };
}

export function resolveRepoPath(input: string): string {
  const resolved = path.resolve(input);
  if (!existsSync(resolved)) {
    throw new Error(`Repository path does not exist: ${resolved}`);
  }
  return resolved;
}
