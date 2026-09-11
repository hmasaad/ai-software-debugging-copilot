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

export function renderSpecialistsAscii(findings: SpecialistFindings): string {
  const mark = (on: boolean) => (on ? "●" : "○");
  const lines = [
    "                 Debugging Orchestrator",
    "                          │",
    "       ┌──────────┬───────┼────────┬──────────┐",
    `       ${mark(Boolean(findings.crash))}          ${mark(Boolean(findings.network))}       ${mark(Boolean(findings.database))}        ${mark(Boolean(findings.flutter))}          ${mark(Boolean(findings.dependency))}`,
    "    Crash      Network   DB      Flutter   Dependency",
    "       │          │       │        │          │",
    "       └──────────┴───────┼────────┴──────────┘",
    "                          ↓",
    "                    Root Cause Agent",
  ];
  const notes = [
    findings.crash?.summary,
    findings.network?.summary,
    findings.database?.summary,
    findings.flutter?.summary,
    findings.dependency?.summary,
  ].filter((item): item is string => Boolean(item));
  if (notes.length) {
    lines.push("", ...notes.map((note) => `- ${note}`));
  }
  return lines.join("\n");
}

