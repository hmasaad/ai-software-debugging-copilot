import { clamp } from "../exec.js";
import type {
  AgentId,
  FailureCategory,
  FailureClassification,
  FailureFamily,
  LogAnalysis,
  ParsedError,
} from "../types.js";

interface ClassifyRule {
  test: RegExp;
  family: FailureFamily;
  category: FailureCategory;
  subtype?: string | ((blob: string) => string);
  confidence: number;
  signal: string;
}

const RULES: ClassifyRule[] = [
  {
    test: /gradle|cocoapods|\bpod install\b|xcodebuild|xcode |FAILURE: Build|pub get failed|Could not resolve/i,
    family: "build",
    category: "build-failure",
    subtype: (blob) => (/cocoapods|\bpod /i.test(blob) ? "CocoaPods" : /xcode/i.test(blob) ? "Xcode" : "Gradle"),
    confidence: 0.9,
    signal: "build-tool",
  },
  {
    test: /cannot find module|MODULE_NOT_FOUND|version mismatch|peer dep|lockfile|pubspec.yaml|Podfile.lock/i,
    family: "dependency",
    category: "dependency-issue",
    confidence: 0.88,
    signal: "dependency",
  },
  {
    test: /sql(ite)?|postgres|mysql|mongodb|drift\b|database|constraint failed|unique index/i,
    family: "runtime",
    category: "database-issue",
    confidence: 0.82,
    signal: "database",
  },
  {
    test: /\banr\b|application not responding|nativePollOnce/i,
    family: "runtime",
    category: "performance-issue",
    subtype: "ANR",
    confidence: 0.88,
    signal: "anr",
  },
  {
    test: /dioexception|\bdio\b|socketexception|econnrefused|enotfound|http[s]?:\/\/|status code|xmlhttprequest|\bapi\b|firebase/i,
    family: "runtime",
    category: "api-backend-issue",
    confidence: 0.8,
    signal: "network",
  },
  {
    test: /jank|skipped \d+ frames|slow frame|performance/i,
    family: "runtime",
    category: "performance-issue",
    confidence: 0.74,
    signal: "performance",
  },
  {
    test: /\bbloc\b|\bcubit\b|riverpod|provider|setState|wrong state|emit\(/i,
    family: "logic",
    category: "state-management-issue",
    subtype: "Wrong state",
    confidence: 0.78,
    signal: "state",
  },
  {
    test: /renderflex|overflowed|widget|BuildContext|Scaffold|ui issue/i,
    family: "logic",
    category: "ui-issue",
    confidence: 0.72,
    signal: "ui",
  },
  {
    test: /\brace\b|deadlock|mutex|isolate|concurrent modification|thread/i,
    family: "logic",
    category: "concurrency-race",
    subtype: "Race condition",
    confidence: 0.76,
    signal: "concurrency",
  },
  {
    test: /AssertionError|Expected .+ to equal|wrong calculation|\bNaN\b/i,
    family: "logic",
    category: "logic-error",
    subtype: "Wrong calculation",
    confidence: 0.8,
    signal: "assertion",
  },
  {
    test: /xss|injection|csrf|unauthori[sz]ed|secret|token leak|security/i,
    family: "other",
    category: "security-issue",
    confidence: 0.7,
    signal: "security",
  },
  {
    test: /\bflavor\b|NODE_ENV|environment|config(uration)?|works on my machine/i,
    family: "other",
    category: "configuration-environment",
    confidence: 0.68,
    signal: "environment",
  },
  {
    test: /null check operator|Cannot read propert(?:y|ies) of (undefined|null)|NullPointer|NullSafety|used on a null value/i,
    family: "runtime",
    category: "runtime-crash",
    subtype: "Null Crash",
    confidence: 0.9,
    signal: "null-crash",
  },
  {
    test: /TypeError|ReferenceError|Fatal|Unhandled Exception|segfault|crash/i,
    family: "runtime",
    category: "runtime-crash",
    subtype: "Crash",
    confidence: 0.84,
    signal: "crash",
  },
];

export function classifyFailure(input: {
  error?: ParsedError;
  logAnalysis?: LogAnalysis;
  message?: string;
  stackTrace?: string;
  extraContext?: string;
}): FailureClassification {
  const type = input.error?.type ?? input.logAnalysis?.error.type ?? "";
  const message = input.error?.message ?? input.logAnalysis?.error.message ?? input.message ?? "";
  const stack = input.error?.stackTrace ?? input.stackTrace ?? "";
  const language =
    input.error?.language ??
    input.logAnalysis?.error.language ??
    inferLanguage(`${type}\n${message}\n${stack}\n${input.extraContext ?? ""}`);
  const blob = [type, message, stack, input.extraContext ?? "", input.logAnalysis?.logs.excerpt ?? ""].join("\n");

  const signals: string[] = [];
  let family: FailureFamily = "runtime";
  let category: FailureCategory = "runtime-crash";
  let subtype: string | undefined;
  let confidence = 0.55;

  const rule = RULES.find((item) => item.test.test(blob));
  if (rule) {
    signals.push(rule.signal);
    family = rule.family;
    category = rule.category;
    subtype = typeof rule.subtype === "function" ? rule.subtype(blob) : rule.subtype;
    confidence = rule.confidence;
  }

  if (language === "dart") {
    signals.push("dart");
    if (category === "ui-issue" || category === "state-management-issue") {
      confidence = clamp(confidence + 0.05, 0.05, 0.95);
    }
  }

  const routedAgents = routeAgents(family, category, language, blob);
  return {
    family,
    category,
    subtype,
    confidence: clamp(confidence, 0.05, 0.95),
    signals,
    routedAgents,
    summary: [familyLabel(family), categoryLabel(category), subtype].filter(Boolean).join(" · "),
  };
}

export function renderClassificationAscii(classification: FailureClassification): string {
  const selected = classification.family;
  const mark = (family: FailureFamily) => (selected === family ? "●" : "○");
  const leaf = (family: FailureFamily, name: string) => {
    const active = selected === family && (classification.subtype === name || (!classification.subtype && name === familyLeafFallback(classification)));
    return `${active ? "▶ " : "  "}${name}`;
  };

  return [
    "                 Bug",
    "                  │",
    "     ┌────────────┼────────────┐",
    "     ↓            ↓            ↓",
    `    ${mark("runtime")}            ${mark("build")}            ${mark("logic")}`,
    " Runtime       Build        Logic",
    "     │            │            │",
    "     ↓            ↓            ↓",
    padRow(leaf("runtime", "Null Crash"), leaf("build", "Gradle"), leaf("logic", "Wrong state")),
    padRow(leaf("runtime", "Crash"), leaf("build", "CocoaPods"), leaf("logic", "Wrong calculation")),
    padRow(leaf("runtime", "ANR"), leaf("build", "Xcode"), leaf("logic", "Race condition")),
    "",
    `Category: ${categoryLabel(classification.category)}`,
    classification.subtype ? `Subtype: ${classification.subtype}` : "",
    `Confidence: ${Math.round(classification.confidence * 100)}%`,
    `Route: ${classification.routedAgents.join(", ") || "core agents"}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function routeAgents(
  family: FailureFamily,
  category: FailureCategory,
  language?: ParsedError["language"],
  blob = "",
): AgentId[] {
  const agents = new Set<AgentId>(["code-investigator"]);
  if (family === "runtime" || category === "runtime-crash" || category === "performance-issue") {
    agents.add("crash-agent");
  }
  if (category === "api-backend-issue") agents.add("network-agent");
  if (category === "database-issue") agents.add("database-agent");
  if (category === "dependency-issue" || category === "build-failure") agents.add("dependency-analyst");
  if (
    language === "dart" ||
    category === "ui-issue" ||
    category === "state-management-issue" ||
    category === "build-failure" ||
    (language !== "javascript" &&
      language !== "python" &&
      /dioexception|\bdio\b|\bbloc\b|\bcubit\b|\bdrift\b|MethodChannel|flutter/i.test(blob))
  ) {
    agents.add("flutter-agent");
  }
  if (category === "concurrency-race") agents.add("crash-agent");
  return [...agents];
}

export function categoryLabel(category: FailureCategory): string {
  switch (category) {
    case "runtime-crash":
      return "Runtime crash";
    case "build-failure":
      return "Build failure";
    case "dependency-issue":
      return "Dependency issue";
    case "api-backend-issue":
      return "API/backend issue";
    case "database-issue":
      return "Database issue";
    case "ui-issue":
      return "UI issue";
    case "state-management-issue":
      return "State-management issue";
    case "performance-issue":
      return "Performance issue";
    case "concurrency-race":
      return "Concurrency/race condition";
    case "configuration-environment":
      return "Configuration/environment issue";
    case "security-issue":
      return "Security issue";
    case "logic-error":
      return "Logic error";
  }
}

function familyLabel(family: FailureFamily): string {
  switch (family) {
    case "runtime":
      return "Runtime";
    case "build":
      return "Build";
    case "logic":
      return "Logic";
    case "dependency":
      return "Dependency";
    default:
      return "Other";
  }
}

function inferLanguage(blob: string): ParsedError["language"] | undefined {
  if (/\.dart\b/i.test(blob) || /\bflutter\b/i.test(blob)) return "dart";
  if (/\.(jsx?|tsx?|mjs|cjs)\b/i.test(blob)) return "javascript";
  if (/\.py\b/i.test(blob)) return "python";
  return undefined;
}

function familyLeafFallback(classification: FailureClassification): string {
  if (classification.family === "build") return "Gradle";
  if (classification.family === "logic") return "Wrong state";
  return "Crash";
}

function padRow(a: string, b: string, c: string): string {
  return `${a.padEnd(16)}${b.padEnd(14)}${c}`;
}
