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
    expect(agent.responsibility).toBe("Find commits/PRs that introduced the problem");
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
