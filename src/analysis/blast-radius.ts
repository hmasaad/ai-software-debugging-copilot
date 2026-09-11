import path from "node:path";
import type { BlastRadiusAnalysis, BlastRadiusNode, CodeCaller, CodeInvestigation } from "../types.js";

const QUESTION = "What else could this change break?";

export function buildBlastRadius(input: {
  codeInvestigation?: CodeInvestigation;
  affectedFiles?: string[];
}): BlastRadiusAnalysis {
  const originFile = input.codeInvestigation?.origin?.file;
  const origin =
    input.codeInvestigation?.origin?.functionName ||
    (originFile ? classNameFromFile(originFile) : undefined) ||
    (input.affectedFiles?.[0] ? classNameFromFile(input.affectedFiles[0]) : undefined) ||
    "unknown";

  const callers = collectCallers(input.codeInvestigation, input.affectedFiles, originFile);
  const usedBy: BlastRadiusNode[] = [];
  const seen = new Set<string>();
  for (const caller of callers) {
    const name = displayName(caller);
    if (!name || seen.has(name) || sameSymbol(name, origin)) continue;
    seen.add(name);
    const surface = featureSurface(name, caller.file, origin);
    usedBy.push({
      name,
      kind: nodeKind(name, caller.file),
      impact: impactFor(name, caller.file, origin),
      surface,
    });
  }

  if (!usedBy.length && origin !== "unknown") {
    usedBy.push({
      name: origin,
      kind: "symbol",
      impact: "high",
      surface: featureSurface(origin, originFile ?? origin, origin),
    });
  }

  const high = unique(usedBy.filter((node) => node.impact === "high").map((node) => node.surface));
  const low = unique(usedBy.filter((node) => node.impact === "low").map((node) => node.surface)).filter(
    (surface) => !high.includes(surface),
  );
  return {
    origin,
    usedBy,
    high,
    low,
    question: QUESTION,
    summary: high.length
      ? `${QUESTION} ${origin} is used by ${usedBy.map((node) => node.name).join(", ")}. HIGH: ${high.join(", ")}${low.length ? `; LOW: ${low.join(", ")}` : ""}.`
      : `No additional consumers of ${origin} found.`,
  };
}

export function renderBlastRadiusAscii(analysis: BlastRadiusAnalysis): string {
  const consumers = analysis.usedBy.filter((node) => node.kind === "bloc" || node.kind === "symbol");
  const used = (consumers.length ? consumers : analysis.usedBy).map((node) => node.name);
  return [
    analysis.question,
    "",
    "Bug",
    " ↓",
    analysis.origin,
    " ↓",
    "Used by",
    tree(used, " "),
    "",
    "Potential blast radius:",
    "",
    "HIGH",
    tree(analysis.high),
    "",
    "LOW",
    tree(analysis.low),
  ].join("\n");
}

function collectCallers(
  code: CodeInvestigation | undefined,
  affectedFiles: string[] | undefined,
  originFile?: string,
): CodeCaller[] {
  const extra = (affectedFiles ?? [])
    .filter((file) => file !== originFile)
    .map((file) => ({ file, line: 0, text: path.basename(file) }) satisfies CodeCaller);
  const fromFunctions = (code?.functions ?? [])
    .filter((fn) => fn.file !== originFile)
    .map((fn) => ({ file: fn.file, line: fn.startLine, text: fn.name }) satisfies CodeCaller);
  return [...(code?.callers ?? []), ...fromFunctions, ...extra];
}

function tree(items: string[], indent = ""): string {
  if (!items.length) return `${indent}└── none`;
  return items
    .map((item, index) => `${indent}${index === items.length - 1 ? "└──" : "├──"} ${item}`)
    .join("\n");
}

function displayName(caller: CodeCaller): string {
  const fromText =
    caller.text.match(/\b([A-Z][A-Za-z0-9]+(?:Bloc|Cubit|Screen|Page|View|Repository|Service))\b/)?.[1];
  if (fromText) return fromText;
  return classNameFromFile(caller.file);
}

function classNameFromFile(file: string): string {
  const base = path.parse(file).name;
  return base
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function nodeKind(name: string, file: string): BlastRadiusNode["kind"] {
  if (/Bloc|Cubit/i.test(name) || /bloc/i.test(file)) return "bloc";
  if (/Screen|Page|View/i.test(name) || /screen|page/i.test(file)) return "screen";
  if (path.extname(file)) return "file";
  return "symbol";
}

function impactFor(name: string, file: string, origin: string): "high" | "low" {
  const blob = `${name} ${file}`.toLowerCase();
  if (/test|spec|mock|fixture|generated/i.test(blob)) return "low";
  if (/media|gallery|camera|photo/i.test(blob)) return "low";
  const domain = domainOf(origin);
  if (domain && blob.includes(domain)) return "high";
  if (/report|shareout|payout|calculation|bloc|cubit/i.test(blob)) return "high";
  return "high";
}

function featureSurface(name: string, file: string, origin: string): string {
  const blob = `${name} ${file}`.toLowerCase();
  const domain = domainOf(origin);
  if (/shareout|payout/.test(blob) || /calculation/i.test(name)) return "Shareout calculation";
  if (/report/.test(blob)) return domain && domain !== "report" ? `${title(domain)} reports` : "Reports";
  if (/media|gallery|camera|photo/.test(blob)) return "Media screen";
  if (/Bloc|Cubit/.test(name)) {
    const feature = name.replace(/(Bloc|Cubit)$/i, "");
    if (domain && feature.toLowerCase().startsWith(domain)) return `${title(domain)} screen`;
    return `${splitCamel(feature)} screen`;
  }
  if (/Screen|Page|View/.test(name)) {
    return `${splitCamel(name.replace(/(Screen|Page|View)$/i, ""))} ${name.endsWith("Page") ? "page" : "screen"}`.toLowerCase().replace(/^\w/, (ch) => ch.toUpperCase());
  }
  if (domain && name.toLowerCase().includes(domain)) return `${title(domain)} screen`;
  return splitCamel(name);
}

function domainOf(origin: string): string | undefined {
  const stripped = origin.replace(/(Repository|Service|Client|Store|Bloc|Cubit|Screen|Page)$/i, "");
  if (!stripped || stripped.length > 24) return undefined;
  return stripped.toLowerCase();
}

function sameSymbol(name: string, origin: string): boolean {
  return name.toLowerCase() === origin.toLowerCase();
}

function splitCamel(name: string): string {
  const spaced = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return spaced || name;
}

function title(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function unique(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}
