import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { tryCommand } from "../exec.js";
import {
  listChangedFiles,
  listCommitsBetween,
  showFileAt,
} from "../collectors/git.js";
import type { BisectVerdict, GitBisect, GitBisectStep, GitCommit } from "../types.js";

const gitPager = { GIT_PAGER: "cat", PAGER: "cat" };

export const GIT_BISECT_FLOW = [
  "Good commit",
  "     ↓",
  "          Middle commit",
  "          ↓",
  "       Test",
  "      ↙     ↘",
  "   Good     Bad",
  "     ↓       ↓",
  "   search  search",
  "      ↘     ↙",
  "      Bad commit",
].join("\n");

/**
 * Binary-search a chronological commit list (after last-good, including first-bad)
 * until the introducing commit is isolated.
 */
export async function bisectCommits(input: {
  commits: GitCommit[];
  test: (commit: GitCommit) => Promise<BisectVerdict> | BisectVerdict;
  maxSteps?: number;
}): Promise<{ steps: GitBisectStep[]; firstBad?: GitCommit; testsRun: number }> {
  const remaining = input.commits.filter((commit) => commit.sha);
  const steps: GitBisectStep[] = [];
  const maxSteps = input.maxSteps ?? 16;
  if (!remaining.length) return { steps, testsRun: 0 };

  let lo = 0;
  let hi = remaining.length - 1;

  while (lo < hi && steps.length < maxSteps) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const commit = remaining[mid];
    if (!commit) break;
    const verdict = await input.test(commit);
    steps.push({
      sha: commit.sha,
      subject: commit.subject,
      verdict,
      remaining: hi - lo + 1,
      detail: detailFor(verdict, commit),
    });
    if (verdict === "skip") {
      remaining.splice(mid, 1);
      if (!remaining.length) break;
      hi = Math.min(hi, remaining.length - 1);
      if (lo > hi) lo = hi;
      continue;
    }
    if (verdict === "bad") {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }

  const firstBad = remaining[lo];
  return { steps, firstBad, testsRun: steps.length };
}

export async function runGitBisect(input: {
  repoPath: string;
  goodRef: string;
  badRef: string;
  commits?: GitCommit[];
  crashFiles?: string[];
  suspects?: string[];
  testCommand?: string;
  test?: (commit: GitCommit) => Promise<BisectVerdict> | BisectVerdict;
}): Promise<GitBisect | undefined> {
  const commits = input.commits?.length
    ? input.commits
    : await listCommitsBetween(input.repoPath, input.goodRef, input.badRef);
  if (!commits.length) return undefined;

  let worktree: string | undefined;
  let test = input.test;
  let method: GitBisect["method"] = "source";

  try {
    if (!test && input.testCommand) {
      worktree = await addDetachedWorktree(input.repoPath, input.goodRef);
      if (worktree) {
        method = "test";
        test = (commit) => testAtWorktree(worktree!, commit, input.testCommand!);
      }
    }
    if (!test) {
      const files =
        (input.crashFiles?.length ? input.crashFiles : await listChangedFiles(input.repoPath, input.goodRef, input.badRef)) ??
        [];
      test = (commit) =>
        testSourceAtCommit({
          repoPath: input.repoPath,
          goodRef: input.goodRef,
          badRef: input.badRef,
          commit,
          files,
          needles: input.suspects ?? [],
        });
    }

    const { steps, firstBad, testsRun } = await bisectCommits({ commits, test });
    const sha = firstBad?.sha.slice(0, 8) ?? "unknown";
    const subject = firstBad?.subject ? ` (${firstBad.subject})` : "";
    return {
      goodRef: input.goodRef,
      badRef: input.badRef,
      steps,
      firstBad,
      testsRun,
      method,
      summary: firstBad
        ? `Git bisect found ${sha}${subject} after ${testsRun} test${testsRun === 1 ? "" : "s"}.`
        : `Git bisect ran ${testsRun} test${testsRun === 1 ? "" : "s"} but could not isolate a first bad commit.`,
    };
  } finally {
    if (worktree) await removeWorktree(input.repoPath, worktree);
  }
}

export function renderGitBisectAscii(bisect?: GitBisect): string {
  if (!bisect) return GIT_BISECT_FLOW;
  const steps = bisect.steps.map(
    (step) => `${step.verdict === "bad" ? "Bad" : step.verdict === "good" ? "Good" : "Skip"} ${step.sha.slice(0, 8)} ${step.subject}`,
  );
  return [GIT_BISECT_FLOW, "", bisect.summary, ...steps].filter(Boolean).join("\n");
}

export function sourceVerdict(input: {
  goodContent?: string;
  badContent?: string;
  midContent?: string;
  needles?: string[];
}): BisectVerdict {
  if (input.midContent == null) return "skip";
  if (input.goodContent != null && input.midContent === input.goodContent) return "good";
  if (input.badContent != null && input.midContent === input.badContent) return "bad";
  const needles = (input.needles ?? []).filter((needle) => needle.length >= 2);
  if (needles.length && input.badContent != null) {
    const introduced = needles.some(
      (needle) =>
        input.midContent!.includes(needle) &&
        input.badContent!.includes(needle) &&
        !(input.goodContent ?? "").includes(needle),
    );
    if (introduced) return "bad";
  }
  return "good";
}

async function testSourceAtCommit(input: {
  repoPath: string;
  goodRef: string;
  badRef: string;
  commit: GitCommit;
  files: string[];
  needles: string[];
}): Promise<BisectVerdict> {
  const files = input.files.length ? input.files.slice(0, 8) : [];
  if (!files.length) return "skip";
  let sawSkip = false;
  for (const file of files) {
    const [goodContent, badContent, midContent] = await Promise.all([
      showFileAt(input.repoPath, input.goodRef, file),
      showFileAt(input.repoPath, input.badRef, file),
      showFileAt(input.repoPath, input.commit.sha, file),
    ]);
    if (goodContent == null && badContent == null && midContent == null) continue;
    const verdict = sourceVerdict({ goodContent, badContent, midContent, needles: input.needles });
    if (verdict === "bad") return "bad";
    if (verdict === "skip") sawSkip = true;
  }
  return sawSkip ? "skip" : "good";
}

async function testAtWorktree(worktree: string, commit: GitCommit, command: string): Promise<BisectVerdict> {
  const checkout = await git(worktree, ["checkout", "--force", "--quiet", commit.sha], 15_000);
  if (!checkout || checkout.code !== 0) return "skip";
  const parts = splitCommand(command);
  const bin = parts[0];
  if (!bin) return "skip";
  const result = await tryCommand(bin, parts.slice(1), {
    cwd: worktree,
    timeoutMs: 20_000,
    env: { ...process.env, CI: "true", FORCE_COLOR: "0", ...gitPager },
  });
  if (!result) return "skip";
  return result.code === 0 ? "good" : "bad";
}

async function addDetachedWorktree(repoPath: string, sha: string): Promise<string | undefined> {
  const dir = path.join(os.tmpdir(), `debug-copilot-bisect-${randomBytes(6).toString("hex")}`);
  const added = await git(repoPath, ["worktree", "add", "--detach", dir, sha], 30_000);
  if (added && added.code === 0) return dir;
  await rm(dir, { recursive: true, force: true });
  return undefined;
}

async function removeWorktree(repoPath: string, worktree: string): Promise<void> {
  const removed = await git(repoPath, ["worktree", "remove", "--force", worktree], 30_000);
  if (!removed || removed.code !== 0) {
    await rm(worktree, { recursive: true, force: true });
    await git(repoPath, ["worktree", "prune"], 15_000);
  }
}

function git(cwd: string, args: string[], timeoutMs = 8_000) {
  return tryCommand("git", ["--no-pager", "-c", "advice.detachedHead=false", ...args], {
    cwd,
    timeoutMs,
    env: { ...process.env, ...gitPager },
  });
}

function splitCommand(command: string): string[] {
  const match = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [command];
  return match.map((part) => part.replace(/^['"]|['"]$/g, ""));
}

function detailFor(verdict: BisectVerdict, commit: GitCommit): string {
  const short = commit.sha.slice(0, 8);
  if (verdict === "bad") return `Middle ${short} failed; search the earlier half.`;
  if (verdict === "good") return `Middle ${short} passed; search the later half.`;
  return `Middle ${short} skipped.`;
}
