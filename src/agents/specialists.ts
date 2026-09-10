import type { AgentId, AgentRun, SpecialistFindings } from "../types.js";
import { CrashAgent } from "./crash-agent.js";
import { DatabaseAgent } from "./database-agent.js";
import { FlutterAgent } from "./flutter-agent.js";
import { NetworkAgent } from "./network-agent.js";
import type { AgentContext } from "./types.js";

export async function runRoutedSpecialists(
  ctx: AgentContext,
  routed: AgentId[],
): Promise<{ findings: SpecialistFindings; runs: AgentRun[] }> {
  const findings: SpecialistFindings = {};
  const runs: AgentRun[] = [];
  const jobs: Array<Promise<void>> = [];

  if (routed.includes("crash-agent")) {
    jobs.push(
      new CrashAgent().run(ctx).then(({ result, run }) => {
        findings.crash = result;
        runs.push(run);
      }),
    );
  }
  if (routed.includes("network-agent")) {
    jobs.push(
      new NetworkAgent().run(ctx).then(({ result, run }) => {
        findings.network = result;
        runs.push(run);
      }),
    );
  }
  if (routed.includes("database-agent")) {
    jobs.push(
      new DatabaseAgent().run(ctx).then(({ result, run }) => {
        findings.database = result;
        runs.push(run);
      }),
    );
  }
  if (routed.includes("flutter-agent")) {
    jobs.push(
      new FlutterAgent().run(ctx).then(({ result, run }) => {
        findings.flutter = result;
        runs.push(run);
      }),
    );
  }

  await Promise.all(jobs);
  return { findings, runs };
}
