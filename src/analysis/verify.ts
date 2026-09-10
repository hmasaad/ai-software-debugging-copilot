import { runCommand, truncate } from "../exec.js";
import type { EvidenceBundle, VerificationResult } from "../types.js";

export async function verifyFix(
  repoPath: string,
  evidence: EvidenceBundle,
  runTests: boolean,
): Promise<VerificationResult> {
  if (!runTests || !evidence.tests.testCommand) {
    return {
      testsRan: false,
      passed: false,
      output: "",
      summary: "Tests were not run. Re-run with --run-tests after applying the fix to verify.",
    };
  }

  const command = evidence.tests.testCommand;
  const [bin, ...args] = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) =>
    part.replace(/^['"]|['"]$/g, ""),
  ) ?? [command];

  if (!bin) {
    return {
      testsRan: false,
      passed: false,
      output: "",
      summary: "Could not parse the test command.",
    };
  }

  const result = await runCommand(bin, args, {
    cwd: repoPath,
    timeoutMs: 120_000,
    env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
  });

  const output = truncate(`${result.stdout}\n${result.stderr}`.trim(), 12_000);
  const passed = result.code === 0;

  return {
    testsRan: true,
    passed,
    command,
    output,
    summary: passed
      ? `Fix verified: \`${command}\` passed.`
      : `Fix not verified: \`${command}\` failed with exit ${result.code}.`,
  };
}
