import path from "node:path";
import type { BlastRadiusAnalysis, BlastRadiusNode, CodeCaller, CodeInvestigation } from "../types.js";

export function buildBlastRadius(input: {
  codeInvestigation?: CodeInvestigation;
  affectedFiles?: string[];
}): BlastRadiusAnalysis {
  const origin =
    input.codeInvestigation?.origin?.functionName ||
    (input.codeInvestigation?.origin?.file ? path.parse(input.codeInvestigation.origin.file).name : undefined) ||
    input.affectedFiles?.[0] ||
    "unknown";
  const callers = input.codeInvestigation?.callers ?? [];
  const extra = (input.affectedFiles ?? [])
    .filter((file) => file !== input.codeInvestigation?.origin?.file)
    .map((file) => ({ file, line: 0, text: path.basename(file) }) satisfies CodeCaller);

  const usedBy: BlastRadiusNode[] = [];
  const seen = new Set<string>();
  for (const caller of [...callers, ...extra]) {
    const name = displayName(caller);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    usedBy.push({
      name,
      kind: nodeKind(name, caller.file),
      impact: impactFor(name, caller.file),
    });
  }

  if (!usedBy.length && origin !== "unknown") {
    usedBy.push({ name: origin, kind: "symbol", impact: "high" });
  }

  const high = usedBy.filter((node) => node.impact === "high").map((node) => node.name);
  const low = usedBy.filter((node) => node.impact === "low").map((node) => node.name);
  return {
    origin,
    usedBy,
    high,
    low,
    summary: high.length
      ? `Potential blast radius of ${origin}: HIGH ${high.join(", ")}${low.length ? `; LOW ${low.join(", ")}` : ""}.`
      : `No additional consumers of ${origin} found.`,
  };
}

export function renderBlastRadiusAscii(analysis: BlastRadiusAnalysis): string {
  const used = analysis.usedBy.length
    ? analysis.usedBy.map((node, index) => ` ${index === analysis.usedBy.length - 1 ? "└" : "├"}── ${node.name}`).join("\n")
    : " └── (none)";
  const high = analysis.high.length ? analysis.high.map((name) => `├── ${name}`).join("\n") : "└── none";
  const low = analysis.low.length ? analysis.low.map((name) => `└── ${name}`).join("\n") : "└── none";
  return [
    "Potential blast radius:",
    "",
    `Bug`,
    ` ↓`,
    analysis.origin,
    ` ↓`,
    `Used by`,
    used,
    "",
    "HIGH",
    high.replace(/^├──/, analysis.high.length <= 1 ? "└──" : "├──"),
    "",
    "LOW",
    low,
  ].join("\n");
}

function displayName(caller: CodeCaller): string {
  const base = path.parse(caller.file).name;
  const fn = caller.text.match(/\b([A-Z][A-Za-z0-9]+(?:Bloc|Cubit|Screen|Page|View|Repository))\b/);
  return fn?.[1] ?? base;
}

function nodeKind(name: string, file: string): BlastRadiusNode["kind"] {
  if (/Bloc|Cubit/i.test(name) || /bloc/i.test(file)) return "bloc";
  if (/Screen|Page|View/i.test(name) || /screen|page/i.test(file)) return "screen";
  if (path.extname(file)) return "file";
  return "symbol";
}

function impactFor(name: string, file: string): "high" | "low" {
  const blob = `${name} ${file}`;
  if (/test|spec|mock|fixture|generated|media/i.test(blob)) return "low";
  return "high";
}
