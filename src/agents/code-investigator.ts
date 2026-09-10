import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { collectSourceSnippets, resolveExistingSource } from "../collectors/source.js";
import { tryCommand } from "../exec.js";
import type {
  AgentRun,
  CodeCaller,
  CodeInvestigation,
  FunctionSpan,
  LogAnalysis,
  StackFrame,
  TraceStep,
} from "../types.js";
import { LogAnalyzerAgent } from "./log-analyzer.js";
import { CODE_INVESTIGATOR, type AgentContext, type SpecialistAgent } from "./types.js";

/**
 * Code Investigator — traces the error through the codebase.
 * Starts from Log Analyzer's crash site and walks callers, callees, and the crashing expression.
 */
export class CodeInvestigatorAgent implements SpecialistAgent<CodeInvestigation> {
  readonly id = CODE_INVESTIGATOR.id;
  readonly name = CODE_INVESTIGATOR.name;
  readonly responsibility = CODE_INVESTIGATOR.responsibility;

  async run(ctx: AgentContext): Promise<{ result: CodeInvestigation; run: AgentRun }> {
    const started = Date.now();
    const logAnalysis = ctx.logAnalysis ?? (await new LogAnalyzerAgent().analyze(ctx.input));
    const result = await this.analyze(ctx.input.repoPath, logAnalysis);
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

  async analyze(repoPath: string, logAnalysis: LogAnalysis): Promise<CodeInvestigation> {
    const origin = logAnalysis.crashSite ?? logAnalysis.error.frames.find((frame) => frame.inProject);
    const projectFrames = logAnalysis.error.frames.filter((frame) => frame.inProject);
    const snippets = await collectSourceSnippets(repoPath, projectFrames.length ? projectFrames : logAnalysis.error.frames);

    const functions: FunctionSpan[] = [];
    const trace: TraceStep[] = [];
    const suspects = new Set<string>();

    const inbound = [...projectFrames].reverse();
    for (const [index, frame] of inbound.entries()) {
      const abs = await resolveExistingSource(repoPath, frame.file);
      const rel = abs ? relPath(repoPath, abs) : frame.file;
      const source = abs && existsSync(abs) ? await readFile(abs, "utf8") : undefined;
      const lines = source?.split("\n") ?? [];
      const lineNo = frame.line ?? 1;
      const lineText = lines[lineNo - 1] ?? "";
      const enclosing = source ? findEnclosingFunction(lines, lineNo) : undefined;
      if (enclosing) {
        functions.push({
          file: rel,
          name: enclosing.name,
          startLine: enclosing.start,
          endLine: enclosing.end,
          signature: enclosing.signature,
        });
      }

      for (const name of identifiers(lineText)) suspects.add(name);

      const isCrash = origin && sameFrame(frame, origin);
      const role = isCrash ? "crash-site" : index === 0 && !enclosing ? "entry" : "caller";
      trace.push({
        file: rel,
        line: frame.line,
        functionName: enclosing?.name ?? frame.functionName,
        role,
        expression: lineText.trim() || undefined,
        note: describeStep(role, lineText, frame, enclosing?.name),
      });
    }

    if (origin) {
      const abs = await resolveExistingSource(repoPath, origin.file);
      if (abs && existsSync(abs)) {
        const lines = (await readFile(abs, "utf8")).split("\n");
        const crashLine = lines[(origin.line ?? 1) - 1] ?? "";
        const callees = callNames(crashLine).filter((name) => name !== origin.functionName);
        for (const callee of callees.slice(0, 3)) {
          const def = findFunctionDefinition(lines, callee);
          const rel = relPath(repoPath, abs);
          trace.push({
            file: rel,
            line: def?.start,
            functionName: callee,
            role: "callee",
            note: def
              ? `Crash line calls ${callee}, defined at ${rel}:${def.start}.`
              : `Crash line calls ${callee}.`,
          });
          if (def) {
            functions.push({
              file: rel,
              name: callee,
              startLine: def.start,
              endLine: def.end,
              signature: def.signature,
            });
          }
        }
      }
    }

    const focusName = origin?.functionName ?? functions[0]?.name;
    const callers = focusName ? await findCallers(repoPath, focusName, origin?.file) : [];

    for (const caller of callers) {
      if (trace.some((step) => step.file === caller.file && step.line === caller.line)) continue;
      trace.push({
        file: caller.file,
        line: caller.line,
        functionName: focusName,
        role: "caller",
        expression: caller.text.trim(),
        note: `Other caller of ${focusName}: ${caller.text.trim()}`,
      });
    }

    const summary = buildSummary(origin, trace, suspects);
    const handoff = buildHandoff(origin, trace, callers, suspects);

    return {
      origin,
      trace: dedupeTrace(trace),
      functions: dedupeFunctions(functions),
      callers,
      suspects: [...suspects].slice(0, 12),
      snippets,
      summary,
      handoff,
    };
  }
}

export function findEnclosingFunction(
  lines: string[],
  focusLine: number,
): { name: string; start: number; end: number; signature: string } | undefined {
  for (let i = focusLine - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    const js = line.match(
      /(?:export\s+)?(?:async\s+)?function\s+(?<name>[A-Za-z_][\w]*)|(?:export\s+)?(?:const|let|var)\s+(?<name2>[A-Za-z_][\w]*)\s*=\s*(?:async\s*)?\(/,
    );
    const py = line.match(/^\s*(?:async\s+)?def\s+(?<name>[A-Za-z_][\w]*)\s*\(/);
    const name = js?.groups?.name ?? js?.groups?.name2 ?? py?.groups?.name;
    if (!name) continue;
    return {
      name,
      start: i + 1,
      end: findBlockEnd(lines, i + 1),
      signature: line.trim(),
    };
  }
  return undefined;
}

export function identifiers(line: string): string[] {
  const names = line.match(/\b[A-Za-z_][\w]*\b/g) ?? [];
  const skip = new Set([
    "return",
    "const",
    "let",
    "var",
    "await",
    "async",
    "function",
    "export",
    "import",
    "from",
    "if",
    "else",
    "new",
    "this",
    "console",
    "log",
    "true",
    "false",
    "null",
    "undefined",
    "def",
    "self",
    "None",
  ]);
  return [...new Set(names.filter((name) => !skip.has(name)))];
}

function callNames(line: string): string[] {
  return [...line.matchAll(/\b([A-Za-z_][\w]*)\s*\(/g)].map((match) => match[1]).filter((name): name is string => Boolean(name));
}

function findFunctionDefinition(lines: string[], name: string) {
  const pattern = new RegExp(`(?:function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\s*=|def\\s+${name}\\s*\\()`);
  const index = lines.findIndex((line) => pattern.test(line));
  if (index < 0) return undefined;
  return {
    start: index + 1,
    end: findBlockEnd(lines, index + 1),
    signature: (lines[index] ?? "").trim(),
  };
}

function findBlockEnd(lines: string[], startLine: number): number {
  let depth = 0;
  let started = false;
  for (let i = startLine - 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    for (const ch of line) {
      if (ch === "{") {
        depth += 1;
        started = true;
      } else if (ch === "}") {
        depth -= 1;
        if (started && depth <= 0) return i + 1;
      }
    }
    if (!started && /:\s*$/.test(line)) {
      const indent = /^\s*/.exec(line)?.[0].length ?? 0;
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j] ?? "";
        if (!next.trim()) continue;
        const nextIndent = /^\s*/.exec(next)?.[0].length ?? 0;
        if (nextIndent <= indent) return j;
      }
      return lines.length;
    }
  }
  return Math.min(lines.length, startLine + 40);
}

function describeStep(
  role: TraceStep["role"],
  lineText: string,
  frame: StackFrame,
  fn?: string,
): string {
  const loc = `${frame.file}${frame.line ? `:${frame.line}` : ""}`;
  const expr = lineText.trim();
  if (role === "crash-site") {
    if (/\.\w+/.test(expr) && !/\?\./.test(expr)) {
      return `Unguarded access at ${loc}${fn ? ` in ${fn}` : ""}: ${expr}`;
    }
    return `Crash expression at ${loc}: ${expr || frame.raw}`;
  }
  if (role === "entry") return `Entry point ${loc}: ${expr || "module scope"}`;
  return `Caller ${loc}${fn ? ` (${fn})` : ""}: ${expr || frame.raw}`;
}

async function findCallers(repoPath: string, name: string, originFile?: string): Promise<CodeCaller[]> {
  const grep = await tryCommand(
    "git",
    ["--no-pager", "grep", "-n", "-F", name, "--", "*.js", "*.jsx", "*.ts", "*.tsx", "*.mjs", "*.cjs", "*.py", "*.go", "*.java"],
    {
      cwd: repoPath,
      timeoutMs: 10_000,
      env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
    },
  );
  if (!grep || grep.code !== 0 || !grep.stdout.trim()) return [];

  const originBase = originFile ? path.basename(originFile) : "";
  const callers: CodeCaller[] = [];
  for (const raw of grep.stdout.split("\n")) {
    const match = raw.match(/^(?<file>[^:]+):(?<line>\d+):(?<text>.*)$/);
    if (!match?.groups?.file || !match.groups.line) continue;
    const file = match.groups.file;
    const line = Number.parseInt(match.groups.line, 10);
    const text = match.groups.text ?? "";
    if (originBase && path.basename(file) === originBase && new RegExp(`function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\s*=|def\\s+${name}\\b`).test(text)) {
      continue;
    }
    if (!new RegExp(`\\b${name}\\s*\\(`).test(text)) continue;
    callers.push({ file, line, text: text.trim() });
    if (callers.length >= 8) break;
  }
  return callers;
}

function sameFrame(a: StackFrame, b: StackFrame): boolean {
  return path.basename(a.file) === path.basename(b.file) && a.line === b.line;
}

function relPath(repoPath: string, abs: string): string {
  return path.relative(repoPath, abs) || abs;
}

function buildSummary(origin: StackFrame | undefined, trace: TraceStep[], suspects: Set<string>): string {
  const crash = trace.find((step) => step.role === "crash-site");
  const entry = trace.find((step) => step.role === "entry" || step.role === "caller");
  const site = crash
    ? `${crash.file}${crash.line ? `:${crash.line}` : ""}${crash.functionName ? ` in ${crash.functionName}` : ""}`
    : origin
      ? `${origin.file}${origin.line ? `:${origin.line}` : ""}`
      : "unknown location";
  const from = entry ? ` Reached from ${entry.file}${entry.line ? `:${entry.line}` : ""}.` : "";
  const names = [...suspects].slice(0, 5).join(", ");
  return `Traced crash to ${site}.${from}${names ? ` Suspects: ${names}.` : ""}`;
}

function buildHandoff(
  origin: StackFrame | undefined,
  trace: TraceStep[],
  callers: CodeCaller[],
  suspects: Set<string>,
): string[] {
  const notes: string[] = [];
  const crash = trace.find((step) => step.role === "crash-site");
  if (crash?.expression) notes.push(`Inspect ${crash.file}${crash.line ? `:${crash.line}` : ""} — ${crash.expression}`);
  const caller = trace.find((step) => step.role === "caller" || step.role === "entry");
  if (caller) notes.push(`Trace inbound call at ${caller.file}${caller.line ? `:${caller.line}` : ""}.`);
  if (callers.length > 1) notes.push(`${callers.length} call sites of ${origin?.functionName ?? "the crashing function"} — check arguments at each.`);
  if (suspects.size) notes.push(`Identifiers on the crashing path: ${[...suspects].slice(0, 8).join(", ")}.`);
  return notes;
}

function dedupeTrace(steps: TraceStep[]): TraceStep[] {
  const seen = new Set<string>();
  const result: TraceStep[] = [];
  for (const step of steps) {
    const key = `${step.role}:${step.file}:${step.line ?? 0}:${step.functionName ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(step);
  }
  return result;
}

function dedupeFunctions(fns: FunctionSpan[]): FunctionSpan[] {
  const seen = new Set<string>();
  const result: FunctionSpan[] = [];
  for (const fn of fns) {
    const key = `${fn.file}:${fn.name}:${fn.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(fn);
  }
  return result;
}
