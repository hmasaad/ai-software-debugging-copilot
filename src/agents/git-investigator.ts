import { collectGitEvidence } from "../collectors/git.js";
import { collectPullRequests } from "../collectors/github.js";
import { tryCommand } from "../exec.js";
import type { AgentRun, GitCommit, GitInvestigation, GitSuspect, PullRequestEvidence } from "../types.js";
import { LogAnalyzerAgent } from "./log-analyzer.js";
import { GIT_INVESTIGATOR, type AgentContext, type SpecialistAgent } from "./types.js";

const gitPager = { GIT_PAGER: "cat", PAGER: "cat" };

/**
 * Git Investigator — finds commits and PRs that likely introduced the problem.
 */
export class GitInvestigatorAgent implements SpecialistAgent<GitInvestigation> {
  readonly id = GIT_INVESTIGATOR.id;
  readonly name = GIT_INVESTIGATOR.name;
  readonly responsibility = GIT_INVESTIGATOR.responsibility;

  async run(ctx: AgentContext): Promise<{ result: GitInvestigation; run: AgentRun }> {
    const started = Date.now();
    const result = await this.analyze(ctx);
    return {
      result,
      run: {
        id: this.id,
        name: this.name,
        responsibility: this.responsibility,
        status: "ok",
        summary: result.summary,
        durationMs: Date.now() - started,
      },
    };
  }

  async analyze(ctx: AgentContext): Promise<GitInvestigation> {
    const logAnalysis = ctx.logAnalysis ?? (await new LogAnalyzerAgent().analyze(ctx.input));
    const frames = logAnalysis.error.frames;
    const [evidence, pullRequests, pickaxe] = await Promise.all([
      collectGitEvidence(ctx.input.repoPath, frames),
      collectPullRequests(ctx.input.repoPath, frames),
      collectPickaxe(ctx.input.repoPath, ctx.codeInvestigation?.suspects ?? []),
    ]);

    const suspects = rankGitSuspects({
      blame: evidence.blame,
      commits: evidence.commitsTouchingSuspects.concat(evidence.recentCommits),
      pickaxe,
      pullRequests,
    });
    const introducing = suspects[0];
    const summary = buildGitSummary(evidence, introducing, pullRequests);
    const handoff = buildGitHandoff(introducing, pullRequests, evidence);

    return { evidence, pullRequests, suspects, introducing, summary, handoff };
  }
}

export function rankGitSuspects(input: {
  blame: GitInvestigation["evidence"]["blame"];
  commits: GitCommit[];
  pickaxe: GitCommit[];
  pullRequests: PullRequestEvidence[];
}): GitSuspect[] {
  const scores = new Map<string, GitSuspect>();

  const bump = (commit: { sha: string; author: string; date: string; subject: string }, score: number, reason: string) => {
    const sha = commit.sha;
    if (!sha) return;
    const key = sha.slice(0, 12);
    const existing = scores.get(key);
    if (existing) {
      existing.score += score;
      if (sha.length > existing.sha.length) existing.sha = sha;
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      return;
    }
    scores.set(key, {
      sha,
      author: commit.author,
      date: commit.date,
      subject: commit.subject,
      score,
      reasons: [reason],
    });
  };

  for (const line of input.blame) {
    bump(
      { sha: line.sha, author: line.author, date: line.date, subject: line.summary },
      0.9,
      `git blame on ${line.file}:${line.line}`,
    );
  }

  for (const commit of input.pickaxe) {
    bump(commit, 0.65, "pickaxe hit for a crashing identifier");
  }

  for (const commit of input.commits) {
    bump(commit, 0.35, "recently touched a suspect file");
    if (/(fix|bug|crash|null|undefined|npe|regress)/i.test(commit.subject)) {
      bump(commit, 0.15, `subject mentions ${commit.subject}`);
    }
  }

  const prFiles = new Set(input.pullRequests.flatMap((pr) => pr.files ?? []));
  if (prFiles.size && input.blame[0]) {
    const top = [...scores.values()][0];
    if (top) bump(top, 0.1, "overlaps a recently merged PR file set");
  }

  return [...scores.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const blamed = (s: GitSuspect) => s.reasons.some((reason) => reason.includes("git blame"));
      if (blamed(a) !== blamed(b)) return blamed(a) ? -1 : 1;
      return b.date.localeCompare(a.date);
    })
    .slice(0, 8);
}

async function collectPickaxe(repoPath: string, suspects: string[]): Promise<GitCommit[]> {
  const tokens = suspects.filter((name) => name.length >= 3).slice(0, 3);
  const found: GitCommit[] = [];
  const seen = new Set<string>();
  for (const needle of tokens) {
    const result = await tryCommand(
      "git",
      ["--no-pager", "log", "-6", "-S", needle, "--format=%H%x09%an%x09%ad%x09%s", "--date=short"],
      {
        cwd: repoPath,
        timeoutMs: 10_000,
        env: { ...process.env, ...gitPager },
      },
    );
    if (!result || result.code !== 0 || !result.stdout.trim()) continue;
    for (const line of result.stdout.split("\n").map((row) => row.trim()).filter(Boolean)) {
      const [sha, author, date, ...subject] = line.split("\t");
      if (!sha || seen.has(sha)) continue;
      seen.add(sha);
      found.push({ sha, author: author ?? "", date: date ?? "", subject: subject.join("\t") });
    }
  }
  return found;
}

function buildGitSummary(
  evidence: GitInvestigation["evidence"],
  introducing: GitSuspect | undefined,
  prs: PullRequestEvidence[],
): string {
  if (!evidence.available) return "Not a git repository; cannot attribute an introducing commit.";
  if (introducing) {
    const pr = prs[0] ? ` Related PR #${prs[0].number} ${prs[0].title}.` : "";
    return `Likely introduced by ${introducing.sha.slice(0, 8)} (${introducing.author}, ${introducing.date}): ${introducing.subject}.${pr}`;
  }
  return `Git history available on ${evidence.branch ?? "HEAD"}; no strong introducing commit ranked.`;
}

function buildGitHandoff(
  introducing: GitSuspect | undefined,
  prs: PullRequestEvidence[],
  evidence: GitInvestigation["evidence"],
): string[] {
  const notes: string[] = [];
  if (introducing) {
    notes.push(`Inspect commit ${introducing.sha.slice(0, 8)} — ${introducing.subject} (${introducing.reasons.join("; ")}).`);
  }
  if (prs[0]) notes.push(`Review merged PR #${prs[0].number}: ${prs[0].title}.`);
  if (evidence.blame[0]) {
    const b = evidence.blame[0];
    notes.push(`Blame on crash line: ${b.file}:${b.line} last touched by ${b.author} in ${b.sha}.`);
  }
  return notes;
}
