import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GIT_BISECT_FLOW,
  bisectCommits,
  renderGitBisectAscii,
  runGitBisect,
  sourceVerdict,
} from "../src/analysis/git-bisect.js";
import { tryCommand, runCommand } from "../src/exec.js";
import type { GitCommit } from "../src/types.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("automatic git bisect", () => {
  it("renders the search diagram", () => {
    expect(GIT_BISECT_FLOW).toBe(
      [
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
      ].join("\n"),
    );
    expect(renderGitBisectAscii()).toBe(GIT_BISECT_FLOW);
  });

  it("narrows 12 commits to the first bad one", async () => {
    const commits = Array.from({ length: 12 }, (_, index) => commitAt(index));
    const firstBadSha = commits[11]?.sha;
    const tested: string[] = [];
    const result = await bisectCommits({
      commits,
      test: (commit) => {
        tested.push(commit.sha);
        return commit.sha >= (firstBadSha ?? "") ? "bad" : "good";
      },
    });

    expect(result.firstBad?.sha).toBe(firstBadSha);
    expect(result.testsRun).toBeGreaterThan(0);
    expect(result.testsRun).toBeLessThan(12);
    expect(tested.length).toBe(result.testsRun);
    expect(renderGitBisectAscii({
      goodRef: "good",
      badRef: "bad",
      steps: result.steps,
      firstBad: result.firstBad,
      testsRun: result.testsRun,
      method: "source",
      summary: "Git bisect found c11 after 4 tests.",
    })).toContain("Good commit");
    expect(renderGitBisectAscii({
      goodRef: "good",
      badRef: "bad",
      steps: result.steps,
      firstBad: result.firstBad,
      testsRun: result.testsRun,
      method: "source",
      summary: "Git bisect found c11 after 4 tests.",
    })).toContain("Bad commit");
  });

  it("treats matching good content as good and matching bad content as bad", () => {
    expect(
      sourceVerdict({
        goodContent: "return order.safeId;",
        badContent: "return order.item.id;",
        midContent: "return order.safeId;",
      }),
    ).toBe("good");
    expect(
      sourceVerdict({
        goodContent: "return order.safeId;",
        badContent: "return order.item.id;",
        midContent: "return order.item.id;",
        needles: ["item.id"],
      }),
    ).toBe("bad");
    expect(sourceVerdict({ midContent: undefined })).toBe("skip");
  });

  it("finds the introducing commit in a tagged release window without touching HEAD", async () => {
    const dir = await createTaggedReleaseRepo();
    fixtures.push(dir);
    const headBefore = await gitHead(dir);

    const result = await runGitBisect({
      repoPath: dir,
      goodRef: "v1.0.180",
      badRef: "v1.0.181",
      crashFiles: ["src/cart.js"],
      suspects: ["item", "id"],
    });

    expect(result?.method).toBe("source");
    expect(result?.firstBad?.subject).toMatch(/unguarded item\.id/i);
    expect(result?.testsRun).toBeGreaterThan(0);
    expect(result?.testsRun).toBeLessThan(12);
    expect(await gitHead(dir)).toBe(headBefore);
    expect(result?.summary).toMatch(/Git bisect found /);
  });

  it("runs tests in a worktree and leaves the origin checkout unchanged", async () => {
    const dir = await createTaggedReleaseRepo(true);
    fixtures.push(dir);
    const headBefore = await gitHead(dir);

    const result = await runGitBisect({
      repoPath: dir,
      goodRef: "v1.0.180",
      badRef: "v1.0.181",
      testCommand: "node probe.js",
    });

    expect(result?.method).toBe("test");
    expect(result?.firstBad?.subject).toMatch(/unguarded item\.id/i);
    expect(await gitHead(dir)).toBe(headBefore);
    const status = await tryCommand("git", ["--no-pager", "status", "--porcelain"], {
      cwd: dir,
      env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
    });
    expect(status?.stdout.trim()).toBe("");
  });
});

function commitAt(index: number): GitCommit {
  return {
    sha: `c${String(index).padStart(2, "0")}000000`,
    author: "Dev",
    date: "2026-09-14",
    subject: `commit ${index}`,
  };
}

async function gitHead(cwd: string): Promise<string> {
  const result = await tryCommand("git", ["--no-pager", "rev-parse", "HEAD"], {
    cwd,
    env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
  });
  return result?.stdout.trim() ?? "";
}

async function createTaggedReleaseRepo(withProbe = false): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "debug-copilot-bisect-"));
  await mkdir(path.join(dir, "src"));
  await writeFile(
    path.join(dir, "src/cart.js"),
    `export function getPrimaryItemId(order) {
  return order.safeId;
}
`,
  );
  if (withProbe) {
    await writeFile(
      path.join(dir, "probe.js"),
      `const fs = require("fs");
const src = fs.readFileSync("src/cart.js", "utf8");
process.exit(src.includes("item.id") ? 1 : 0);
`,
    );
  }

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
