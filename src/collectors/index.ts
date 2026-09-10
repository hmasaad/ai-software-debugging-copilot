import { collectErrorAndLogs } from "./logs.js";
import { collectSourceSnippets } from "./source.js";
import { collectGitEvidence } from "./git.js";
import { collectPullRequests } from "./github.js";
import { collectTests } from "./tests.js";
import { collectDependencies } from "./dependencies.js";
import { collectRuntime } from "./runtime.js";
import type { BugInput, EvidenceBundle, LogAnalysis } from "../types.js";

export async function collectEvidence(input: BugInput, logAnalysis?: LogAnalysis): Promise<EvidenceBundle> {
  const { error, logs } = logAnalysis ?? (await collectErrorAndLogs(input));

  const [sourceSnippets, git, pullRequests, tests, dependencies, runtime] = await Promise.all([
    collectSourceSnippets(input.repoPath, error.frames),
    collectGitEvidence(input.repoPath, error.frames),
    collectPullRequests(input.repoPath, error.frames),
    collectTests(input.repoPath, error.frames),
    collectDependencies(input.repoPath, error, error.frames),
    collectRuntime(input.repoPath),
  ]);

  return {
    collectedAt: new Date().toISOString(),
    repoPath: input.repoPath,
    error,
    logs,
    sourceSnippets,
    git,
    pullRequests,
    tests,
    dependencies,
    runtime,
    logAnalysis,
  };
}

export { parseErrorText } from "./stack-trace.js";
