import path from "node:path";
import { clamp } from "../exec.js";
import type {
  BlastRadiusAnalysis,
  BlastRadiusLayer,
  BlastRadiusNode,
  BlastRadiusSeverity,
  CodeCaller,
  CodeInvestigation,
} from "../types.js";

const QUESTION = "What else could this affect?";

export const BLAST_RADIUS_FLOW = [
  "Changed function",
  "      ↓",
  "Call graph",
  "      ↓",
  "Modules",
  "      ↓",
  "Features",
  "      ↓",
  "APIs",
  "      ↓",
  "Database",
  "      ↓",
  "Users",
].join("\n");

export function buildBlastRadius(input: {
  codeInvestigation?: CodeInvestigation;
  affectedFiles?: string[];
  changedFiles?: string[];
  affectedUsers?: number;
}): BlastRadiusAnalysis {
  const originFile = input.codeInvestigation?.origin?.file;
  const origin =
    input.codeInvestigation?.origin?.functionName ||
    (originFile ? classNameFromFile(originFile) : undefined) ||
    (input.affectedFiles?.[0] ? classNameFromFile(input.affectedFiles[0]) : undefined) ||
    "unknown";
  const domain = domainOf(origin);

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

  const primary = domain ? `${title(domain)} screen` : undefined;
  const direct: string[] = [];
  const indirect: string[] = [];
  const low: string[] = [];
  const seenSurface = new Set<string>();
  for (const node of usedBy) {
    if (!node.surface || seenSurface.has(node.surface)) continue;
    seenSurface.add(node.surface);
    if (node.impact === "low") {
      low.push(node.surface);
      continue;
    }
    if (primary && node.surface === primary) direct.push(node.surface);
    else if (!primary && !direct.length) direct.push(node.surface);
    else indirect.push(node.surface);
  }
  indirect.sort(compareIndirect);

  const high = unique([...direct, ...indirect]);
  const workflowShare = clamp(0.08 + 0.06 * (direct.length + indirect.length), 0.05, 0.95);
  const workflowLabel = domain ? `${title(domain)} workflows` : "affected workflows";
  const severity = rankSeverity(direct, indirect, workflowShare);
  const layers = buildLayers({
    origin,
    originFile,
    usedBy,
    callers,
    files: unique([
      originFile,
      ...(input.affectedFiles ?? []),
      ...(input.changedFiles ?? []),
      ...callers.map((caller) => caller.file),
    ]),
    functions: input.codeInvestigation?.functions?.map((fn) => fn.name) ?? [],
    direct,
    indirect,
    workflowShare,
    workflowLabel,
    affectedUsers: input.affectedUsers,
  });

  return {
    origin,
    usedBy,
    high,
    low,
    direct,
    indirect,
    severity,
    workflowShare,
    workflowLabel,
    layers,
    question: QUESTION,
    summary: `${QUESTION} Blast Radius: ${severity}. Direct: ${direct.join(", ") || "none"}. Indirect: ${indirect.join(", ") || "none"}. ~${pct(workflowShare)} of ${workflowLabel}.`,
  };
}

export function renderBlastRadiusAscii(analysis?: BlastRadiusAnalysis): string {
  if (!analysis) return BLAST_RADIUS_FLOW;
  return [
    BLAST_RADIUS_FLOW,
    "",
    `Blast Radius: ${analysis.severity}`,
    "",
    "Direct:",
    ...bullet(analysis.direct),
    "",
    "Indirect:",
    ...bullet(analysis.indirect),
    "",
    "Potentially affected:",
    `~${pct(analysis.workflowShare)} of ${analysis.workflowLabel}`,
  ].join("\n");
}

function buildLayers(input: {
  origin: string;
  originFile?: string;
  usedBy: BlastRadiusNode[];
  callers: CodeCaller[];
  files: string[];
  functions: string[];
  direct: string[];
  indirect: string[];
  workflowShare: number;
  workflowLabel: string;
  affectedUsers?: number;
}): BlastRadiusLayer[] {
  const blob = `${input.origin} ${input.files.join(" ")} ${input.functions.join(" ")} ${input.callers.map((c) => c.text).join(" ")}`;
  const modules = unique(
    input.files
      .map(moduleName)
      .filter((name): name is string => Boolean(name)),
  );
  const apis = unique([
    ...input.usedBy.filter((node) => /api|client|http|dio|endpoint|graphql/i.test(`${node.name} ${node.kind}`)).map((node) => node.name),
    ...input.files.filter((file) => /api|client|http|dio|endpoint/i.test(file)).map(classNameFromFile),
    ...(/(repository|service|client|api)/i.test(input.origin) ? [`${input.origin.replace(/(Repository|Service)$/i, "")} API`.replace(/^ API$/, input.origin)] : []),
  ]);
  const database = unique([
    ...input.usedBy.filter((node) => /drift|dao|database|sqlite|hive|isar|prisma|table|store/i.test(node.name)).map((node) => node.name),
    ...input.files.filter((file) => /drift|dao|database|sqlite|hive|isar|prisma/i.test(file)).map(classNameFromFile),
    ...(/repository|dao|store|database/i.test(input.origin) || /drift|dao|database|sqlite/i.test(blob) ? [input.origin] : []),
  ]);
  const users = [
    `~${pct(input.workflowShare)} of ${input.workflowLabel}`,
    input.affectedUsers != null ? `${input.affectedUsers} affected users` : undefined,
  ].filter((item): item is string => Boolean(item));

  return [
    { id: "function", label: "Changed function", items: input.origin !== "unknown" ? [input.origin] : [] },
    { id: "call-graph", label: "Call graph", items: input.usedBy.map((node) => node.name) },
    { id: "modules", label: "Modules", items: modules },
    { id: "features", label: "Features", items: unique([...input.direct, ...input.indirect]) },
    { id: "apis", label: "APIs", items: apis },
    { id: "database", label: "Database", items: database },
    { id: "users", label: "Users", items: users },
  ];
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

function featureSurface(name: string, file: string, origin: string): string {
  const blob = `${name} ${file}`.toLowerCase();
  const domain = domainOf(origin);
  if (/media|gallery|camera|photo/.test(blob)) return "Media screen";
  if (/shareout|payout/.test(blob) || /calculation/i.test(name)) return "Shareout";
  if (/details|member/.test(blob)) return "Member details";
  if (/report/.test(blob)) return domain && domain !== "report" ? `${title(domain)} reports` : "Reports";
  if (/Bloc|Cubit/.test(name)) {
    const feature = name.replace(/(Bloc|Cubit)$/i, "");
    if (domain && feature.toLowerCase() === domain) return `${title(domain)} screen`;
    if (domain && feature.toLowerCase().startsWith(domain)) {
      const rest = feature.slice(domain.length);
      if (!rest) return `${title(domain)} screen`;
      if (/details/i.test(rest)) return "Member details";
      return `${title(domain)} ${splitCamel(rest).toLowerCase()}`;
    }
    return `${splitCamel(feature)} screen`;
  }
  if (/Screen|Page|View/.test(name)) {
    return `${splitCamel(name.replace(/(Screen|Page|View)$/i, ""))} ${name.endsWith("Page") ? "page" : "screen"}`
      .toLowerCase()
      .replace(/^\w/, (ch) => ch.toUpperCase());
  }
  if (domain && name.toLowerCase().includes(domain)) return `${title(domain)} screen`;
  return splitCamel(name);
}

function impactFor(name: string, file: string, origin: string): "high" | "low" {
  const blob = `${name} ${file}`.toLowerCase();
  if (/test|spec|mock|fixture|generated/i.test(blob)) return "low";
  if (/media|gallery|camera|photo/i.test(blob)) return "low";
  const domain = domainOf(origin);
  if (domain && blob.includes(domain)) return "high";
  if (/report|shareout|payout|calculation|bloc|cubit|member|details/i.test(blob)) return "high";
  return "high";
}

function rankSeverity(direct: string[], indirect: string[], share: number): BlastRadiusSeverity {
  const affected = direct.length + indirect.length;
  if (affected >= 3 || share >= 0.25 || (direct.length >= 1 && indirect.length >= 2)) return "HIGH";
  if (affected >= 1) return "MEDIUM";
  return "LOW";
}

function compareIndirect(a: string, b: string): number {
  return indirectRank(a) - indirectRank(b);
}

function indirectRank(surface: string): number {
  const text = surface.toLowerCase();
  if (text.includes("report")) return 0;
  if (text.includes("shareout") || text.includes("payout")) return 1;
  if (text.includes("member") || text.includes("detail")) return 2;
  return 3;
}

function moduleName(file?: string): string | undefined {
  if (!file) return undefined;
  const parts = file.replace(/\\/g, "/").split("/").filter((part) => part && part !== "." && part !== "lib" && part !== "src");
  const folder = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  if (!folder || /\.(dart|ts|js|kt|swift|java)$/i.test(folder)) return undefined;
  if (/^(test|tests|__tests__|generated|fixtures)$/.test(folder)) return undefined;
  return title(folder.replace(/[_-]+/g, " "));
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

function unique(items: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function bullet(items: string[]): string[] {
  return items.length ? items.map((item) => `- ${item}`) : ["- none"];
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}
