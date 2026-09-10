import { tryCommand, type CommandResult } from "../exec.js";

const pager = { GIT_PAGER: "cat", PAGER: "cat" };

export function git(
  cwd: string,
  args: string[],
  timeoutMs = 8_000,
): Promise<CommandResult | undefined> {
  return tryCommand("git", ["--no-pager", ...args], {
    cwd,
    timeoutMs,
    env: { ...process.env, ...pager },
  });
}

export function clip(text: string, max = 400): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
