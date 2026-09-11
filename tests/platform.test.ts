import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attemptSummary, renderAttemptLog } from "../src/analysis/attempts.js";
import { buildBlastRadius, renderBlastRadiusAscii } from "../src/analysis/blast-radius.js";
import { analyzeEnvironment } from "../src/collectors/runtime.js";
import { recallIncidents, rememberIncident, renderMemoryAscii } from "../src/analysis/memory.js";
import { buildProductionIncident, renderProductionIncidentAscii } from "../src/analysis/production.js";
import { FlutterAgent } from "../src/agents/flutter-agent.js";
import { mkdir, writeFile } from "node:fs/promises";
import { runCommand } from "../src/exec.js";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("patch loop", () => {
  it("renders attempt 1 failed through attempt 3 passed", () => {
    const log = renderAttemptLog([
      {
        index: 0,
        attempt: 1,
        outcome: "tests-failed",
        summary: attemptSummary(1, "tests-failed"),
        rootCause: {
          summary: "",
          rootCause: "",
          confidence: 0,
          hypotheses: [],
          affectedFiles: [],
          reproSteps: [],
          investigator: "heuristic",
        },
        fix: { summary: "", rationale: "", edits: [], testPlan: [], risks: [], applied: false, applyErrors: [] },
        verification: { testsRan: true, passed: false, output: "", summary: "" },
      },
      {
        index: 1,
        attempt: 2,
        outcome: "tests-failed",
        summary: attemptSummary(2, "tests-failed"),
        rootCause: {
          summary: "",
          rootCause: "",
          confidence: 0,
          hypotheses: [],
          affectedFiles: [],
          reproSteps: [],
          investigator: "heuristic",
        },
        fix: { summary: "", rationale: "", edits: [], testPlan: [], risks: [], applied: false, applyErrors: [] },
        verification: { testsRan: true, passed: false, output: "", summary: "" },
      },
      {
        index: 2,
        attempt: 3,
        outcome: "tests-passed",
        summary: attemptSummary(3, "tests-passed"),
        rootCause: {
          summary: "",
          rootCause: "",
          confidence: 0,
          hypotheses: [],
          affectedFiles: [],
          reproSteps: [],
          investigator: "heuristic",
        },
        fix: { summary: "", rationale: "", edits: [], testPlan: [], risks: [], applied: false, applyErrors: [] },
        verification: { testsRan: true, passed: true, output: "", summary: "" },
      },
    ]);
    expect(log).toContain("Attempt 1 → Tests failed");
    expect(log).toContain("Attempt 2 → Tests failed");
    expect(log).toContain("Attempt 3 → Tests passed");
  });
});

describe("blast radius", () => {
  it("lists high-impact blocs and low-impact media", () => {
    const analysis = buildBlastRadius({
      codeInvestigation: {
        origin: {
          file: "lib/savings/savings_repository.dart",
          functionName: "SavingsRepository",
          raw: "",
          inProject: true,
        },
        trace: [],
        functions: [],
        callers: [
          { file: "lib/savings/savings_bloc.dart", line: 10, text: "SavingsBloc(this.repository)" },
          { file: "lib/reports/reports_bloc.dart", line: 12, text: "ReportsBloc" },
          { file: "lib/media/media_screen.dart", line: 4, text: "MediaScreen" },
        ],
        suspects: [],
        snippets: [],
        summary: "",
        handoff: [],
      },
    });
    expect(analysis.origin).toBe("SavingsRepository");
    expect(analysis.high).toEqual(expect.arrayContaining(["Savings screen", "Savings reports"]));
    expect(analysis.low).toContain("Media screen");
    expect(renderBlastRadiusAscii(analysis)).toContain("What else could this change break?");
    expect(renderBlastRadiusAscii(analysis)).toContain("Potential blast radius:");
  });
});

describe("environment", () => {
  it("detects Flutter and Xcode mismatches", () => {
    const analysis = analyzeEnvironment({
      local: {
        os: "darwin",
        arch: "arm64",
        flutter: "3.44",
        xcode: "16.2",
        cwd: "/tmp",
        ci: false,
        envHints: [],
      },
      extraContext: "Flutter 3.27\nXcode 15.1",
    });
    expect(analysis.mismatches.map((item) => item.tool).sort()).toEqual(["flutter", "xcode"]);
    expect(analysis.summary).toMatch(/mismatch/i);
  });
});

describe("debugging memory", () => {
  it("recalls previous incidents with the same pattern", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "debug-memory-"));
    fixtures.push(dir);
    await rememberIncident({
      repoPath: dir,
      errorType: "NullCheckError",
      errorMessage: "Null check operator used on a null value",
      category: "runtime-crash",
      rootCause: "Null API response",
      fix: "Handle null",
      resolution: "resolved",
      files: ["SavingsMemberMediaBloc.dart"],
    });
    const memory = await recallIncidents({
      repoPath: dir,
      errorType: "NullCheckError",
      errorMessage: "Null check operator used on a null value",
      category: "runtime-crash",
      files: ["SavingsMemberMediaBloc.dart"],
    });
    expect(memory.matches.length).toBeGreaterThan(0);
    expect(memory.summary).toMatch(/previous incident/i);
    expect(renderMemoryAscii(memory)).toContain("Previous Incident");
    expect(renderMemoryAscii(memory)).toContain("Store as knowledge");
  });
});

describe("production incident", () => {
  it("recommends rollback when many users and a recent commit exist", () => {
    const incident = buildProductionIncident({
      bug: {
        repoPath: "/tmp",
        version: "1.0.181",
        affectedUsers: 327,
        firstSeen: "14:32 UTC",
        incidentSource: "crashlytics",
      },
      gitInvestigation: {
        evidence: { available: true, recentCommits: [], commitsTouchingSuspects: [], blame: [] },
        pullRequests: [],
        suspects: [],
        introducing: {
          sha: "abc1234",
          author: "Dev",
          date: "2026-09-10",
          subject: "Recent Firebase initialization change",
          score: 0.9,
          reasons: ["blame"],
        },
        summary: "",
        handoff: [],
      },
    });
    expect(incident?.recommendedAction).toBe("rollback");
    expect(Math.round((incident?.confidence ?? 0) * 100)).toBe(91);
    expect(renderProductionIncidentAscii(incident!)).toContain("Version: 1.0.181");
    expect(renderProductionIncidentAscii(incident!)).toContain("Affected users: 327");
    expect(renderProductionIncidentAscii(incident!)).toContain("Firebase initialization");
    expect(renderProductionIncidentAscii(incident!)).toContain("Confidence: 91%");
    expect(renderProductionIncidentAscii(incident!)).toContain("Rollback / hotfix");
  });
});

describe("Flutter agent", () => {
  it("detects Bloc, Dio, and Drift from pubspec and dart sources", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "debug-flutter-"));
    fixtures.push(dir);
    await writeFile(
      path.join(dir, "pubspec.yaml"),
      `name: savings
dependencies:
  flutter:
    sdk: flutter
  flutter_bloc: ^8.0.0
  dio: ^5.0.0
  drift: ^2.0.0
  get_it: ^7.0.0
`,
    );
    await mkdir(path.join(dir, "lib"));
    await writeFile(
      path.join(dir, "lib/savings_bloc.dart"),
      `class SavingsBloc extends Bloc<Event, State> {
  final Dio dio;
}
`,
    );
    await runCommand("git", ["-c", "commit.gpgsign=false", "init"], { cwd: dir, timeoutMs: 8_000 });
    await runCommand("git", ["-c", "commit.gpgsign=false", "add", "."], { cwd: dir, timeoutMs: 8_000 });
    const analysis = await new FlutterAgent().analyze(dir);
    expect(analysis.usesBloc).toBe(true);
    expect(analysis.usesDio).toBe(true);
    expect(analysis.usesDrift).toBe(true);
    expect(analysis.usesDi).toBe(true);
    expect(analysis.blocs).toContain("SavingsBloc");
  });
});
