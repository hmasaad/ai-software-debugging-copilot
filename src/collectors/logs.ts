import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseErrorText } from "./stack-trace.js";
import type { BugInput, LogEvidence, ParsedError } from "../types.js";
import { truncate } from "../exec.js";

export async function collectErrorAndLogs(input: BugInput): Promise<{ error: ParsedError; logs: LogEvidence }> {
  const sources: string[] = [];
  const chunks: string[] = [];

  if (input.message) {
    sources.push("message");
    chunks.push(input.message);
  }
  if (input.stackTrace) {
    sources.push("stack-trace");
    chunks.push(input.stackTrace);
  }
  if (input.logText) {
    sources.push("log-text");
    chunks.push(input.logText);
  }
  if (input.logPath && existsSync(input.logPath)) {
    sources.push(input.logPath);
    chunks.push(await readFile(input.logPath, "utf8"));
  }
  if (input.failingTest) {
    sources.push("failing-test");
    chunks.push(`Failing test: ${input.failingTest}`);
  }
  if (input.extraContext) {
    sources.push("context");
    chunks.push(input.extraContext);
  }

  const combined = chunks.join("\n\n").trim();
  const error = parseErrorText(combined || "No error details provided", input.repoPath);

  return {
    error,
    logs: {
      sources,
      excerpt: truncate(combined, 16_000),
    },
  };
}
