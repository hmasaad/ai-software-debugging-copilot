import { runCommand, truncate } from "../exec.js";
import type { BugInput, EvidenceBundle, ReproductionResult } from "../types.js";

export async function reproduceBug(
  input: BugInput,
  evidence: EvidenceBundle,
  runTests: boolean,
): Promise<ReproductionResult> {
  if (!runTests || !evidence.tests.testCommand) {
    return {
      attempted: false,
      reproduced: Boolean(evidence.error.message && evidence.error.message !== "No error details provided"),
      output: "",
      summary: runTests
        ? "No test runner detected; using the provided error as the reproduction."
        : "Test execution skipped; using the provided error as the reproduction.",
    };
  }

  const command = selectTestCommand(input, evidence);
  const [bin, ...args] = splitCommand(command);
  if (!bin) {
    return {
      attempted: false,
      reproduced: true,
      output: "",
      summary: "Could not parse the test command.",
    };
  }
  const result = await runCommand(bin, args, {
    cwd: input.repoPath,
    timeoutMs: 90_000,
    env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
  });

  const output = truncate(`${result.stdout}\n${result.stderr}`.trim(), 12_000);
  const reproduced = result.code !== 0;

  return {
    attempted: true,
    reproduced,
    command,
    exitCode: result.code,
    output,
    summary: reproduced
      ? `Reproduced: \`${command}\` failed with exit ${result.code}.`
      : `Could not reproduce: \`${command}\` exited 0. The reported error may be environmental or already fixed.`,
  };
}

function selectTestCommand(input: BugInput, evidence: EvidenceBundle): string {
  const base = evidence.tests.testCommand ?? "npm test --silent";
  if (input.failingTest) {
    if (evidence.tests.runner === "vitest") return `npx vitest run ${quote(input.failingTest)}`;
    if (evidence.tests.runner === "jest") return `npx jest ${quote(input.failingTest)}`;
    if (evidence.tests.runner === "pytest") return `pytest -q ${quote(input.failingTest)}`;
    if (evidence.tests.runner === "go-test") return `go test ${quote(input.failingTest)}`;
  }

  const firstRelated = evidence.tests.relatedTests[0]?.file;
  if (firstRelated && evidence.tests.runner === "vitest") {
    return `npx vitest run ${quote(firstRelated)}`;
  }
  if (firstRelated && evidence.tests.runner === "jest") {
    return `npx jest ${quote(firstRelated)}`;
  }

  return base;
}

function splitCommand(command: string): string[] {
  const match = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [command];
  return match.map((part) => part.replace(/^['"]|['"]$/g, ""));
}

function quote(file: string): string {
  return file.includes(" ") ? `"${file}"` : file;
}
