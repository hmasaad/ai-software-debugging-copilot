import { readdir } from "node:fs/promises";
import path from "node:path";
import { tryCommand } from "../exec.js";
import { applyEdits } from "../analysis/patch.js";
import { collectTests } from "../collectors/tests.js";
import type { BugInput, FixProposal, SandboxAction, SandboxTool } from "../types.js";
import { clip, git } from "./git.js";
import type { Sandbox } from "./worktree.js";

export class SandboxTools {
  readonly actions: SandboxAction[] = [];

  constructor(private readonly sandbox: Sandbox) {}

  async inspectRepo(): Promise<SandboxAction> {
    const [head, branch, status, entries] = await Promise.all([
      git(this.sandbox.path, ["rev-parse", "--short", "HEAD"]),
      git(this.sandbox.path, ["rev-parse", "--abbrev-ref", "HEAD"]),
      git(this.sandbox.path, ["status", "--short"]),
      readdir(this.sandbox.path).catch(() => [] as string[]),
    ]);
    const top = entries.filter((name) => !name.startsWith(".")).slice(0, 12).join(", ");
    const detail = `kind=${this.sandbox.kind} HEAD=${head?.stdout.trim() || "n/a"} branch=${branch?.stdout.trim() || "detached"} files=${top || "none"} status=${clip(status?.stdout || "clean", 160)}`;
    return this.record("inspect-repo", detail, true);
  }

  async searchCode(input: BugInput): Promise<SandboxAction> {
    const tokens = searchTokens(input);
    if (tokens.length === 0) return this.record("search-code", "No search tokens in the error", false);

    const hits: string[] = [];
    for (const token of tokens.slice(0, 6)) {
      const grep = await git(
        this.sandbox.path,
        ["grep", "-n", "-I", "-F", token, "--", "*.js", "*.jsx", "*.ts", "*.tsx", "*.mjs", "*.cjs", "*.py", "*.go", "*.java", "*.dart"],
        10_000,
      );
      if (!grep || grep.code !== 0 || !grep.stdout.trim()) continue;
      const lines = grep.stdout.trim().split("\n").slice(0, 4);
      hits.push(`${token}: ${lines.join(" | ")}`);
    }
    return this.record(
      "search-code",
      hits.length ? clip(hits.join(" · "), 500) : `No matches for ${tokens.slice(0, 4).join(", ")}`,
      hits.length > 0,
    );
  }

  async inspectGit(input: BugInput): Promise<SandboxAction> {
    const log = await git(this.sandbox.path, ["log", "-8", "--format=%h %ad %s", "--date=short"], 10_000);
    const tokens = searchTokens(input).slice(0, 3);
    const pickaxe: string[] = [];
    for (const token of tokens) {
      const result = await git(
        this.sandbox.path,
        ["log", "-4", "-S", token, "--format=%h %s", "--", "."],
        10_000,
      );
      if (result?.stdout.trim()) pickaxe.push(`${token} → ${clip(result.stdout, 180)}`);
    }
    const recent = clip(log?.stdout.replace(/\n/g, " · ") || "no git history", 280);
    const detail = pickaxe.length ? `${recent} | pickaxe: ${pickaxe.join(" ; ")}` : recent;
    return this.record("inspect-git", detail, Boolean(log && log.code === 0));
  }

  async runTests(command?: string, timeoutMs = 60_000): Promise<SandboxAction> {
    const cmd = command ?? (await defaultTestCommand(this.sandbox.path));
    if (!cmd) return this.record("run-tests", "No test runner detected", false);
    const [bin, ...args] = splitCommand(cmd);
    const result = await tryCommand(bin, args, { cwd: this.sandbox.path, timeoutMs });
    if (!result) return this.record("run-tests", `Failed to spawn ${cmd}`, false);
    const ok = true;
    const detail = `${cmd} exited ${result.code}: ${clip(result.stdout || result.stderr, 280)}`;
    return this.record("run-tests", detail, ok);
  }

  async reproduce(command?: string): Promise<SandboxAction> {
    const action = await this.runTests(command);
    const reproduced = /\b(Error|Exception|FAIL|failed|AssertionError|NaN)\b/i.test(action.detail) || /exited [1-9]/.test(action.detail);
    return this.record("reproduce", reproduced ? `Reproduced: ${action.detail}` : action.detail, action.ok);
  }

  async modifyCode(proposal: FixProposal): Promise<SandboxAction> {
    if (proposal.edits.length === 0) {
      return this.record("modify-code", "No edits to apply", false);
    }
    const applied = await applyEdits(this.sandbox.path, proposal);
    const files = applied.edits.map((edit) => edit.path).join(", ");
    return this.record(
      "modify-code",
      applied.applied ? `Patched ${files}` : `Patch failed: ${applied.applyErrors.join("; ") || files}`,
      applied.applied,
    );
  }

  async inspectDiff(): Promise<{ action: SandboxAction; diff: string }> {
    const diff = await git(this.sandbox.path, ["diff", "--", "."], 10_000);
    const status = await git(this.sandbox.path, ["status", "--short", "--", "."]);
    const text = [diff?.stdout.trim(), status?.stdout.trim()].filter(Boolean).join("\n") || "";
    const action = this.record(
      "inspect-diff",
      text ? clip(text, 500) : "Working tree clean",
      true,
    );
    return { action, diff: text };
  }

  async revert(): Promise<SandboxAction> {
    let restore = await git(this.sandbox.path, ["restore", "--source=HEAD", "--worktree", "--staged", "--", "."]);
    if (!restore || restore.code !== 0) {
      restore = await git(this.sandbox.path, ["checkout", "--", "."]);
    }
    const clean = await git(this.sandbox.path, ["clean", "-fd", "-e", "node_modules", "-e", ".dart_tool"]);
    const ok = Boolean(restore && restore.code === 0);
    return this.record("revert", ok ? `Restored sandbox to HEAD${clean?.stdout.trim() ? `; cleaned ${clip(clean.stdout, 120)}` : ""}` : "Could not restore sandbox", ok);
  }

  observe(tool: SandboxTool, detail: string, ok: boolean): SandboxAction {
    return this.record(tool, detail, ok);
  }

  private record(tool: SandboxTool, detail: string, ok: boolean): SandboxAction {
    const action = { tool, detail, ok };
    this.actions.push(action);
    return action;
  }
}

export function searchTokens(input: BugInput): string[] {
  const blob = [input.message, input.stackTrace, input.logText, input.extraContext, input.failingTest]
    .filter(Boolean)
    .join("\n");
  const tokens = new Set<string>();
  for (const match of blob.matchAll(/([\w./\\-]+\.(?:dart|js|jsx|ts|tsx|mjs|cjs|py|go|java|kt|rs))/g)) {
    const base = path.basename(match[1] ?? "");
    if (base) tokens.add(base);
  }
  for (const match of blob.matchAll(/\b([A-Z][A-Za-z0-9_]{3,})\b/g)) {
    if (match[1]) tokens.add(match[1]);
  }
  for (const match of blob.matchAll(/\b([a-z][A-Za-z0-9_]{4,})\b/g)) {
    const word = match[1] ?? "";
    if (word.length >= 6 && !["cannot", "reading", "properties", "undefined", "operator"].includes(word)) {
      tokens.add(word);
    }
  }
  return [...tokens].slice(0, 12);
}

async function defaultTestCommand(repoPath: string): Promise<string | undefined> {
  const evidence = await collectTests(repoPath, []);
  return evidence.testCommand;
}

function splitCommand(command: string): [string, ...string[]] {
  const parts = command.trim().split(/\s+/);
  return [parts[0] ?? "npm", ...parts.slice(1)];
}
