import { displayVersion, investigateFirstBadVersion } from "../analysis/first-bad-version.js";
import { runGitBisect } from "../analysis/git-bisect.js";
import { buildGitRegression, crashFileOverlap, matchListedPullRequest, parsePrNumber } from "../analysis/git-regression.js";
import { parseProductionSignals } from "../analysis/production.js";
import { collectGitEvidence, listCommitFiles, showCommitDiff } from "../collectors/git.js";
import { collectPullRequests, findPullRequestForCommit, inspectPullRequest } from "../collectors/github.js";
import { tryCommand } from "../exec.js";
import type {
  AgentRun,
  CodeInvestigation,
  FirstBadVersion,
  GitBisect,
  GitCommit,
  GitInvestigation,
  GitSuspect,
  LogAnalysis,
  PullRequestEvidence,
  StackFrame,
} from "../types.js";
import { LogAnalyzerAgent } from "./log-analyzer.js";
import { GIT_INVESTIGATOR, type AgentContext, type SpecialistAgent } from "./types.js";

const gitPager = { GIT_PAGER: "cat", PAGER: "cat" };

/**
 * Git Investigator — answers “when did this bug appear?” via blame, history, and PR inspection.
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
    const frames = investigationFrames(logAnalysis, ctx.codeInvestigation);
    const crashFiles = uniqueCrashFiles(frames);
    const [evidence, listedPrs, pickaxe] = await Promise.all([
      collectGitEvidence(ctx.input.repoPath, frames),
      collectPullRequests(ctx.input.repoPath, frames),
      collectPickaxe(ctx.input.repoPath, ctx.codeInvestigation?.suspects ?? []),
    ]);

    const extraContext = [ctx.input.extraContext, ctx.input.logText, ctx.input.message].filter(Boolean).join("\n");
    const version = ctx.input.version ?? parseProductionSignals(extraContext).version;
    const firstBadVersion = await investigateFirstBadVersion({
      repoPath: ctx.input.repoPath,
      version,
      extraContext,
    });
    const bisect =
      firstBadVersion?.fromRef && firstBadVersion.toRef
        ? await runGitBisect({
            repoPath: ctx.input.repoPath,
            goodRef: firstBadVersion.fromRef,
            badRef: firstBadVersion.toRef,
            commits: firstBadVersion.commits,
            crashFiles,
            suspects: ctx.codeInvestigation?.suspects,
            testCommand: ctx.runTests === false ? undefined : ctx.evidence?.tests.testCommand,
          })
        : undefined;

    const suspects = rankGitSuspects({
      blame: evidence.blame,
      commits: evidence.commitsTouchingSuspects.concat(evidence.recentCommits),
      pickaxe,
      pullRequests: listedPrs,
      windowCommits: firstBadVersion?.commits,
      windowLabel: firstBadWindowLabel(firstBadVersion),
      bisectCommit: bisect?.firstBad,
    });
    const introducing = suspects[0];

    let pullRequests = listedPrs;
    let regression: GitInvestigation["regression"];

    if (introducing && evidence.available) {
      const filesChanged = await listCommitFiles(ctx.input.repoPath, introducing.sha);
      const overlap = crashFileOverlap(filesChanged, crashFiles);
      const diffExcerpt =
        (await showCommitDiff(ctx.input.repoPath, introducing.sha, overlap.length ? overlap : filesChanged)) ||
        undefined;
      const pullRequest = await resolveIntroducingPullRequest(
        ctx.input.repoPath,
        introducing,
        listedPrs,
        crashFiles,
      );
      if (pullRequest) {
        pullRequests = [pullRequest, ...listedPrs.filter((pr) => pr.number !== pullRequest.number)];
      }
      regression = buildGitRegression({
        commit: introducing,
        filesChanged,
        crashFiles,
        diffExcerpt,
        pullRequest,
      });
    }

    const summary = buildGitSummary(evidence, introducing, regression, firstBadVersion, bisect);
    const handoff = buildGitHandoff(introducing, regression, evidence, firstBadVersion, bisect);

    return { evidence, pullRequests, suspects, introducing, regression, firstBadVersion, bisect, summary, handoff };
  }
}

export function rankGitSuspects(input: {
  blame: GitInvestigation["evidence"]["blame"];
  commits: GitCommit[];
  pickaxe: GitCommit[];
  pullRequests: PullRequestEvidence[];
  windowCommits?: GitCommit[];
  windowLabel?: string;
  bisectCommit?: GitCommit;
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

  const windowLabel = input.windowLabel ?? "last healthy → first bad";
  for (const commit of input.windowCommits ?? []) {
    bump(commit, 0.5, `in first-bad version window (${windowLabel})`);
  }
  if (input.bisectCommit) {
    bump(input.bisectCommit, 1.0, "git bisect first bad commit");
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

async function resolveIntroducingPullRequest(
  repoPath: string,
  introducing: GitSuspect,
  listed: PullRequestEvidence[],
  crashFiles: string[],
): Promise<PullRequestEvidence | undefined> {
  let pullRequest = matchListedPullRequest(listed, crashFiles, introducing.subject);
  const numbered = parsePrNumber(introducing.subject);
  if (!pullRequest && numbered) {
    pullRequest = await inspectPullRequest(repoPath, numbered);
  }
  if (!pullRequest) {
    pullRequest = await findPullRequestForCommit(repoPath, introducing.sha);
  } else if (!pullRequest.body) {
    const inspected = await inspectPullRequest(repoPath, pullRequest.number);
    if (inspected) {
      pullRequest = {
        ...inspected,
        overlap: pullRequest.overlap ?? inspected.overlap,
      };
    }
  }
  if (!pullRequest) return undefined;
  const overlap = crashFileOverlap(pullRequest.files ?? [], crashFiles);
  return {
    ...pullRequest,
    overlap: pullRequest.overlap?.length ? pullRequest.overlap : overlap,
  };
}

function investigationFrames(logAnalysis: LogAnalysis, code?: CodeInvestigation): StackFrame[] {
  const frames = [...logAnalysis.error.frames];
  const origin = code?.origin;
  if (!origin?.file) return frames;
  const already = frames.some((frame) => frame.file === origin.file && frame.line === origin.line);
  if (already) return frames;
  frames.unshift({
    ...origin,
    inProject: origin.inProject ?? true,
    raw: origin.raw || origin.file,
  });
  return frames;
}

function uniqueCrashFiles(frames: StackFrame[]): string[] {
  return [...new Set(frames.filter((frame) => frame.inProject).map((frame) => frame.file))];
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
  regression: GitInvestigation["regression"],
  firstBad?: FirstBadVersion,
  bisect?: GitBisect,
): string {
  const gitSummary = !evidence.available
    ? "Not a git repository; cannot attribute an introducing commit."
    : regression
      ? regression.summary
      : introducing
        ? `Likely introduced by ${introducing.sha.slice(0, 8)} (${introducing.author}, ${introducing.date}): ${introducing.subject}.`
        : `Git history available on ${evidence.branch ?? "HEAD"}; no strong introducing commit ranked.`;
  return [firstBad?.summary, bisect?.summary, gitSummary].filter(Boolean).join(" ");
}

function buildGitHandoff(
  introducing: GitSuspect | undefined,
  regression: GitInvestigation["regression"],
  evidence: GitInvestigation["evidence"],
  firstBad?: FirstBadVersion,
  bisect?: GitBisect,
): string[] {
  const notes: string[] = [];
  if (bisect?.firstBad) {
    notes.push(
      `Git bisect isolated ${bisect.firstBad.sha.slice(0, 8)} after ${bisect.testsRun} test${bisect.testsRun === 1 ? "" : "s"} (${bisect.method}).`,
    );
  }
  if (firstBad?.lastHealthy) {
    notes.push(
      `Investigate the ${firstBad.commitCount} commits between ${displayVersion(firstBad.lastHealthy)} and ${displayVersion(firstBad.firstBad)}.`,
    );
  }
  if (introducing) {
    notes.push(`Inspect commit ${introducing.sha.slice(0, 8)} — ${introducing.subject} (${introducing.reasons.join("; ")}).`);
  }
  const pr = regression?.pullRequest;
  if (pr) notes.push(`Inspect PR #${pr.number}: ${pr.title}${pr.url ? ` (${pr.url})` : ""}.`);
  if (regression?.changed.length) {
    notes.push(`Changed files: ${regression.changed.map((file) => file.split(/[\\/]/).pop()).join(", ")}.`);
  }
  if (evidence.blame[0]) {
    const b = evidence.blame[0];
    notes.push(`Blame on crash line: ${b.file}:${b.line} last touched by ${b.author} in ${b.sha}.`);
  }
  return notes;
}

function firstBadWindowLabel(firstBad?: FirstBadVersion): string | undefined {
  if (!firstBad?.lastHealthy) return undefined;
  return `${displayVersion(firstBad.lastHealthy)} → ${displayVersion(firstBad.firstBad)}`;
}
