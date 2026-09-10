import { clamp } from "../exec.js";
import type {
  AgentId,
  FailureCategory,
  FailureClassification,
  FailureFamily,
  LogAnalysis,
  ParsedError,
} from "../types.js";

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
  const language = input.error?.language ?? input.logAnalysis?.error.language;
  const blob = [type, message, stack, input.extraContext ?? "", input.logAnalysis?.logs.excerpt ?? ""].join("\n");

  const signals: string[] = [];
  let family: FailureFamily = "logic";
  let category: FailureCategory = "runtime-crash";
  let subtype: string | undefined;
  let confidence = 0.55;

  if (match(blob, /gradle|cocoapods|\bpod install\b|xcodebuild|xcode |FAILURE: Build|pub get failed|Could not resolve/i, signals, "build-tool")) {
    family = "build";
    category = "build-failure";
    subtype = /cocoapods|\bpod /i.test(blob) ? "CocoaPods" : /xcode/i.test(blob) ? "Xcode" : "Gradle";
    confidence = 0.9;
  } else if (match(blob, /cannot find module|MODULE_NOT_FOUND|version mismatch|peer dep|lockfile|pubspec.yaml|Podfile.lock/i, signals, "dependency")) {
    family = "dependency";
    category = "dependency-issue";
    confidence = 0.88;
  } else if (match(blob, /sql(ite)?|postgres|mysql|mongodb|drift\b|database|constraint failed|unique index/i, signals, "database")) {
    family = "runtime";
    category = "database-issue";
    confidence = 0.82;
  } else if (match(blob, /\bdio\b|socketexception|econnrefused|enotfound|http[s]?:\/\/|status code|timeout|xmlhttprequest|\bapi\b|firebase/i, signals, "network")) {
    family = "runtime";
    category = "api-backend-issue";
    confidence = 0.8;
  } else if (match(blob, /\bbloc\b|\bcubit\b|riverpod|provider|setState|wrong state|emit\(/i, signals, "state")) {
    family = "logic";
    category = "state-management-issue";
    subtype = "Wrong state";
    confidence = 0.78;
  } else if (match(blob, /renderflex|overflowed|widget|BuildContext|Scaffold|ui issue/i, signals, "ui")) {
    family = "logic";
    category = "ui-issue";
    confidence = 0.72;
  } else if (match(blob, /\brace\b|deadlock|mutex|isolate|concurrent modification|thread/i, signals, "concurrency")) {
    family = "logic";
    category = "concurrency-race";
    subtype = "Race condition";
    confidence = 0.76;
  } else if (match(blob, /\banr\b|application not responding|jank|skipped \d+ frames|performance/i, signals, "performance")) {
    family = "runtime";
    category = "performance-issue";
    subtype = /anr/i.test(blob) ? "ANR" : "Performance";
    confidence = 0.74;
  } else if (match(blob, /xss|injection|csrf|unauthori[sz]ed|secret|token leak|security/i, signals, "security")) {
    family = "other";
    category = "security-issue";
    confidence = 0.7;
  } else if (match(blob, /\bflavor\b|NODE_ENV|environment|config(uration)?|works on my machine/i, signals, "environment")) {
    family = "other";
    category = "configuration-environment";
    confidence = 0.68;
  } else if (
    match(
      blob,
      /null check operator|Null check operator|Cannot read propert(?:y|ies) of (undefined|null)|NullPointer|NullSafety|used on a null value/i,
      signals,
      "null-crash",
    )
  ) {
    family = "runtime";
    category = "runtime-crash";
    subtype = "Null Crash";
    confidence = 0.9;
  } else if (match(blob, /TypeError|ReferenceError|Fatal|Unhandled Exception|segfault|crash/i, signals, "crash")) {
    family = "runtime";
    category = "runtime-crash";
    subtype = "Crash";
    confidence = 0.84;
  } else if (match(blob, /AssertionError|Expected .+ to equal|wrong calculation|NaN/i, signals, "assertion")) {
    family = "logic";
    category = "runtime-crash";
    subtype = "Wrong calculation";
    confidence = 0.8;
  }

  if (language === "dart" && category === "runtime-crash") signals.push("dart");
  if (language === "dart" && (category === "ui-issue" || category === "state-management-issue")) {
    confidence = clamp(confidence + 0.05, 0.05, 0.95);
  }

  const routedAgents = routeAgents(family, category, language);
  const summary = [
    familyLabel(family),
    categoryLabel(category),
    subtype,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    family,
    category,
    subtype,
    confidence: clamp(confidence, 0.05, 0.95),
    signals,
    routedAgents,
    summary,
  };
}

export function renderClassificationAscii(classification: FailureClassification): string {
  const families: FailureFamily[] = ["runtime", "build", "logic"];
  const marks = families.map((family) => (family === classification.family ? "●" : "○"));
  return [
    "Failure classification",
    "",
    `                 Bug`,
    `                  │`,
    `     ┌────────────┼────────────┐`,
    `     ${marks[0]}            ${marks[1]}            ${marks[2]}`,
    ` Runtime       Build        Logic`,
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
    (category === "build-failure" && family === "build")
  ) {
    agents.add("flutter-agent");
  }
  if (category === "concurrency-race") agents.add("crash-agent");
  return [...agents];
}

function match(blob: string, pattern: RegExp, signals: string[], label: string): boolean {
  if (!pattern.test(blob)) return false;
  signals.push(label);
  return true;
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

function categoryLabel(category: FailureCategory): string {
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
  }
}
