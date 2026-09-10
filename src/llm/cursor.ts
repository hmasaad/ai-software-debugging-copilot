import type {
  BugInput,
  EvidenceBundle,
  FileEdit,
  FixProposal,
  Investigator,
  ReproductionResult,
  RootCauseAnalysis,
} from "../types.js";
import { buildEvidenceBrief, parseJsonObject } from "../prompts/investigation.js";

const INVESTIGATION_INSTRUCTIONS = `You are Debugging Copilot. Investigate this bug like a staff engineer.

Do all of the following, in order, using the repository tools available to you:
1. Collect any extra evidence you need (read files, git log/blame, tests, dependencies).
2. Try to reproduce the failure.
3. Identify the most likely root cause, with competing hypotheses.
4. Implement a minimal fix.
5. Run tests that validate the fix.
6. If tests fail, iterate (max 2 more attempts).

When you are done, reply with a single JSON object (you may wrap it in a markdown fence):
{
  "summary": "...",
  "rootCause": "...",
  "confidence": 0.0,
  "hypotheses": [{"id":"H1","description":"...","evidence":["..."],"likelihood":0.0}],
  "affectedFiles": ["..."],
  "reproSteps": ["..."],
  "fixSummary": "...",
  "rationale": "...",
  "edits": [{"path":"relative/file","oldString":"...","newString":"..."}],
  "testPlan": ["..."],
  "risks": ["..."],
  "verificationSummary": "..."
}
If you already applied the fix in the working tree, still include the edits you made.`;

export class CursorInvestigator implements Investigator {
  readonly name = "cursor";
  private lastFix?: FixProposal;
  private lastRca?: RootCauseAnalysis;

  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      repoPath: string;
    },
  ) {}

  async analyze(
    input: BugInput,
    evidence: EvidenceBundle,
    reproduction: ReproductionResult,
  ): Promise<RootCauseAnalysis> {
    const payload = await this.run(input, evidence, reproduction);
    this.lastRca = payload.rca;
    this.lastFix = payload.fix;
    return payload.rca;
  }

  async proposeFix(): Promise<FixProposal> {
    if (this.lastFix) return this.lastFix;
    return {
      summary: "Cursor agent did not return a structured fix.",
      rationale: this.lastRca?.rootCause ?? "",
      edits: [],
      testPlan: [],
      risks: ["Inspect the agent transcript."],
      applied: false,
      applyErrors: [],
    };
  }

  private async run(
    input: BugInput,
    evidence: EvidenceBundle,
    reproduction: ReproductionResult,
  ): Promise<{ rca: RootCauseAnalysis; fix: FixProposal }> {
    const sdk = await loadCursorSdk();
    const prompt = [
      INVESTIGATION_INSTRUCTIONS,
      "",
      buildEvidenceBrief(input, evidence, reproduction),
    ].join("\n");

    const result = await sdk.Agent.prompt(prompt, {
      apiKey: this.options.apiKey,
      model: { id: this.options.model },
      local: { cwd: this.options.repoPath },
    });

    const text = extractResultText(result);
    const parsed = parseJsonObject<{
      summary?: string;
      rootCause?: string;
      confidence?: number;
      hypotheses?: RootCauseAnalysis["hypotheses"];
      affectedFiles?: string[];
      reproSteps?: string[];
      fixSummary?: string;
      rationale?: string;
      edits?: FileEdit[];
      testPlan?: string[];
      risks?: string[];
      verificationSummary?: string;
    }>(text);

    const rca: RootCauseAnalysis = {
      summary: parsed.summary ?? text.slice(0, 800),
      rootCause: parsed.rootCause ?? parsed.summary ?? "See Cursor agent transcript.",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.6,
      hypotheses: parsed.hypotheses ?? [],
      affectedFiles: parsed.affectedFiles ?? [],
      reproSteps: parsed.reproSteps ?? [],
      investigator: this.name,
    };

    const fix: FixProposal = {
      summary: parsed.fixSummary ?? parsed.summary ?? "Cursor agent fix",
      rationale: parsed.rationale ?? rca.rootCause,
      edits: parsed.edits ?? [],
      testPlan: parsed.testPlan ?? [],
      risks: parsed.risks ?? [],
      applied: false,
      applyErrors: parsed.verificationSummary ? [parsed.verificationSummary] : [],
    };

    return { rca, fix };
  }
}

async function loadCursorSdk(): Promise<{
  Agent: { prompt: (prompt: string, options: Record<string, unknown>) => Promise<unknown> };
}> {
  try {
    const spec: string = "@cursor/sdk";
    return (await import(spec)) as {
      Agent: { prompt: (prompt: string, options: Record<string, unknown>) => Promise<unknown> };
    };
  } catch {
    throw new Error(
      "Cursor investigator requires `@cursor/sdk`. Install it with `npm install @cursor/sdk` and set CURSOR_API_KEY.",
    );
  }
}

function extractResultText(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const record = result as { result?: unknown; status?: string };
  const inner = record.result;
  if (typeof inner === "string") return inner;
  if (inner && typeof inner === "object") {
    const maybe = inner as { text?: string; message?: { content?: unknown } };
    if (typeof maybe.text === "string") return maybe.text;
    if (Array.isArray(maybe.message?.content)) {
      return maybe.message.content
        .map((block) => {
          if (block && typeof block === "object" && "text" in block) {
            return String((block as { text: unknown }).text);
          }
          return "";
        })
        .join("\n");
    }
  }
  return JSON.stringify(result);
}
