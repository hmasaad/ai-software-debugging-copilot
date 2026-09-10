import { describe, expect, it } from "vitest";
import {
  buildGitRegression,
  matchListedPullRequest,
  parsePrNumber,
  renderGitRegressionAscii,
} from "../src/analysis/git-regression.js";
import type { GitSuspect, PullRequestEvidence } from "../src/types.js";

const blameCommit: GitSuspect = {
  sha: "8f31a2cdeadbeef",
  author: "Developer",
  date: "2026-09-10",
  subject: "Assume media always exists (#421)",
  score: 0.9,
  reasons: ["git blame on SavingsRepository.dart:40"],
};

describe("git regression", () => {
  it("parses a PR number from a conventional merge subject", () => {
    expect(parsePrNumber("Assume media (#421)")).toBe(421);
    expect(parsePrNumber("Fix crash #12 in parser")).toBe(12);
    expect(parsePrNumber("no pull request here")).toBeUndefined();
  });

  it("does not attach an unrelated first merged PR", () => {
    const unrelated: PullRequestEvidence = {
      number: 99,
      title: "Docs",
      url: "https://example/99",
      state: "merged",
      files: ["README.md"],
    };
    expect(matchListedPullRequest([unrelated], ["lib/savings/SavingsRepository.dart"], "unguarded item.id access")).toBeUndefined();
  });

  it("matches a listed PR by subject number or crash-file overlap", () => {
    const overlapping: PullRequestEvidence = {
      number: 421,
      title: "Savings media",
      url: "https://example/421",
      state: "merged",
      files: ["lib/savings/SavingsRepository.dart"],
      overlap: ["lib/savings/SavingsRepository.dart"],
    };
    const unrelated: PullRequestEvidence = {
      number: 99,
      title: "Docs",
      url: "https://example/99",
      state: "merged",
      files: ["README.md"],
    };
    expect(matchListedPullRequest([unrelated, overlapping], ["SavingsRepository.dart"], "unguarded")).toEqual(overlapping);
    expect(matchListedPullRequest([unrelated, overlapping], ["other.dart"], "Assume media (#421)")).toEqual(overlapping);
  });

  it("renders commit, author, changed files, and confidence", () => {
    const regression = buildGitRegression({
      commit: blameCommit,
      filesChanged: ["lib/savings/SavingsRepository.dart", "README.md"],
      crashFiles: ["lib/savings/SavingsRepository.dart"],
      pullRequest: {
        number: 421,
        title: "Savings media",
        url: "https://example/421",
        state: "merged",
        author: "Developer",
        files: ["lib/savings/SavingsRepository.dart"],
        body: "Handle savings media payloads.",
      },
    });
    const ascii = renderGitRegressionAscii(regression);
    expect(ascii).toContain("Commit: 8f31a2c");
    expect(ascii).toContain("Author: Developer");
    expect(ascii).toContain("PR: #421");
    expect(ascii).toContain("Changed:");
    expect(ascii).toContain("SavingsRepository.dart");
    expect(ascii).toMatch(/Confidence: \d+%/);
    expect(regression.confidence).toBeGreaterThan(0.7);
  });
});
