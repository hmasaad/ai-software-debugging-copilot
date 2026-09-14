import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { clamp } from "../exec.js";
import type { FileEdit, FixRisk, FixRiskLevel, FixStrategy, RelatedTest } from "../types.js";

export const FIX_RISK_RULE = "Prefer: smallest safe fix that resolves the problem.";
const DIVIDER = "─".repeat(16);

export function scoreFixRisk(input: {
  files: string[];
  tests: number;
  baseConfidence?: number;
  strategy?: FixStrategy;
}): FixRisk {
  const filePaths = unique(input.files.filter(Boolean).map(normalizePath));
  const files = filePaths.length;
  const modules = unique(filePaths.map(moduleOf)).length;
  const tests = Math.max(0, input.tests);
  const level = rankRisk({ files, modules, tests, strategy: input.strategy });
  const confidence = deriveConfidence({
    level,
    files,
    tests,
    base: input.baseConfidence,
  });
  return {
    label: "Fix",
    files,
    tests,
    modules,
    level,
    confidence,
    preferred: false,
    filePaths,
    reasons: riskReasons({ files, modules, tests, level, strategy: input.strategy }),
  };
}

export function preferSmallestSafeFix<T extends { risk: FixRisk; edits: FileEdit[] }>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => {
    const aHas = a.edits.length > 0 ? 1 : 0;
    const bHas = b.edits.length > 0 ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;
    const risk = riskRank(a.risk.level) - riskRank(b.risk.level);
    if (risk !== 0) return risk;
    if (a.risk.files !== b.risk.files) return a.risk.files - b.risk.files;
    if (a.risk.modules !== b.risk.modules) return a.risk.modules - b.risk.modules;
    return b.risk.confidence - a.risk.confidence;
  });
}

export function labelFixCandidates(risks: FixRisk[]): FixRisk[] {
  return risks.map((risk, index) => ({
    ...risk,
    label: `Fix ${String.fromCharCode(65 + index)}`,
    preferred: index === 0,
  }));
}

/**
 * Fix A
 * ────────────────
 * Change: 2 files
 * Tests: 18
 * Affected modules: 1
 * Risk: LOW
 * Confidence: 94%
 */
export function renderFixRiskAscii(candidates: FixRisk[]): string {
  if (!candidates.length) return FIX_RISK_RULE;
  const cards = candidates.map((fix) =>
    [
      fix.label,
      DIVIDER,
      `Change: ${fix.files} file${fix.files === 1 ? "" : "s"}`,
      `Tests: ${fix.tests}`,
      `Affected modules: ${fix.modules}`,
      `Risk: ${fix.level}`,
      `Confidence: ${Math.round(fix.confidence * 100)}%`,
    ].join("\n"),
  );
  return [cards.join("\n\n"), FIX_RISK_RULE].join("\n\n");
}

export function countAffectedTests(repoPath: string, files: string[], related: RelatedTest[] = []): number {
  const found = new Set<string>();
  for (const test of related) {
    if (test.file) found.add(normalizePath(test.file));
  }
  for (const file of files) {
    const relDir = path.dirname(normalizePath(file));
    const absDir = path.resolve(repoPath, relDir);
    if (!existsSync(absDir)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(absDir);
    } catch {
      continue;
    }
    const stem = path.parse(file).name;
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git") continue;
      const abs = path.join(absDir, entry);
      if (isTestFile(entry)) {
        found.add(normalizePath(path.join(relDir, entry)));
        continue;
      }
      if (entry === "__tests__" || entry === "test" || entry === "tests") {
        try {
          for (const nested of readdirSync(abs)) {
            if (isTestFile(nested) || nested.includes(stem)) {
              found.add(normalizePath(path.join(relDir, entry, nested)));
            }
          }
        } catch {
          /* ignore */
        }
      }
    }
  }
  return found.size;
}

export function sameEdits(left: FileEdit[], right: FileEdit[]): boolean {
  if (left.length !== right.length) return false;
  const key = (edit: FileEdit) => `${normalizePath(edit.path)}::${edit.newString}`;
  const rightKeys = new Set(right.map(key));
  return left.every((edit) => rightKeys.has(key(edit)));
}

function rankRisk(input: {
  files: number;
  modules: number;
  tests: number;
  strategy?: FixStrategy;
}): FixRiskLevel {
  if (input.files === 0) return "LOW";
  let score = 0;
  if (input.files >= 5) score += 0.45;
  else if (input.files >= 3) score += 0.25;
  else if (input.files >= 2) score += 0.1;
  if (input.modules >= 4) score += 0.4;
  else if (input.modules >= 2) score += 0.2;
  if (input.tests === 0) score += 0.15;
  if (input.strategy === "optional-chain" || input.strategy === "nullish-default") score -= 0.15;
  if (input.files >= 5 || input.modules >= 4 || score >= 0.55) return "HIGH";
  if (score < 0.35 && input.files <= 2 && input.modules <= 1) return "LOW";
  return "MEDIUM";
}

function deriveConfidence(input: { level: FixRiskLevel; files: number; tests: number; base?: number }): number {
  let confidence = input.base ?? 0.72;
  if (input.level === "LOW") confidence += 0.16;
  if (input.level === "HIGH") confidence -= 0.03;
  if (input.files <= 2) confidence += 0.04;
  if (input.tests >= 10) confidence += 0.02;
  if (input.tests === 0 && input.files > 0) confidence -= 0.08;
  return clamp(confidence, 0.05, 0.99);
}

function riskReasons(input: {
  files: number;
  modules: number;
  tests: number;
  level: FixRiskLevel;
  strategy?: FixStrategy;
}): string[] {
  const reasons: string[] = [];
  if (input.files <= 2 && input.modules <= 1) reasons.push("Smallest surface area.");
  if (input.strategy === "optional-chain" || input.strategy === "nullish-default") {
    reasons.push("Minimal guard at the crash site.");
  }
  if (input.files >= 5) reasons.push("Touches many files.");
  if (input.modules >= 4) reasons.push("Crosses several modules.");
  if (input.tests === 0 && input.files > 0) reasons.push("No covering tests found.");
  if (input.level === "HIGH") reasons.push("Do not apply to production without review.");
  return reasons;
}

function riskRank(level: FixRiskLevel): number {
  if (level === "LOW") return 0;
  if (level === "MEDIUM") return 1;
  return 2;
}

export function moduleOf(file: string): string {
  const dir = path.dirname(normalizePath(file));
  const parts = dir.split("/").filter((part) => part && part !== ".");
  const meaningful = parts.filter((part) => part !== "lib" && part !== "src" && part !== "app");
  return meaningful[meaningful.length - 1] ?? parts[parts.length - 1] ?? "root";
}

function isTestFile(name: string): boolean {
  return /\.(test|spec)\./.test(name) || name.startsWith("test_") || /_test\.(dart|py|js|ts)$/.test(name);
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
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
