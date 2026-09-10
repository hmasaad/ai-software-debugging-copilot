import { tryCommand } from "../exec.js";
import type { RuntimeContext } from "../types.js";

const ENV_HINTS = [
  "CI",
  "GITHUB_ACTIONS",
  "NODE_ENV",
  "DEBUG",
  "LOG_LEVEL",
  "DATABASE_URL",
  "REDIS_URL",
];

export async function collectRuntime(repoPath: string): Promise<RuntimeContext> {
  const python = await tryCommand("python3", ["--version"], { timeoutMs: 4_000 });
  const hints = ENV_HINTS.filter((name) => Boolean(process.env[name])).map((name) => {
    const value = process.env[name] ?? "";
    const redacted = /URL|TOKEN|KEY|SECRET/i.test(name) ? "[set]" : value;
    return `${name}=${redacted}`;
  });

  return {
    os: `${process.platform}`,
    arch: process.arch,
    node: process.version,
    python: python?.code === 0 ? python.stdout.trim() || python.stderr.trim() : undefined,
    cwd: repoPath,
    ci: Boolean(process.env.CI),
    envHints: hints,
  };
}
