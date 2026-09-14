import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectFirstBadVersion,
  displayVersion,
  investigateFirstBadVersion,
  parseVersionHealth,
  previousPatch,
  renderFirstBadVersionAscii,
} from "../src/analysis/first-bad-version.js";
import { runCommand } from "../src/exec.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const healthTimeline = [
  "v1.0.180 → healthy",
  "v1.0.181 → crashes",
  "v1.0.182 → crashes",
].join("\n");

describe("first bad version", () => {
  it("parses a healthy → crashing version timeline", () => {
    const versions = parseVersionHealth(healthTimeline);
    expect(versions).toEqual([
      { version: "1.0.180", status: "healthy", source: "reported" },
      { version: "1.0.181", status: "crashes", source: "reported" },
      { version: "1.0.182", status: "crashes", source: "reported" },
    ]);
  });

  it("names v1.0.181 as the first known bad version", () => {
    const result = detectFirstBadVersion({ extraContext: healthTimeline, commitCount: 12 });
    expect(result?.lastHealthy).toBe("1.0.180");
    expect(result?.firstBad).toBe("1.0.181");
    expect(result?.laterBad).toEqual(["1.0.182"]);
    expect(result?.commitCount).toBe(12);
    expect(result?.inferredLastHealthy).toBe(false);
    expect(result?.summary).toBe(
      "v1.0.181 is the first known bad version. Investigate the 12 commits between v1.0.180 and v1.0.181.",
    );
    expect(renderFirstBadVersionAscii(result!)).toBe(
      ["v1.0.180", "   ↓", "12 commits", "   ↓", "v1.0.181", "   ↓", "Crash begins"].join("\n"),
    );
  });

  it("infers the previous patch when only crashing versions are listed", () => {
    const result = detectFirstBadVersion({
      extraContext: "v1.0.181 → crashes\nv1.0.182 → crashes",
    });
    expect(result?.firstBad).toBe("1.0.181");
    expect(result?.lastHealthy).toBe("1.0.180");
    expect(result?.inferredLastHealthy).toBe(true);
    expect(previousPatch("1.0.181")).toBe("1.0.180");
    expect(displayVersion("1.0.181")).toBe("v1.0.181");
  });

  it("does not invent a first-bad version from --version alone", () => {
    expect(detectFirstBadVersion({ current: "1.0.181" })).toBeUndefined();
  });

  it("reads JSON version health and a commit-count note", () => {
    const result = detectFirstBadVersion({
      extraContext: JSON.stringify({
        versions: [
          { version: "v1.0.180", healthy: true },
          { version: "1.0.181", status: "crashes" },
          { version: "1.0.182", crashes: true },
        ],
      }),
    });
    expect(result?.firstBad).toBe("1.0.181");
    expect(result?.lastHealthy).toBe("1.0.180");
    expect(result?.laterBad).toEqual(["1.0.182"]);

    const counted = detectFirstBadVersion({
      extraContext: `${healthTimeline}\n12 commits between 1.0.180 and 1.0.181`,
    });
    expect(counted?.commitCount).toBe(12);
  });

  it("lists the 12 commits between last healthy and first bad tags", async () => {
    const dir = await createTaggedReleaseRepo();
    fixtures.push(dir);

    const result = await investigateFirstBadVersion({
      repoPath: dir,
      extraContext: healthTimeline,
      version: "1.0.181",
    });

    expect(result?.firstBad).toBe("1.0.181");
    expect(result?.lastHealthy).toBe("1.0.180");
    expect(result?.commitCount).toBe(12);
    expect(result?.commits).toHaveLength(12);
    expect(result?.commits.at(-1)?.subject).toMatch(/unguarded item\.id/i);
    expect(renderFirstBadVersionAscii(result!)).toBe(
      ["v1.0.180", "   ↓", "12 commits", "   ↓", "v1.0.181", "   ↓", "Crash begins"].join("\n"),
    );
  });
});

async function createTaggedReleaseRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "debug-copilot-first-bad-"));
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
