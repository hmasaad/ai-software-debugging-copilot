import { readFile } from "node:fs/promises";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyEdits } from "../src/analysis/patch.js";
import type { FixProposal } from "../src/types.js";

describe("applyEdits", () => {
  it("replaces an exact string and refuses a missing one", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "debug-copilot-patch-"));
    const file = path.join(dir, "cart.js");
    await writeFile(file, "return item.price * item.qty;\n");

    const ok: FixProposal = {
      summary: "default qty",
      rationale: "NaN",
      edits: [
        {
          path: "cart.js",
          oldString: "return item.price * item.qty;",
          newString: "return item.price * (item.qty ?? 1);",
        },
      ],
      testPlan: [],
      risks: [],
      applied: false,
      applyErrors: [],
    };

    const applied = await applyEdits(dir, ok);
    expect(applied.applied).toBe(true);
    expect(await readFile(file, "utf8")).toContain("item.qty ?? 1");

    const missed = await applyEdits(dir, {
      ...ok,
      edits: [{ path: "cart.js", oldString: "does-not-exist", newString: "x" }],
    });
    expect(missed.applied).toBe(false);
    expect(missed.applyErrors[0]).toMatch(/old string not found/);
  });
});
