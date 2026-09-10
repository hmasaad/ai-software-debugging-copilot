import path from "node:path";
import type { ParsedError, StackFrame } from "../types.js";

const NODE_FRAME =
  /^\s*at\s+(?:(?<fn>.+?)\s+\()?(?:async\s+)?(?<file>(?:file:\/\/)?[^:()]+):(?<line>\d+)(?::(?<col>\d+))?\)?\s*$/;
const NODE_NATIVE = /^\s*at\s+(?<fn>.+?)\s+\((?<file>node:.*?)\)$/;
const PYTHON_FILE = /^\s*File "(?<file>.+)", line (?<line>\d+)(?:, in (?<fn>.+))?/;
const JAVA_FRAME = /^\s*at\s+(?<fn>[\w.$]+)\((?<file>[\w./\\-]+\.java):(?<line>\d+)\)/;
const GO_FILE = /^\s*(?<file>\S+\.go):(?<line>\d+)\s/;
const DART_FRAME =
  /^#\d+\s+(?<fn>\S+)\s+\((?:package:[^/]+\/)?(?<file>[^:)]+\.dart):(?<line>\d+)(?::(?<col>\d+))?\)/;
const DART_BARE = /(?<file>[\w./\\-]+\.dart):(?<line>\d+)(?::(?<col>\d+))?/;
const GENERIC_FILE_LINE = /(?<file>(?:\/|(?:[A-Za-z]:\\)|(?:\.{0,2}[\\/]))[^\s:()]+):(?<line>\d+)(?::(?<col>\d+))?/;

const SKIP_PATH_HINTS = [
  "node_modules",
  "site-packages",
  "/lib/python",
  "internal/process",
  "node:internal",
  "jest-runner",
  "vitest",
];

export function parseErrorText(raw: string, repoPath?: string): ParsedError {
  const text = raw.replace(/\r\n/g, "\n").trim();
  const language = detectLanguage(text);
  const frames = parseFrames(text, language, repoPath);
  const { type, message } = extractMessage(text, language);

  return {
    type,
    message,
    stackTrace: text,
    frames,
    language,
  };
}

function detectLanguage(text: string): ParsedError["language"] {
  if (/Traceback \(most recent call last\)/.test(text) || /^\s*File ".+", line \d+/m.test(text)) {
    return "python";
  }
  if (/^\s*at\s+[\w.$]+\([\w./\\-]+\.java:\d+\)/m.test(text) || /\b[\w.]+Exception\b/.test(text)) {
    if (/\.java\b/.test(text)) return "java";
  }
  if (/goroutine \d+ \[/.test(text) || /^\s*\S+\.go:\d+\s/m.test(text)) {
    return "go";
  }
  if (/Null check operator used on a null value/i.test(text) || /\.dart\b/.test(text) || /^#\d+\s+\S+\s+\(package:/m.test(text)) {
    return "dart";
  }
  if (/^\s*at\s+/m.test(text) || /(?:TypeError|ReferenceError|Error):/.test(text)) {
    return "javascript";
  }
  return "unknown";
}

function parseFrames(text: string, language: ParsedError["language"], repoPath?: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of text.split("\n")) {
    const frame = matchFrame(line, language);
    if (!frame) continue;
    frames.push(normalizeFrame(frame, repoPath));
  }
  return dedupeFrames(frames);
}

function matchFrame(line: string, language: ParsedError["language"]): Omit<StackFrame, "inProject"> | undefined {
  if (language === "python") {
    const match = line.match(PYTHON_FILE);
    if (match?.groups) {
      return {
        file: match.groups.file ?? "",
        line: num(match.groups.line),
        functionName: match.groups.fn,
        raw: line.trim(),
      };
    }
  }

  if (language === "java") {
    const match = line.match(JAVA_FRAME);
    if (match?.groups) {
      return {
        file: match.groups.file ?? "",
        line: num(match.groups.line),
        functionName: match.groups.fn,
        raw: line.trim(),
      };
    }
  }

  if (language === "go") {
    const match = line.match(GO_FILE);
    if (match?.groups) {
      return {
        file: match.groups.file ?? "",
        line: num(match.groups.line),
        raw: line.trim(),
      };
    }
  }

  if (language === "dart") {
    const dart = line.match(DART_FRAME) ?? line.match(DART_BARE);
    if (dart?.groups?.file) {
      return {
        file: dart.groups.file,
        line: num(dart.groups.line),
        column: num(dart.groups.col),
        functionName: dart.groups.fn,
        raw: line.trim(),
      };
    }
  }

  const node = line.match(NODE_FRAME) ?? line.match(NODE_NATIVE);
  if (node?.groups) {
    return {
      file: stripFileUrl(node.groups.file ?? ""),
      line: num(node.groups.line),
      column: num(node.groups.col),
      functionName: node.groups.fn,
      raw: line.trim(),
    };
  }

  const generic = line.match(GENERIC_FILE_LINE);
  if (generic?.groups && looksLikeSourceFile(generic.groups.file ?? "")) {
    return {
      file: generic.groups.file ?? "",
      line: num(generic.groups.line),
      column: num(generic.groups.col),
      raw: line.trim(),
    };
  }

  return undefined;
}

function normalizeFrame(frame: Omit<StackFrame, "inProject">, repoPath?: string): StackFrame {
  const file = stripFileUrl(frame.file);
  const inProject = isProjectFrame(file, repoPath);
  return { ...frame, file, inProject };
}

export function isProjectFrame(file: string, repoPath?: string): boolean {
  if (!file || file === "<anonymous>") return false;
  const normalized = file.replace(/\\/g, "/");
  if (SKIP_PATH_HINTS.some((hint) => normalized.includes(hint))) return false;
  if (normalized.startsWith("node:")) return false;
  if (!repoPath) return !path.isAbsolute(normalized) || looksLikeSourceFile(normalized);
  const repo = repoPath.replace(/\\/g, "/");
  return normalized.startsWith(repo) || !path.isAbsolute(file);
}

function extractMessage(text: string, language: ParsedError["language"]): { type?: string; message: string } {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);

  if (language === "python") {
    const last = [...lines].reverse().find((line) => /^[A-Za-z_][\w.]*:/.test(line));
    if (last) {
      const [type, ...rest] = last.split(":");
      return { type, message: rest.join(":").trim() || last };
    }
  }

  const dartNull = lines.find((line) => /Null check operator used on a null value/i.test(line));
  if (dartNull) {
    return { type: "NullCheckError", message: dartNull };
  }

  const errorLine = lines.find((line) =>
    /(?:Error|Exception|Panic|FATAL|TypeError|ReferenceError|ValueError|AssertionError)\b/.test(line),
  );
  if (errorLine) {
    const named = errorLine.match(/^(?<type>[A-Za-z_][\w.]*)[:\s]\s*(?<msg>.*)$/);
    if (named?.groups?.type) {
      return { type: named.groups.type, message: named.groups.msg || errorLine };
    }
    return { message: errorLine };
  }

  return { message: lines[0] ?? "Unknown error" };
}

function looksLikeSourceFile(file: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rs|rb|php|cs|cpp|c|h|dart)$/i.test(file);
}

function stripFileUrl(file: string): string {
  return file.replace(/^file:\/\//, "");
}

function num(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dedupeFrames(frames: StackFrame[]): StackFrame[] {
  const seen = new Set<string>();
  const result: StackFrame[] = [];
  for (const frame of frames) {
    const key = `${frame.file}:${frame.line}:${frame.functionName ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(frame);
  }
  return result;
}
