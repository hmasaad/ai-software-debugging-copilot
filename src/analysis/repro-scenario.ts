import path from "node:path";
import { parseErrorText } from "../collectors/stack-trace.js";
import type {
  CapturedFailure,
  ParsedError,
  ProposedTest,
  ReproductionMatch,
  ReproductionScenario,
  ReproductionSymptom,
  StackFrame,
  TestEvidence,
} from "../types.js";

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "used",
  "null",
  "undefined",
  "error",
  "exception",
  "cannot",
  "reading",
  "properties",
  "operator",
  "value",
  "check",
]);

export function understandSymptoms(input: {
  error: ParsedError;
  crashSite?: StackFrame;
  extraContext?: string;
  message?: string;
}): ReproductionSymptom {
  const error = input.error;
  const loc = input.crashSite
    ? `${input.crashSite.file}${input.crashSite.line ? `:${input.crashSite.line}` : ""}`
    : undefined;
  const blob = `${error.type ?? ""} ${error.message} ${input.message ?? ""} ${input.extraContext ?? ""}`;
  const signals: string[] = [];

  if (/null check operator|cannot read propert|undefined \(reading|NullPointer|is null|nil pointer/i.test(blob)) {
    signals.push("null-deref");
  }
  if (/\bNaN\b|Expected .* to equal/i.test(blob)) signals.push("assertion-mismatch");
  if (error.language === "dart" || /\.dart\b|flutter/i.test(blob)) signals.push("flutter");
  if (/timeout|econnrefused|network/i.test(blob)) signals.push("environment");
  if (input.crashSite?.functionName) signals.push("crash-function");

  const type = error.type ?? "Error";
  const where = loc ? ` at ${path.basename(loc)}` : "";
  const summary = `${type}${where}: ${clip(error.message, 140)}`;

  return {
    summary,
    errorType: error.type,
    errorMessage: error.message,
    crashSite: loc,
    language: error.language,
    signals,
  };
}

export function buildScenario(input: {
  symptoms: ReproductionSymptom;
  crashSite?: StackFrame;
  method: string;
  command?: string;
  generatedTest?: ProposedTest;
}): ReproductionScenario {
  const fn = input.crashSite?.functionName;
  const loc = input.symptoms.crashSite;
  const nullish = input.symptoms.signals.includes("null-deref");
  const title = scenarioTitle(input.symptoms, input.crashSite);
  const setup = [
    loc ? `Start from crash site \`${loc}\`${fn ? ` (${fn})` : ""}.` : "Start from the reported stack trace.",
    nullish ? "Feed a null/missing payload on the same path (API response, argument, or state)." : "Replay the same inputs that produced the report.",
  ];
  if (input.generatedTest) {
    setup.push(`Use generated repro test \`${input.generatedTest.path}\`.`);
  }

  const action = input.command
    ? `Run \`${input.command}\` (${input.method}).`
    : "Replay the failing request or command that produced the stack trace.";
  const expectedFailure = `${input.symptoms.errorType ?? "Error"}: ${clip(input.symptoms.errorMessage, 160)}`;

  return { title, setup, action, expectedFailure };
}

export function proposeReproductionTest(input: {
  repoPath?: string;
  error: ParsedError;
  crashSite?: StackFrame;
  symptoms: ReproductionSymptom;
  tests: TestEvidence;
}): ProposedTest | undefined {
  const origin = input.crashSite;
  if (!origin?.file) return undefined;

  let sourceRel = origin.file.replace(/\\/g, "/");
  if (input.repoPath && path.isAbsolute(origin.file)) {
    sourceRel = path.relative(input.repoPath, origin.file).replace(/\\/g, "/");
  }
  if (!sourceRel || sourceRel.startsWith("..")) return undefined;

  const parsed = path.parse(sourceRel);
  const isDart = parsed.ext.toLowerCase() === ".dart" || input.error.language === "dart";
  const title = scenarioTitle(input.symptoms, origin);
  const reason = input.tests.relatedTests.length
    ? `Encode the reported failure around ${parsed.name} as a regression.`
    : `No related tests for ${sourceRel}; generate a reproduction test.`;

  if (isDart) {
    const snake = toSnake(parsed.name);
    const testPath = path.posix.join("test", `${snake}_test.dart`);
    if (input.tests.relatedTests.some((test) => normalize(test.file) === testPath)) return undefined;
    const loc = `${path.basename(origin.file)}${origin.line ? `:${origin.line}` : ""}`;
    const flutter = input.tests.runner === "flutter-test" || input.symptoms.signals.includes("flutter");
    const importLine = flutter
      ? "import 'package:flutter_test/flutter_test.dart';"
      : "import 'package:test/test.dart';";
    const content = `${importLine}

void main() {
  test(
    '${escapeDart(title)}',
    () async {
      // Reproduce original failure:
      // ${input.error.type ?? "Error"}: ${clip(input.error.message, 120)}
      // Crash site: ${loc}${origin.functionName ? ` (${origin.functionName})` : ""}
      //
      // Arrange a null/missing response, then exercise the same path.
      // Today this test reproduces the bug; after the fix it should pass.
    },
  );
}
`;
    return { path: testPath, content, reason, created: false };
  }

  const fn = origin.functionName?.replace(/[^A-Za-z0-9_$]/g, "") || "repro";
  const relDir = parsed.dir.replace(/\\/g, "/");
  const importPath = `./${parsed.name}${parsed.ext || ".js"}`;
  const testPath = path.posix.join(relDir || ".", `${parsed.name}.repro.test${parsed.ext || ".js"}`);
  if (input.tests.relatedTests.some((test) => normalize(test.file) === testPath)) return undefined;

  const invoke = input.symptoms.signals.includes("assertion-mismatch")
    ? `assert.equal(${fn}({ price: 10 }), 10);`
    : `assert.doesNotThrow(() => ${fn}({}));`;

  const content = `import assert from "node:assert/strict";
import { test } from "node:test";
import { ${fn} } from "${importPath}";

test("${escapeJs(title)}", () => {
  // Reproduce original failure: ${input.error.type ?? "Error"}: ${clip(input.error.message, 100)}
  ${invoke}
});
`;

  return { path: testPath, content, reason, created: false };
}

export function captureFailure(output: string, repoPath?: string): CapturedFailure | undefined {
  if (!output.trim()) return undefined;
  const parsed = parseErrorText(output, repoPath);
  const project = parsed.frames.find((frame) => frame.inProject) ?? parsed.frames[0];
  const message = parsed.message && parsed.message !== "Unknown error" ? parsed.message : firstErrorLine(output);
  if (!message && !parsed.type) {
    return { excerpt: clip(output, 400) };
  }
  return {
    type: parsed.type,
    message,
    file: project?.file,
    line: project?.line,
    excerpt: clip(output, 400),
  };
}

export function compareFailures(input: {
  reported: ParsedError;
  crashSite?: StackFrame;
  captured?: CapturedFailure;
  output: string;
  attempted: boolean;
  reproduced: boolean;
}): { match: ReproductionMatch; detail: string; confidence: number } {
  if (!input.attempted) {
    return { match: "not-run", detail: "Live reproduction was not executed.", confidence: 0.4 };
  }
  if (!input.reproduced) {
    return {
      match: "unmatched",
      detail: "Command succeeded; the reported failure did not recur.",
      confidence: 0.28,
    };
  }

  const output = input.output.toLowerCase();
  const reportedType = input.reported.type?.toLowerCase();
  const crashFile = input.crashSite?.file ? path.basename(input.crashSite.file).toLowerCase() : undefined;
  const fn = input.crashSite?.functionName?.toLowerCase();
  const capturedType = input.captured?.type?.toLowerCase();
  const capturedFile = input.captured?.file ? path.basename(input.captured.file).toLowerCase() : undefined;

  let score = 0;
  const hits: string[] = [];
  if (reportedType && (output.includes(reportedType.toLowerCase()) || capturedType === reportedType)) {
    score += 2;
    hits.push(input.reported.type ?? reportedType);
  }
  if (crashFile && (output.includes(crashFile) || capturedFile === crashFile)) {
    score += 2;
    hits.push(crashFile);
  }
  if (fn && output.includes(fn)) {
    score += 1;
    hits.push(fn);
  }
  const overlap = tokenOverlap(input.reported.message, `${input.captured?.message ?? ""} ${input.output}`);
  if (overlap >= 2) {
    score += 2;
    hits.push("message");
  } else if (overlap === 1) {
    score += 1;
  }
  if (/null check operator/i.test(input.reported.message) && /null check operator/i.test(input.output)) {
    score += 2;
    hits.push("null-check");
  }

  if (score >= 3) {
    return {
      match: "matched",
      detail: `Captured failure matches the report (${hits.slice(0, 3).join(", ")}).`,
      confidence: 0.92,
    };
  }
  if (score >= 1) {
    return {
      match: "partial",
      detail: "Tests failed, but the captured error only partly matches the report.",
      confidence: 0.68,
    };
  }
  return {
    match: "partial",
    detail: "A failure was captured, but it does not clearly match the reported error.",
    confidence: 0.55,
  };
}

export function scenarioTitle(symptoms: ReproductionSymptom, crashSite?: StackFrame): string {
  const stem = crashSite?.file ? path.parse(crashSite.file).name : crashSite?.functionName ?? "crash path";
  const unit = humanizeIdentifier(stem);
  if (symptoms.signals.includes("null-deref")) {
    return `should handle null ${unit} response`;
  }
  if (symptoms.signals.includes("assertion-mismatch")) {
    return `should keep ${unit} consistent with expected result`;
  }
  const fn = crashSite?.functionName ? humanizeIdentifier(crashSite.functionName) : unit;
  return `should reproduce ${symptoms.errorType ?? "error"} in ${fn}`;
}

function tokenOverlap(left: string, right: string): number {
  const a = tokens(left);
  const b = new Set(tokens(right));
  let n = 0;
  for (const token of a) {
    if (b.has(token)) n += 1;
  }
  return n;
}

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((token) => !STOP_WORDS.has(token));
}

function firstErrorLine(output: string): string | undefined {
  return output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /error|exception|fail|assert|null check/i.test(line));
}

function humanizeIdentifier(name: string): string {
  return name
    .replace(/\.(dart|js|ts|tsx|jsx)$/i, "")
    .replace(/(Bloc|Service|Page|Screen|Widget|Controller|ViewModel|Repository)$/u, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase() || "crash path";
}

function toSnake(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

function normalize(file: string): string {
  return file.replace(/\\/g, "/");
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function escapeJs(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeDart(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
