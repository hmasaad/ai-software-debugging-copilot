import { tryCommand } from "../exec.js";
import type { PullRequestEvidence, StackFrame } from "../types.js";

export async function collectPullRequests(
  repoPath: string,
  frames: StackFrame[],
): Promise<PullRequestEvidence[]> {
  const gh = await tryCommand("gh", ["--version"], { cwd: repoPath, timeoutMs: 5_000 });
  if (!gh || gh.code !== 0) return [];

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
        const relevant =
          fileHints.length === 0 ||
          prFiles.some((file) => fileHints.some((hint) => file.endsWith(hint) || hint.endsWith(file)));
        return {
          number: pr.number,
          title: pr.title,
          url: pr.url,
          state: pr.state,
          author: pr.author?.login,
          mergedAt: pr.mergedAt,
          files: prFiles.slice(0, 12),
          relevant,
        };
      })
      .sort((a, b) => Number(b.relevant) - Number(a.relevant))
      .map((pr) => ({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state: pr.state,
        author: pr.author,
        mergedAt: pr.mergedAt,
        files: pr.files,
      }));
  } catch {
    return [];
  }
}
