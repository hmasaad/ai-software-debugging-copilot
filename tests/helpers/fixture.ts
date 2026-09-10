import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../../src/exec.js";

export interface FixtureRepo {
  dir: string;
  cartPath: string;
}

export async function createCartFixture(): Promise<FixtureRepo> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "debug-copilot-"));
  await mkdir(path.join(dir, "src"));

  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "cart-fixture",
        private: true,
        type: "module",
        scripts: { test: "node --test src/cart.test.js" },
      },
      null,
      2,
    ),
  );

  const cartPath = path.join(dir, "src/cart.js");
  await writeFile(
    cartPath,
    `export function lineTotal(item) {
  return item.price * item.qty;
}

export function cartTotal(items) {
  return items.reduce((sum, item) => sum + lineTotal(item), 0);
}

export function getPrimaryItemId(order) {
  return order.item.id;
}
`,
  );

  await writeFile(
    path.join(dir, "src/crash.js"),
    `import { getPrimaryItemId } from "./cart.js";
const order = { customer: "ada" };
console.log(getPrimaryItemId(order));
`,
  );

  await writeFile(
    path.join(dir, "src/cart.test.js"),
    `import assert from "node:assert/strict";
import { test } from "node:test";
import { cartTotal } from "./cart.js";

test("defaults missing quantity to 1", () => {
  assert.equal(cartTotal([{ price: 10 }]), 10);
});
`,
  );

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
  };

  await runCommand("git", ["-c", "commit.gpgsign=false", "init"], { cwd: dir, timeoutMs: 10_000 });
  await runCommand("git", ["-c", "commit.gpgsign=false", "add", "."], { cwd: dir, timeoutMs: 10_000, env: gitEnv });
  await runCommand(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Add buggy cart total",
    ],
    {
      cwd: dir,
      timeoutMs: 10_000,
      env: gitEnv,
    },
  );

  return { dir, cartPath };
}

export async function removeFixture(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
