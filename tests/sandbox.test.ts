import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createSandbox, SandboxTools } from "../src/sandbox/index.js";
import { createCartFixture, removeFixture } from "./helpers/fixture.js";

const fixtures: string[] = [];
const sandboxes: Array<{ destroy(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.destroy()));
  await Promise.all(fixtures.splice(0).map((dir) => removeFixture(dir)));
});

describe("sandbox", () => {
  it("inspects, edits, diffs, and reverts without touching the origin repo", async () => {
    const fixture = await createCartFixture();
    fixtures.push(fixture.dir);
    const originBefore = await readFile(fixture.cartPath, "utf8");

    const sandbox = await createSandbox(fixture.dir);
    sandboxes.push(sandbox);
    expect(["worktree", "clone", "copy"]).toContain(sandbox.kind);

    const tools = new SandboxTools(sandbox);
    const inspected = await tools.inspectRepo();
    expect(inspected.ok).toBe(true);

    const search = await tools.searchCode({
      repoPath: fixture.dir,
      message: "TypeError",
      stackTrace: "at lineTotal (src/cart.js:2:3)",
    });
    expect(search.ok).toBe(true);
    expect(search.detail).toMatch(/cart\.js/);

    const git = await tools.inspectGit({
      repoPath: fixture.dir,
      message: "lineTotal",
      stackTrace: "src/cart.js:2",
    });
    expect(git.ok).toBe(true);

    const sandboxCart = `${sandbox.path}/src/cart.js`;
    await writeFile(sandboxCart, `${originBefore}\n// sandbox-only change\n`);
    const { diff } = await tools.inspectDiff();
    expect(diff).toContain("sandbox-only change");

    const reverted = await tools.revert();
    expect(reverted.ok).toBe(true);
    expect(await readFile(sandboxCart, "utf8")).toBe(originBefore);
    expect(await readFile(fixture.cartPath, "utf8")).toBe(originBefore);
    expect(originBefore).not.toContain("sandbox-only change");
  });
});
