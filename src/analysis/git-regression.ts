import path from "node:path";
import { clamp } from "../exec.js";
import type { GitRegression, GitSuspect, PullRequestEvidence } from "../types.js";

export function parsePrNumber(subject: string): number | undefined {
  const match = subject.match(/\(#(\d+)\)/) ?? subject.match(/(?:^|[\s])#(\d+)\b/);
  if (!match?.[1]) return undefined;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

export function crashFileOverlap(changed: string[], crashFiles: string[]): string[] {
  const crash = crashFiles.map((file) => normalize(file)).filter(Boolean);
  const hits: string[] = [];
  for (const file of changed) {
    const rel = normalize(file);
    if (!rel) continue;
    const base = path.basename(rel);
    if (crash.some((hint) => rel.endsWith(hint) || hint.endsWith(rel) || path.basename(hint) === base)) {
      hits.push(file);
    }
  }
  return hits;
}

export function matchListedPullRequest(
  prs: PullRequestEvidence[],
  crashFiles: string[],
  subject: string,
): PullRequestEvidence | undefined {
  const numbered = parsePrNumber(subject);
  if (numbered) {
    const byNumber = prs.find((pr) => pr.number === numbered);
    if (byNumber) return byNumber;
  }
  const overlapping = prs.find((pr) => {
    if (pr.overlap?.length) return true;
    return crashFileOverlap(pr.files ?? [], crashFiles).length > 0;
  });
  return overlapping;
}

export function regressionConfidence(input: {
  suspect: GitSuspect;
  filesChanged: string[];
  crashFiles: string[];
  pullRequest?: PullRequestEvidence;
}): number {
  let confidence = Math.min(0.58, 0.28 + input.suspect.score * 0.3);
  if (input.suspect.reasons.some((reason) => reason.includes("git blame"))) confidence += 0.2;
  if (input.suspect.reasons.some((reason) => /pickaxe/i.test(reason))) confidence += 0.08;
  if (crashFileOverlap(input.filesChanged, input.crashFiles).length > 0) confidence += 0.1;
  if (input.pullRequest) confidence += 0.06;
  return clamp(confidence, 0.05, 0.95);
}

export function buildGitRegression(input: {
  commit: GitSuspect;
  filesChanged: string[];
  crashFiles: string[];
  diffExcerpt?: string;
  pullRequest?: PullRequestEvidence;
}): GitRegression {
  const overlap = crashFileOverlap(input.filesChanged, input.crashFiles);
  const changed = overlap.length ? overlap : input.filesChanged.slice(0, 8);
  const confidence = regressionConfidence({
    suspect: input.commit,
    filesChanged: input.filesChanged,
    crashFiles: input.crashFiles,
    pullRequest: input.pullRequest,
  });
  const pr = input.pullRequest ? ` PR #${input.pullRequest.number}.` : "";
  const files = changed.length ? ` Changed ${changed.map((file) => path.basename(file)).join(", ")}.` : "";
  return {
    commit: input.commit,
    filesChanged: input.filesChanged,
    changed,
    diffExcerpt: input.diffExcerpt,
    pullRequest: input.pullRequest,
    confidence,
    summary: `Likely introduced by ${input.commit.sha.slice(0, 7)} (${input.commit.author}).${files}${pr} Confidence ${Math.round(confidence * 100)}%.`,
  };
}

export function renderGitRegressionAscii(regression: GitRegression): string {
  const files = (regression.changed.length ? regression.changed : regression.filesChanged)
    .slice(0, 8)
    .map((file) => path.basename(file));
  const pr = regression.pullRequest;
  const lines = [
    "Likely introduced by:",
    "",
    `Commit: ${regression.commit.sha.slice(0, 7)}`,
    `Author: ${regression.commit.author}`,
    `PR: ${pr ? `#${pr.number}` : "none"}`,
    "",
    "Changed:",
    files.length ? files.join("\n") : "Unknown",
    "",
    `Confidence: ${Math.round(regression.confidence * 100)}%`,
  ];
  if (pr?.title) {
    lines.push("", "PR inspection:", `#${pr.number} ${pr.title}${pr.author ? ` (${pr.author})` : ""}`);
    if (pr.url) lines.push(pr.url);
    if (pr.body) lines.push(pr.body.split("\n").slice(0, 8).join("\n"));
  }
  return lines.join("\n");
}

function normalize(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}
