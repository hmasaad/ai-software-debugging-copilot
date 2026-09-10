import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SandboxKind } from "../types.js";
import { git } from "./git.js";

export interface Sandbox {
  originRepo: string;
  gitRoot: string;
  path: string;
  kind: SandboxKind;
  destroy(): Promise<void>;
}

export async function createSandbox(originRepo: string): Promise<Sandbox> {
  const origin = resolveReal(originRepo);
  const gitRoot = await detectGitRoot(origin);
  const sandboxPath = path.join(os.tmpdir(), `debug-copilot-sandbox-${randomBytes(6).toString("hex")}`);

  if (gitRoot) {
    const worktree = await git(gitRoot, ["worktree", "add", "--detach", sandboxPath, "HEAD"], 30_000);
    if (worktree && worktree.code === 0) {
      await copyDirtyFiles(gitRoot, origin, sandboxPath);
      return makeSandbox(origin, gitRoot, sandboxPath, "worktree");
    }

    const clone = await git(gitRoot, ["clone", "--local", "--no-hardlinks", gitRoot, sandboxPath], 60_000);
    if (clone && clone.code === 0) {
      await copyDirtyFiles(gitRoot, origin, sandboxPath);
      return makeSandbox(origin, gitRoot, sandboxPath, "clone");
    }
  }

  await mkdir(sandboxPath, { recursive: true });
  await cp(origin, sandboxPath, { recursive: true, filter: skipHeavy });
  return makeSandbox(origin, gitRoot ?? origin, sandboxPath, "copy");
}

function makeSandbox(originRepo: string, gitRoot: string, sandboxPath: string, kind: SandboxKind): Sandbox {
  let destroyed = false;
  return {
    originRepo,
    gitRoot,
    path: sandboxPath,
    kind,
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      if (kind === "worktree") {
        const removed = await git(gitRoot, ["worktree", "remove", "--force", sandboxPath], 30_000);
        if (!removed || removed.code !== 0) {
          await rm(sandboxPath, { recursive: true, force: true });
          await git(gitRoot, ["worktree", "prune"], 15_000);
        }
        return;
      }
      await rm(sandboxPath, { recursive: true, force: true });
    },
  };
}

async function detectGitRoot(cwd: string): Promise<string | undefined> {
  const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!result || result.code !== 0) return undefined;
  const root = result.stdout.trim();
  return root ? resolveReal(root) : undefined;
}

async function copyDirtyFiles(gitRoot: string, origin: string, sandboxPath: string): Promise<void> {
  const status = await git(gitRoot, ["status", "--porcelain", "-uall", "--", "."], 10_000);
  if (!status || status.code !== 0 || !status.stdout.trim()) return;

  for (const raw of status.stdout.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    const rel = line.slice(3).trim().replace(/^"/, "").replace(/"$/, "");
    if (!rel || rel.includes("node_modules")) continue;
    const from = path.join(gitRoot, rel);
    const to = path.join(sandboxPath, rel);
    if (!from.startsWith(origin) && !from.startsWith(gitRoot)) continue;
    if (!existsSync(from)) continue;
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to, { recursive: true });
  }
}

function skipHeavy(src: string): boolean {
  const base = path.basename(src);
  if (base === "node_modules" || base === "dist" || base === ".dart_tool" || base === "build") return false;
  return true;
}

export function resolveReal(p: string): string {
  const resolved = path.resolve(p);
  try {
    if (existsSync(resolved)) return realpathSync(resolved);
    const parent = path.dirname(resolved);
    if (existsSync(parent)) return path.join(realpathSync(parent), path.basename(resolved));
  } catch {
    return resolved;
  }
  return resolved;
}

export function pathAliases(p: string): string[] {
  const aliases = new Set<string>([p, path.resolve(p)]);
  try {
    aliases.add(resolveReal(p));
  } catch {
    /* ignore */
  }
  for (const alias of [...aliases]) {
    if (alias.startsWith("/private/var/")) aliases.add(alias.slice("/private".length));
    if (alias.startsWith("/var/")) aliases.add(`/private${alias}`);
  }
  return [...aliases].sort((a, b) => b.length - a.length);
}
