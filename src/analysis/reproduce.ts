import { runCommand, truncate } from "../exec.js";
import type { BugInput, EvidenceBundle, ReproductionResult, TestEvidence } from "../types.js";

export async function reproduceBug(
  input: BugInput,
  evidence: EvidenceBundle,
  runTests: boolean,
  commandOverride?: string,
): Promise<ReproductionResult> {
  const command = commandOverride ?? selectTestCommand(input, evidence.tests);
  if (!runTests || !command) {
    return {
      attempted: false,
      reproduced: Boolean(evidence.error.message && evidence.error.message !== "No error details provided"),
      command,
      output: "",
      summary: runTests
        ? "No test runner detected; using the provided error as the reproduction."
        : "Test execution skipped; using the provided error as the reproduction.",
    };
  }

  const [bin, ...args] = splitCommand(command);
  if (!bin) {
    return {
      attempted: false,
      reproduced: true,
      output: "",
      summary: "Could not parse the test command.",
    };
  }

  let result;
  try {
    result = await runCommand(bin, args, {
      cwd: input.repoPath,
      timeoutMs: 90_000,
      env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      attempted: true,
      reproduced: false,
      command,
      output: reason,
      summary: `Could not spawn \`${command}\`: ${reason}`,
    };
  }

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

export function selectTestCommand(input: Pick<BugInput, "failingTest">, tests: TestEvidence): string | undefined {
  const base = tests.testCommand;
  if (input.failingTest) {
    if (tests.runner === "vitest") return `npx vitest run ${quote(input.failingTest)}`;
    if (tests.runner === "jest") return `npx jest ${quote(input.failingTest)}`;
    if (tests.runner === "pytest") return `pytest -q ${quote(input.failingTest)}`;
    if (tests.runner === "go-test") return `go test ${quote(input.failingTest)}`;
    if (tests.runner === "flutter-test") return `flutter test ${quote(input.failingTest)}`;
  }

  const firstRelated = tests.relatedTests[0]?.file;
  if (firstRelated && tests.runner === "vitest") {
    return `npx vitest run ${quote(firstRelated)}`;
  }
  if (firstRelated && tests.runner === "jest") {
    return `npx jest ${quote(firstRelated)}`;
  }
  if (firstRelated && tests.runner === "flutter-test") {
    return `flutter test ${quote(firstRelated)}`;
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
