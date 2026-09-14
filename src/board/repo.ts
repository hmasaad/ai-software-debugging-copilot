import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../exec.js";

export interface ResolvedRepo {
  repoPath: string;
  source: "local" | "clone";
  warning?: string;
}

export async function resolveInvestigationRepo(input: string): Promise<ResolvedRepo> {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Repo path or GitHub URL is required.");

  const local = expandHome(trimmed);
  if (existsSync(local)) {
    const repoPath = path.resolve(local);
    const git = existsSync(path.join(repoPath, ".git"));
    return {
      repoPath,
      source: "local",
      ...(git ? {} : { warning: "This folder is not a git checkout; git history will be limited." }),
    };
  }

  const cloneUrl = parseGithubUrl(trimmed);
  if (!cloneUrl) {
    throw new Error(
      `No local folder at ${local}. For a private repo, clone it first and paste that path. Public github.com URLs can be cloned automatically.`,
    );
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), "debug-copilot-repo-"));
  const result = await runCommand("git", ["clone", "--depth", "200", cloneUrl, dir], { timeoutMs: 180_000 });
  if (result.code !== 0) {
    throw new Error(
      `Could not clone ${cloneUrl}. Private repos must be cloned locally first, then paste the folder path.\n${(result.stderr || result.stdout).trim()}`,
    );
  }
  return { repoPath: dir, source: "clone" };
}

export function parseGithubUrl(value: string): string | undefined {
  const ssh = value.trim().match(/^git@github\.com:([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  if (ssh?.[1]) return `https://github.com/${ssh[1].replace(/\.git$/, "")}.git`;
  try {
    const url = new URL(value.trim());
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return undefined;
    const parts = url.pathname.replace(/^\//, "").split("/").filter(Boolean);
    const owner = parts[0];
    const repo = parts[1]?.replace(/\.git$/, "");
    if (!owner || !repo) return undefined;
    return `https://github.com/${owner}/${repo}.git`;
  } catch {
    return undefined;
  }
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}
