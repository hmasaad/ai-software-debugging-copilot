import path from "node:path";
import { tryCommand } from "../exec.js";
import type { PullRequestEvidence, StackFrame } from "../types.js";

export async function collectPullRequests(
  repoPath: string,
  frames: StackFrame[],
): Promise<PullRequestEvidence[]> {
  if (!(await ghAvailable(repoPath)) || !(await isGitHubRepo(repoPath))) return [];

  const files = frames
    .filter((frame) => frame.inProject)
    .map((frame) => frame.file)
    .slice(0, 5);

  const list = await tryCommand(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "merged",
      "--limit",
      "8",
      "--json",
      "number,title,url,state,author,mergedAt,files",
    ],
    { cwd: repoPath, timeoutMs: 15_000 },
  );

  if (!list || list.code !== 0 || !list.stdout.trim()) return [];

  try {
    const parsed = JSON.parse(list.stdout) as Array<{
      number: number;
      title: string;
      url: string;
      state: string;
      author?: { login?: string };
      mergedAt?: string;
      files?: Array<{ path?: string }>;
    }>;

    const fileHints = [...new Set(files.map((file) => file.replace(/\\/g, "/")))];

    return parsed
      .map((pr) => {
        const prFiles = (pr.files ?? []).map((file) => file.path).filter((p): p is string => Boolean(p));
        const overlap = fileHints.filter((hint) =>
          prFiles.some(
            (file) => file.endsWith(hint) || hint.endsWith(file) || file.endsWith(path.basename(hint)),
          ),
        );
        return {
          number: pr.number,
          title: pr.title,
          url: pr.url,
          state: pr.state,
          author: pr.author?.login,
          mergedAt: pr.mergedAt,
          files: prFiles.slice(0, 12),
          overlap,
          relevant: fileHints.length === 0 || overlap.length > 0,
        };
      })
      .sort((a, b) => Number(b.relevant) - Number(a.relevant))
      .map(({ relevant: _relevant, ...pr }) => pr);
  } catch {
    return [];
  }
}

export async function inspectPullRequest(
  repoPath: string,
  number: number,
): Promise<PullRequestEvidence | undefined> {
  if (!(await ghAvailable(repoPath))) return undefined;
  const view = await tryCommand(
    "gh",
    ["pr", "view", String(number), "--json", "number,title,url,state,author,mergedAt,files,body"],
    { cwd: repoPath, timeoutMs: 15_000 },
  );
  if (!view || view.code !== 0 || !view.stdout.trim()) return undefined;
  try {
    const parsed = JSON.parse(view.stdout) as {
      number: number;
      title: string;
      url: string;
      state: string;
      author?: { login?: string };
      mergedAt?: string;
      files?: Array<{ path?: string }>;
      body?: string;
    };
    const files = (parsed.files ?? []).map((file) => file.path).filter((p): p is string => Boolean(p));
    const body = parsed.body?.trim();
    return {
      number: parsed.number,
      title: parsed.title,
      url: parsed.url,
      state: parsed.state,
      author: parsed.author?.login,
      mergedAt: parsed.mergedAt,
      files: files.slice(0, 20),
      body: body && body.length > 2_000 ? `${body.slice(0, 2_000)}…` : body || undefined,
    };
  } catch {
    return undefined;
  }
}

export async function findPullRequestForCommit(
  repoPath: string,
  sha: string,
): Promise<PullRequestEvidence | undefined> {
  if (!(await ghAvailable(repoPath)) || !(await isGitHubRepo(repoPath))) return undefined;
  const search = await tryCommand(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "merged",
      "--search",
      sha.slice(0, 12),
      "--limit",
      "1",
      "--json",
      "number,title,url,state,author,mergedAt,files",
    ],
    { cwd: repoPath, timeoutMs: 15_000 },
  );
  if (!search || search.code !== 0 || !search.stdout.trim()) return undefined;
  try {
    const parsed = JSON.parse(search.stdout) as Array<{ number?: number }>;
    const number = parsed[0]?.number;
    if (!number) return undefined;
    return inspectPullRequest(repoPath, number);
  } catch {
    return undefined;
  }
}

async function ghAvailable(repoPath: string): Promise<boolean> {
  const gh = await tryCommand("gh", ["--version"], { cwd: repoPath, timeoutMs: 5_000 });
  return Boolean(gh && gh.code === 0);
}

async function isGitHubRepo(repoPath: string): Promise<boolean> {
  const remote = await tryCommand("git", ["--no-pager", "remote", "get-url", "origin"], {
    cwd: repoPath,
    timeoutMs: 5_000,
    env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
  });
  const url = remote?.stdout ?? "";
  return /github\.com/i.test(url);
}
