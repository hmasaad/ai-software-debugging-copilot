import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { tryCommand } from "../exec.js";
import type { GitBlameLine, GitCommit, GitEvidence, StackFrame } from "../types.js";

const gitPager = { GIT_PAGER: "cat", PAGER: "cat" };

function git(cwd: string, args: string[], timeoutMs = 8_000) {
  return tryCommand("git", ["--no-pager", ...args], {
    cwd,
    timeoutMs,
    env: { ...process.env, ...gitPager },
  });
}

export async function collectGitEvidence(
  repoPath: string,
  frames: StackFrame[],
): Promise<GitEvidence> {
  const topLevel = await git(repoPath, ["rev-parse", "--show-toplevel"]);
  if (!topLevel || topLevel.code !== 0) {
    return { available: false, recentCommits: [], commitsTouchingSuspects: [], blame: [] };
  }

  const root = topLevel.stdout.trim() || repoPath;
  const scope = gitScopePath(root, repoPath);
  const [branch, head, status, recent] = await Promise.all([
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(root, ["rev-parse", "--short", "HEAD"]),
    git(root, ["status", "--short", "--", scope ?? "."]),
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
  const result = await git(
    cwd,
    ["log", "-15", "--format=%H%x09%an%x09%ad%x09%s", "--date=short", "--", scope ?? "."],
    10_000,
  );
  if (!result || result.code !== 0) return [];
  return parseCommitLines(result.stdout);
}

async function collectCommitsForFiles(cwd: string, files: string[]): Promise<GitCommit[]> {
  if (files.length === 0) return [];
  const result = await git(
    cwd,
    ["log", "-12", "--format=%H%x09%an%x09%ad%x09%s", "--date=short", "--", ...files.slice(0, 8)],
    10_000,
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
    const result = await git(cwd, ["blame", "-L", `${frame.line},${frame.line}`, "--porcelain", "--", rel]);
    if (!result || result.code !== 0) continue;
    const parsed = parsePorcelainBlame(rel, frame.line, result.stdout);
    if (parsed) blame.push(parsed);
  }

  return blame;
}

export async function listCommitFiles(repoPath: string, sha: string): Promise<string[]> {
  const result = await git(repoPath, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
  if (!result || result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 40);
}

export async function showCommitDiff(repoPath: string, sha: string, files: string[]): Promise<string> {
  const paths = files.slice(0, 4);
  const args = paths.length ? ["show", "--no-color", sha, "--", ...paths] : ["show", "--no-color", "--stat", sha];
  const result = await git(repoPath, args, 12_000);
  if (!result || result.code !== 0) return "";
  const text = result.stdout.trim();
  return text.length > 4_000 ? `${text.slice(0, 4_000)}\n…` : text;
}

/** Resolve `v1.0.180` / `1.0.180` to a git tag or commit. */
export async function resolveVersionRef(repoPath: string, version: string): Promise<string | undefined> {
  const raw = version.trim().replace(/^v/i, "");
  if (!raw) return undefined;
  const candidates = [`v${raw}`, raw, version.trim()];
  for (const ref of candidates) {
    const result = await git(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (result && result.code === 0 && result.stdout.trim()) return ref;
  }
  return undefined;
}

export async function countCommitsBetween(repoPath: string, fromRef: string, toRef: string): Promise<number> {
  const result = await git(repoPath, ["rev-list", "--count", `${fromRef}..${toRef}`], 12_000);
  if (!result || result.code !== 0) return 0;
  const value = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export async function listCommitsBetween(repoPath: string, fromRef: string, toRef: string): Promise<GitCommit[]> {
  const result = await git(
    repoPath,
    ["log", "--reverse", "--format=%H%x09%an%x09%ad%x09%s", "--date=short", `${fromRef}..${toRef}`],
    15_000,
  );
  if (!result || result.code !== 0) return [];
  return parseCommitLines(result.stdout);
}

export async function resolveCommit(repoPath: string, ref: string): Promise<GitCommit | undefined> {
  const result = await git(repoPath, ["log", "-1", "--format=%H%x09%an%x09%ad%x09%s", "--date=short", ref]);
  if (!result || result.code !== 0) return undefined;
  return parseCommitLines(result.stdout)[0];
}

export async function listChangedFiles(repoPath: string, fromRef: string, toRef: string): Promise<string[]> {
  const result = await git(repoPath, ["diff", "--name-only", fromRef, toRef], 12_000);
  if (!result || result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 80);
}

export async function showFileAt(repoPath: string, sha: string, file: string): Promise<string | undefined> {
  for (const candidate of fileCandidates(repoPath, file)) {
    const result = await git(repoPath, ["show", `${sha}:${candidate}`], 8_000);
    if (result && result.code === 0) return result.stdout;
  }
  return undefined;
}

function fileCandidates(repoPath: string, file: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };
  if (path.isAbsolute(file)) {
    const rel = path.relative(repoPath, file);
    if (rel && !rel.startsWith("..")) add(rel);
  } else {
    add(file);
  }
  add(path.basename(file));
  return out;
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

  return { file, line, sha, author, date: iso, summary };
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
  const abs = resolveReal(path.isAbsolute(file) ? file : path.resolve(repoPath, file));
  const root = resolveReal(gitRoot);
  if (abs !== root && !abs.startsWith(root + path.sep)) return undefined;
  return path.relative(root, abs) || undefined;
}

function gitScopePath(gitRoot: string, repoPath: string): string | undefined {
  const rel = path.relative(resolveReal(gitRoot), resolveReal(repoPath));
  if (!rel || rel === "." || rel.startsWith("..")) return undefined;
  return rel;
}

function resolveReal(p: string): string {
  const resolved = path.resolve(p);
  try {
    if (existsSync(resolved)) return realpathSync(resolved);
    const parent = path.dirname(resolved);
    if (existsSync(parent)) return path.join(realpathSync(parent), path.basename(resolved));
  } catch {
    return resolved;
  }
  return resolved;
}
