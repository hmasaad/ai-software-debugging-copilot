import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type {
  DebuggingMemory,
  FailureCategory,
  IncidentMemoryEntry,
} from "../types.js";

const MEMORY_DIR = ".debug-copilot";
const MEMORY_FILE = "memory.json";

export function memoryPath(repoPath: string): string {
  return path.join(repoPath, MEMORY_DIR, MEMORY_FILE);
}

export async function loadMemory(repoPath: string): Promise<IncidentMemoryEntry[]> {
  const file = memoryPath(repoPath);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { incidents?: IncidentMemoryEntry[] };
    return parsed.incidents ?? [];
  } catch {
    return [];
  }
}

export async function recallIncidents(input: {
  repoPath: string;
  errorType?: string;
  errorMessage: string;
  category?: FailureCategory;
  files?: string[];
}): Promise<DebuggingMemory> {
  const incidents = await loadMemory(input.repoPath);
  const matches = incidents
    .map((entry) => ({ entry, score: similarity(input, entry) }))
    .filter((match) => match.score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const count = matches.length;
  return {
    stored: false,
    matches,
    summary: count
      ? `${count} previous incident${count === 1 ? "" : "s"} had the same pattern`
      : "No similar historical incidents.",
  };
}

export async function rememberIncident(input: {
  repoPath: string;
  errorType?: string;
  errorMessage: string;
  category: FailureCategory;
  rootCause: string;
  fix: string;
  resolution: string;
  files?: string[];
}): Promise<DebuggingMemory> {
  const previous = await recallIncidents(input);
  const incidents = await loadMemory(input.repoPath);
  const entry: IncidentMemoryEntry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    errorType: input.errorType,
    errorMessage: input.errorMessage.replace(/\s+/g, " ").trim().slice(0, 240),
    category: input.category,
    rootCause: input.rootCause.slice(0, 400),
    fix: input.fix.slice(0, 400),
    resolution: input.resolution.slice(0, 240),
    files: (input.files ?? []).slice(0, 8),
  };
  incidents.unshift(entry);
  const dir = path.join(input.repoPath, MEMORY_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, MEMORY_FILE), JSON.stringify({ incidents: incidents.slice(0, 100) }, null, 2), "utf8");
  return {
    stored: true,
    matches: previous.matches,
    summary: previous.matches.length
      ? `${previous.matches.length} previous incident${previous.matches.length === 1 ? "" : "s"} had the same pattern`
      : "Stored as knowledge for later incidents.",
  };
}

export function renderMemoryAscii(memory: DebuggingMemory): string {
  const lines = ["Debugging memory", "", memory.summary];
  for (const match of memory.matches.slice(0, 3)) {
    lines.push(`- ${match.entry.errorType ?? "Error"}: ${match.entry.rootCause} (${Math.round(match.score * 100)}%)`);
  }
  return lines.join("\n");
}

function similarity(
  input: { errorType?: string; errorMessage: string; category?: FailureCategory; files?: string[] },
  entry: IncidentMemoryEntry,
): number {
  let score = 0;
  if (input.errorType && entry.errorType && input.errorType === entry.errorType) score += 0.3;
  if (input.category && input.category === entry.category) score += 0.25;
  const a = tokenize(input.errorMessage);
  const b = new Set(tokenize(entry.errorMessage));
  const overlap = a.filter((token) => b.has(token)).length;
  const denom = Math.max(1, Math.min(a.length, 8));
  score += Math.min(0.4, overlap / denom);
  const files = new Set((input.files ?? []).map((file) => path.basename(file)));
  if ([...files].some((file) => entry.files.some((known) => path.basename(known) === file))) score += 0.15;
  return Math.min(1, score);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 3);
}
