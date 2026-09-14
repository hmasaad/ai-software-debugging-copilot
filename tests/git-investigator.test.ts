import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitInvestigatorAgent, rankGitSuspects } from "../src/agents/git-investigator.js";
import { GIT_INVESTIGATOR } from "../src/agents/types.js";
import { runCommand } from "../src/exec.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Git Investigator", () => {
  it("exposes the core-agent contract", () => {
    const agent = new GitInvestigatorAgent();
    expect(agent.id).toBe("git-investigator");
    expect(agent.name).toBe(GIT_INVESTIGATOR.name);
    expect(agent.responsibility).toBe("Find when the bug appeared (git regression)");
  });

  it("ranks blame higher than recency", () => {
    const ranked = rankGitSuspects({
      blame: [
        {
          file: "src/cart.js",
          line: 2,
          sha: "deadbeef1111",
          author: "Ada",
          date: "2026-09-10",
          summary: "unguarded item.id access",
        },
      ],
      commits: [
        { sha: "cafebabe2222", author: "Ben", date: "2026-09-09", subject: "Add cart helpers" },
        { sha: "deadbeef1111", author: "Ada", date: "2026-09-10", subject: "unguarded item.id access" },
      ],
      pickaxe: [{ sha: "deadbeef1111", author: "Ada", date: "2026-09-10", subject: "unguarded item.id access" }],
      pullRequests: [],
    });

    expect(ranked[0]?.sha).toBe("deadbeef1111");
    expect(ranked[0]?.reasons.some((reason) => reason.includes("git blame"))).toBe(true);
  });

  it("points at the commit that added the crashing line", async () => {
    const dir = await createTwoCommitRepo();
    fixtures.push(dir);

    const agent = new GitInvestigatorAgent();
    const { result, run } = await agent.run({
      input: {
        repoPath: dir,
        stackTrace: `TypeError: Cannot read properties of undefined (reading 'id')
    at getPrimaryItemId (${dir}/src/cart.js:2:21)`,
      },
      codeInvestigation: {
        suspects: ["order", "item", "id"],
        origin: { file: `${dir}/src/cart.js`, line: 2, functionName: "getPrimaryItemId", raw: "", inProject: true },
        trace: [],
        functions: [],
        callers: [],
        snippets: [],
        summary: "",
        handoff: [],
      },
    });

    expect(run.status).toBe("ok");
    expect(result.evidence.available).toBe(true);
    expect(result.introducing?.subject).toMatch(/unguarded item\.id/i);
    expect(result.evidence.blame[0]?.summary).toMatch(/unguarded item\.id/i);
    expect(result.regression?.filesChanged.some((file) => file.endsWith("src/cart.js") || file.endsWith("cart.js"))).toBe(
      true,
    );
    expect(result.regression?.confidence).toBeGreaterThan(0.7);
    expect(result.regression?.commit.author).toBeTruthy();
    expect(result.firstBadVersion).toBeUndefined();
    expect(result.bisect).toBeUndefined();
  });

  it("treats the first crashing release as the first bad version and inspects that window", async () => {
    const dir = await createTaggedReleaseRepo();
    fixtures.push(dir);

    const agent = new GitInvestigatorAgent();
    const { result } = await agent.run({
      input: {
        repoPath: dir,
        version: "1.0.181",
        extraContext: ["v1.0.180 → healthy", "v1.0.181 → crashes", "v1.0.182 → crashes"].join("\n"),
        stackTrace: `TypeError: Cannot read properties of undefined (reading 'id')
    at getPrimaryItemId (${dir}/src/cart.js:2:21)`,
      },
      codeInvestigation: {
        suspects: ["order", "item", "id"],
        origin: { file: `${dir}/src/cart.js`, line: 2, functionName: "getPrimaryItemId", raw: "", inProject: true },
        trace: [],
        functions: [],
        callers: [],
        snippets: [],
        summary: "",
        handoff: [],
      },
    });

    expect(result.firstBadVersion?.firstBad).toBe("1.0.181");
    expect(result.firstBadVersion?.lastHealthy).toBe("1.0.180");
    expect(result.firstBadVersion?.laterBad).toEqual(["1.0.182"]);
    expect(result.firstBadVersion?.commitCount).toBe(12);
    expect(result.introducing?.subject).toMatch(/unguarded item\.id/i);
    expect(result.suspects.some((commit) => commit.reasons.some((reason) => reason.includes("first-bad version window")))).toBe(
      true,
    );
    expect(result.handoff.some((note) => /12 commits between v1\.0\.180 and v1\.0\.181/.test(note))).toBe(true);
    expect(result.summary).toMatch(/v1\.0\.181 is the first known bad version/);
    expect(result.bisect?.firstBad?.subject).toMatch(/unguarded item\.id/i);
    expect(result.bisect?.testsRun).toBeGreaterThan(0);
    expect(result.introducing?.reasons.some((reason) => reason.includes("git bisect"))).toBe(true);
  });
});

async function createTwoCommitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "debug-copilot-git-"));
  await mkdir(path.join(dir, "src"));
  await writeFile(
    path.join(dir, "src/cart.js"),
    `export function getPrimaryItemId(order) {
  return order.safeId;
}
`,
  );

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
  };
  const gitUser = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false"];

  await runCommand("git", [...gitUser, "init"], { cwd: dir, timeoutMs: 10_000, env: gitEnv });
  await runCommand("git", [...gitUser, "add", "."], { cwd: dir, timeoutMs: 10_000, env: gitEnv });
  await runCommand("git", [...gitUser, "commit", "-m", "safe cart helper"], {
    cwd: dir,
    timeoutMs: 10_000,
    env: gitEnv,
  });

  await writeFile(
    path.join(dir, "src/cart.js"),
    `export function getPrimaryItemId(order) {
  return order.item.id;
}
`,
  );
  await runCommand("git", [...gitUser, "add", "."], { cwd: dir, timeoutMs: 10_000, env: gitEnv });
  await runCommand("git", [...gitUser, "commit", "-m", "unguarded item.id access"], {
    cwd: dir,
    timeoutMs: 10_000,
    env: gitEnv,
  });

  return dir;
}

async function createTaggedReleaseRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "debug-copilot-git-first-bad-"));
  await mkdir(path.join(dir, "src"));
  await writeFile(
    path.join(dir, "src/cart.js"),
    `export function getPrimaryItemId(order) {
  return order.safeId;
}
`,
  );

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
  };
  const gitUser = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false"];
  const git = (args: string[]) => runCommand("git", [...gitUser, ...args], { cwd: dir, timeoutMs: 10_000, env: gitEnv });

  await git(["init"]);
  await git(["add", "."]);
  await git(["commit", "-m", "safe cart helper"]);
  await git(["tag", "v1.0.180"]);

  for (let i = 1; i <= 11; i += 1) {
    await git(["commit", "--allow-empty", "-m", `chore: release candidate ${i}`]);
  }

  await writeFile(
    path.join(dir, "src/cart.js"),
    `export function getPrimaryItemId(order) {
  return order.item.id;
}
`,
  );
  await git(["add", "."]);
  await git(["commit", "-m", "unguarded item.id access"]);
  await git(["tag", "v1.0.181"]);
  await git(["commit", "--allow-empty", "-m", "chore: ship 1.0.182"]);
  await git(["tag", "v1.0.182"]);

  return dir;
}
