import type {
  BugInput,
  EvidenceBundle,
  FileEdit,
  FixProposal,
  Investigator,
  ReproductionResult,
  RootCauseAnalysis,
} from "../types.js";
import {
  buildEvidenceBrief,
  fixSystemPrompt,
  parseJsonObject,
  rcaSystemPrompt,
} from "../prompts/investigation.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ChatComplete = (messages: ChatMessage[], json?: boolean) => Promise<string>;

export class LlmInvestigator implements Investigator {
  constructor(
    readonly name: string,
    private readonly complete: ChatComplete,
  ) {}

  async analyze(
    input: BugInput,
    evidence: EvidenceBundle,
    reproduction: ReproductionResult,
  ): Promise<RootCauseAnalysis> {
    const brief = buildEvidenceBrief(input, evidence, reproduction);
    const text = await this.complete(
      [
        { role: "system", content: rcaSystemPrompt() },
        { role: "user", content: brief },
      ],
      true,
    );

    const parsed = parseJsonObject<{
      summary?: string;
      rootCause?: string;
      confidence?: number;
      hypotheses?: RootCauseAnalysis["hypotheses"];
      affectedFiles?: string[];
      reproSteps?: string[];
    }>(text);

    return {
      summary: parsed.summary ?? text.slice(0, 800),
      rootCause: parsed.rootCause ?? parsed.summary ?? "See summary.",
      confidence: clamp01(parsed.confidence ?? 0.5),
      hypotheses: Array.isArray(parsed.hypotheses) ? parsed.hypotheses : [],
      affectedFiles: parsed.affectedFiles ?? evidence.sourceSnippets.map((s) => s.file),
      reproSteps: parsed.reproSteps ?? [],
      investigator: this.name,
    };
  }

  async proposeFix(
    input: BugInput,
    evidence: EvidenceBundle,
    rca: RootCauseAnalysis,
    previousFailure?: string,
  ): Promise<FixProposal> {
    const brief = buildEvidenceBrief(input, evidence, {
      attempted: false,
      reproduced: true,
      output: "",
      summary: "See root-cause analysis.",
    });

    const user = [
      brief,
      "",
      "## Root cause analysis",
      JSON.stringify(rca, null, 2),
      previousFailure ? `\n## Previous patch failed verification\n${previousFailure}` : "",
    ].join("\n");

    const text = await this.complete(
      [
        { role: "system", content: fixSystemPrompt() },
        { role: "user", content: user },
      ],
      true,
    );

    const parsed = parseJsonObject<{
      summary?: string;
      rationale?: string;
      edits?: FileEdit[];
      testPlan?: string[];
      risks?: string[];
    }>(text);

    const edits = (parsed.edits ?? []).filter(
      (edit) => edit.path && typeof edit.oldString === "string" && typeof edit.newString === "string",
    );

    return {
      summary: parsed.summary ?? "Proposed fix",
      rationale: parsed.rationale ?? rca.rootCause,
      edits,
      testPlan: parsed.testPlan ?? [],
      risks: parsed.risks ?? [],
      applied: false,
      applyErrors: [],
    };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

export async function openaiComplete(
  options: { apiKey: string; baseUrl: string; model: string },
  messages: ChatMessage[],
  json = false,
): Promise<string> {
  const url = `${options.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model,
      temperature: 0.1,
      messages,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI-compatible API ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI-compatible API returned no content");
  return content;
}

export async function anthropicComplete(
  options: { apiKey: string; model: string },
  messages: ChatMessage[],
): Promise<string> {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": options.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: options.model,
      max_tokens: 4000,
      temperature: 0.1,
      system,
      messages: rest.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = data.content?.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
  if (!text) throw new Error("Anthropic API returned no text");
  return text;
}
