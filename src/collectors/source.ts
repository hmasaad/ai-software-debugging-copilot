import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { tryCommand } from "../exec.js";
import type { SourceSnippet, StackFrame } from "../types.js";

const CONTEXT_LINES = 18;
const MAX_SNIPPETS = 8;

export async function collectSourceSnippets(
  repoPath: string,
  frames: StackFrame[],
): Promise<SourceSnippet[]> {
  const snippets: SourceSnippet[] = [];
  const seen = new Set<string>();

  const ordered = [
    ...frames.filter((frame) => frame.inProject),
    ...frames.filter((frame) => !frame.inProject),
  ];

  for (const frame of ordered) {
    if (snippets.length >= MAX_SNIPPETS) break;
    let resolved = resolveSourcePath(repoPath, frame.file);
    if (!resolved || !existsSync(resolved)) {
      resolved = await resolveExistingSource(repoPath, frame.file);
    }
    if (!resolved || !existsSync(resolved)) continue;

    const key = `${resolved}:${frame.line ?? 0}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const snippet = await readSnippet(repoPath, resolved, frame.line);
    if (snippet) snippets.push(snippet);
  }

  return snippets;
}

export function resolveSourcePath(repoPath: string, file: string): string | undefined {
  if (!file) return undefined;
  const stripped = file.replace(/^file:\/\//, "");
  if (path.isAbsolute(stripped)) {
    return stripped.startsWith(repoPath) ? stripped : undefined;
  }
  const candidate = path.resolve(repoPath, stripped);
  if (existsSync(candidate)) return candidate;
  return undefined;
}

export async function resolveExistingSource(repoPath: string, file: string): Promise<string | undefined> {
  const direct = resolveSourcePath(repoPath, file);
  if (direct && existsSync(direct)) return direct;
  const base = path.basename(file);
  const listed = await tryCommand("git", ["--no-pager", "ls-files", `*${base}`], {
    cwd: repoPath,
    timeoutMs: 8_000,
    env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
  });
  if (!listed || listed.code !== 0) return undefined;
  const match = listed.stdout.split("\n").map((line) => line.trim()).find(Boolean);
  return match ? path.join(repoPath, match) : undefined;
}

async function readSnippet(repoPath: string, absPath: string, focusLine?: number): Promise<SourceSnippet | undefined> {
  try {
    const raw = await readFile(absPath, "utf8");
    const lines = raw.split("\n");
    const focus = focusLine && focusLine > 0 ? focusLine : 1;
    const start = Math.max(1, focus - CONTEXT_LINES);
    const end = Math.min(lines.length, focus + CONTEXT_LINES);
    const numbered = lines.slice(start - 1, end).map((line, index) => {
      const n = start + index;
      const mark = n === focus ? ">" : " ";
      return `${mark}${String(n).padStart(4, " ")} | ${line}`;
    });

    return {
      file: path.relative(repoPath, absPath) || absPath,
      startLine: start,
      endLine: end,
      focusLine: focusLine,
      content: numbered.join("\n"),
      language: extLanguage(absPath),
    };
  } catch {
    return undefined;
  }
}

function extLanguage(file: string): string | undefined {
  const ext = path.extname(file).slice(1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    go: "go",
    java: "java",
    rs: "rust",
    dart: "dart",
  };
  return map[ext];
}
