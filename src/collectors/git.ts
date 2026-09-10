import path from "node:path";
import { tryCommand } from "../exec.js";
import type { GitBlameLine, GitCommit, GitEvidence, StackFrame } from "../types.js";

export async function collectGitEvidence(
  repoPath: string,
  frames: StackFrame[],
): Promise<GitEvidence> {
  const topLevel = await tryCommand("git", ["rev-parse", "--show-toplevel"], { cwd: repoPath, timeoutMs: 8_000 });
  if (!topLevel || topLevel.code !== 0) {
    return { available: false, recentCommits: [], commitsTouchingSuspects: [], blame: [] };
  }

  const root = topLevel.stdout.trim() || repoPath;
  const scope = gitScopePath(root, repoPath);
  const [branch, head, status, recent] = await Promise.all([
    tryCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, timeoutMs: 8_000 }),
    tryCommand("git", ["rev-parse", "--short", "HEAD"], { cwd: root, timeoutMs: 8_000 }),
    tryCommand("git", ["status", "--short", "--", scope ?? "."], { cwd: root, timeoutMs: 8_000 }),
    collectRecentCommits(root, scope),
  ]);

  const suspectFiles = uniqueProjectFiles(root, repoPath, frames);
  const [commitsTouchingSuspects, blame] = await Promise.all([
    collectCommitsForFiles(root, suspectFiles),
    collectBlame(root, repoPath, frames),
  ]);

  return {
    available: true,
    branch: branch?.stdout.trim(),
    head: head?.stdout.trim(),
    status: status?.stdout.trim() || undefined,
    recentCommits: recent,
    commitsTouchingSuspects,
    blame,
  };
}

async function collectRecentCommits(cwd: string, scope?: string): Promise<GitCommit[]> {
  const result = await tryCommand(
    "git",
    ["log", "-15", "--format=%H%x09%an%x09%ad%x09%s", "--date=short", "--", scope ?? "."],
    { cwd, timeoutMs: 10_000 },
  );
  if (!result || result.code !== 0) return [];
  return parseCommitLines(result.stdout);
}

async function collectCommitsForFiles(cwd: string, files: string[]): Promise<GitCommit[]> {
  if (files.length === 0) return [];
  const result = await tryCommand(
    "git",
    ["log", "-12", "--format=%H%x09%an%x09%ad%x09%s", "--date=short", "--", ...files.slice(0, 8)],
    { cwd, timeoutMs: 10_000 },
  );
  if (!result || result.code !== 0) return [];
  return parseCommitLines(result.stdout);
}

async function collectBlame(cwd: string, repoPath: string, frames: StackFrame[]): Promise<GitBlameLine[]> {
  const blame: GitBlameLine[] = [];
  const projectFrames = frames.filter((frame) => frame.inProject && frame.line).slice(0, 5);

  for (const frame of projectFrames) {
    const rel = toGitRelative(cwd, repoPath, frame.file);
    if (!rel || !frame.line) continue;
    const result = await tryCommand(
      "git",
      ["blame", "-L", `${frame.line},${frame.line}`, "--porcelain", "--", rel],
      { cwd, timeoutMs: 8_000 },
    );
    if (!result || result.code !== 0) continue;
    const parsed = parsePorcelainBlame(rel, frame.line, result.stdout);
    if (parsed) blame.push(parsed);
  }

  return blame;
}

function parseCommitLines(stdout: string): GitCommit[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, author, date, ...subject] = line.split("\t");
      return {
        sha: sha ?? "",
        author: author ?? "",
        date: date ?? "",
        subject: subject.join("\t"),
      };
    })
    .filter((commit) => commit.sha);
}

function parsePorcelainBlame(file: string, line: number, stdout: string): GitBlameLine | undefined {
  const lines = stdout.split("\n");
  const header = lines[0]?.split(" ") ?? [];
  const sha = header[0];
  if (!sha) return undefined;

  const author = field(lines, "author") ?? "unknown";
  const date = field(lines, "author-time");
  const summary = field(lines, "summary") ?? "";
  const iso = date ? new Date(Number(date) * 1000).toISOString().slice(0, 10) : "";

  return { file, line, sha: sha.slice(0, 12), author, date: iso, summary };
}

function field(lines: string[], name: string): string | undefined {
  const prefix = `${name} `;
  const match = lines.find((line) => line.startsWith(prefix));
  return match?.slice(prefix.length);
}

function uniqueProjectFiles(gitRoot: string, repoPath: string, frames: StackFrame[]): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const frame of frames) {
    if (!frame.inProject) continue;
    const rel = toGitRelative(gitRoot, repoPath, frame.file);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    files.push(rel);
  }
  return files;
}

function toGitRelative(gitRoot: string, repoPath: string, file: string): string | undefined {
  if (!file) return undefined;
  const abs = path.isAbsolute(file) ? file : path.resolve(repoPath, file);
  const root = path.resolve(gitRoot);
  if (abs !== root && !abs.startsWith(root + path.sep)) return undefined;
  return path.relative(root, abs);
}

function gitScopePath(gitRoot: string, repoPath: string): string | undefined {
  const rel = path.relative(path.resolve(gitRoot), path.resolve(repoPath));
  if (!rel || rel === "." || rel.startsWith("..")) return undefined;
  return rel;
}
