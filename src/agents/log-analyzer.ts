import { collectErrorAndLogs } from "../collectors/logs.js";
import type {
  AgentRun,
  BugInput,
  ExceptionRecord,
  LogAnalysis,
  LogLevelCounts,
  RepeatingLogLine,
  StackFrame,
} from "../types.js";
import { LOG_ANALYZER, type SpecialistAgent } from "./types.js";

/**
 * Log Analyzer — the first core specialist.
 * Owns logs, exceptions, and stack traces. Does not inspect source, git, or tests.
 */
export class LogAnalyzerAgent implements SpecialistAgent<LogAnalysis> {
  readonly id = LOG_ANALYZER.id;
  readonly name = LOG_ANALYZER.name;
  readonly responsibility = LOG_ANALYZER.responsibility;

  async run(input: BugInput): Promise<{ result: LogAnalysis; run: AgentRun }> {
    const started = Date.now();
    const result = await this.analyze(input);
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

  async analyze(input: BugInput): Promise<LogAnalysis> {
    const { error, logs } = await collectErrorAndLogs(input);
    const text = logs.excerpt || error.stackTrace || error.message;
    const exceptionChain = extractExceptionChain(text, error);
    const crashSite = error.frames.find((frame) => frame.inProject) ?? error.frames[0];
    const logLevels = countLogLevels(text);
    const timestamps = extractTimestamps(text);
    const correlationIds = extractCorrelationIds(text);
    const repeating = extractRepeating(text);
    const handoff = buildHandoff(crashSite, exceptionChain, error);
    const summary = buildSummary(error, crashSite, exceptionChain, logLevels, repeating);

    return {
      error,
      logs,
      crashSite,
      exceptionChain,
      logLevels,
      timestamps,
      correlationIds,
      repeating,
      summary,
      handoff,
    };
  }
}

export function extractExceptionChain(text: string, parsed: { type?: string; message: string }): ExceptionRecord[] {
  const chain: ExceptionRecord[] = [];
  const seen = new Set<string>();

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const caused = line.match(/^Caused by:\s*(?<type>[A-Za-z_][\w.$]*)\s*:\s*(?<msg>.*)$/i);
    if (caused?.groups) {
      pushChain(chain, seen, {
        type: caused.groups.type,
        message: (caused.groups.msg ?? "").trim(),
        role: "caused-by",
      });
      continue;
    }

    if (/During handling of the above exception|The above exception was the direct cause/i.test(line)) {
      continue;
    }

    const named = line.match(/^(?<type>[A-Za-z_][\w.$]*(?:Error|Exception|Fault|Panic))\s*:\s*(?<msg>.*)$/);
    if (named?.groups) {
      pushChain(chain, seen, {
        type: named.groups.type,
        message: (named.groups.msg ?? "").trim(),
        role: chain.length === 0 ? "primary" : "caused-by",
      });
    }
  }

  if (chain.length === 0) {
    chain.push({ type: parsed.type, message: parsed.message, role: "primary" });
  } else if (chain[0]) {
    chain[0] = { ...chain[0], role: "primary" };
  }

  return chain;
}

export function countLogLevels(text: string): LogLevelCounts {
  const counts: LogLevelCounts = { fatal: 0, error: 0, warn: 0, info: 0, debug: 0 };
  for (const line of text.split("\n")) {
    if (/\bFATAL\b|\bCRITICAL\b/i.test(line)) counts.fatal += 1;
    else if (/\bERROR\b|\bTypeError\b|\bException\b|\bERR_/i.test(line)) counts.error += 1;
    else if (/\bWARN(?:ING)?\b/i.test(line)) counts.warn += 1;
    else if (/\bINFO\b/i.test(line)) counts.info += 1;
    else if (/\bDEBUG\b|\bTRACE\b/i.test(line)) counts.debug += 1;
  }
  return counts;
}

export function extractTimestamps(text: string): string[] {
  const matches = text.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g) ?? [];
  return unique(matches).slice(0, 8);
}

export function extractCorrelationIds(text: string): string[] {
  const found: string[] = [];
  const pattern =
    /\b(?:request[-_ ]?id|correlation[-_ ]?id|trace[-_]?id|span[-_]?id|cid)[=: ]+([A-Za-z0-9._-]+)/gi;
  for (const match of text.matchAll(pattern)) {
    if (match[1]) found.push(match[1]);
  }
  return unique(found).slice(0, 8);
}

export function extractRepeating(text: string): RepeatingLogLine[] {
  const counts = new Map<string, number>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length < 12) continue;
    if (!/(error|exception|fail|fatal|typeerror|npe)/i.test(line)) continue;
    const key = line
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g, "")
      .replace(/\b\d+\b/g, "N")
      .replace(/0x[0-9a-f]+/gi, "0xN")
      .replace(/\s+/g, " ")
      .trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([message, count]) => ({ message, count }));
}

function buildHandoff(
  crashSite: StackFrame | undefined,
  chain: ExceptionRecord[],
  error: { type?: string; message: string },
): string[] {
  const notes: string[] = [];
  if (crashSite) {
    const loc = `${crashSite.file}${crashSite.line ? `:${crashSite.line}` : ""}`;
    const fn = crashSite.functionName ? ` (${crashSite.functionName})` : "";
    notes.push(`Inspect crash site ${loc}${fn} — top ${crashSite.inProject ? "project" : "external"} frame.`);
  } else {
    notes.push("No stack frames parsed; other agents should not assume a source location.");
  }

  const inner = [...chain].reverse().find((item) => item.role === "caused-by");
  if (inner) {
    notes.push(`Innermost exception is ${inner.type ?? "Error"}: ${inner.message}. Treat this as the likely origin.`);
  }

  if (/undefined|null|nil/i.test(error.message)) {
    notes.push("Null/undefined dereference — look for a missing guard at the crash site.");
  }

  return notes;
}

function buildSummary(
  error: { type?: string; message: string; language?: string; frames: StackFrame[] },
  crashSite: StackFrame | undefined,
  chain: ExceptionRecord[],
  levels: LogLevelCounts,
  repeating: RepeatingLogLine[],
): string {
  const kind = error.type ?? "Error";
  const site = crashSite
    ? `${crashSite.file}${crashSite.line ? `:${crashSite.line}` : ""}${crashSite.functionName ? ` in ${crashSite.functionName}` : ""}`
    : "an unknown location";
  const inner = [...chain].reverse().find((item) => item.role === "caused-by");
  const repeat = repeating[0] ? ` Repeated log line x${repeating[0].count}.` : "";
  const volume = levels.fatal + levels.error > 0 ? ` ${levels.fatal + levels.error} error-level line(s).` : "";
  const nested = inner ? ` Nested ${inner.type ?? "exception"}: ${inner.message}.` : "";
  return `${kind}: ${error.message} at ${site}.${nested}${volume}${repeat}`.replace(/\s+/g, " ").trim();
}

function pushChain(chain: ExceptionRecord[], seen: Set<string>, record: ExceptionRecord): void {
  const key = `${record.type}:${record.message}:${record.role}`;
  if (seen.has(key)) return;
  seen.add(key);
  chain.push(record);
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
