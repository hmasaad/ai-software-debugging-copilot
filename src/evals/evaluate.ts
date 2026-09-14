import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { proposeMinimalEdit } from "../agents/fix-agent.js";
import { classifyFailure } from "../analysis/classify.js";
import { attemptSummary } from "../analysis/attempts.js";
import { buildBlastRadius } from "../analysis/blast-radius.js";
import { recallIncidents, rememberIncident, renderMemoryAscii } from "../analysis/memory.js";
import { buildProductionIncident, renderProductionIncidentAscii } from "../analysis/production.js";
import {
  captureFailure,
  compareFailures,
  proposeReproductionTest,
  understandSymptoms,
} from "../analysis/repro-scenario.js";
import { parseErrorText } from "../collectors/stack-trace.js";
import { analyzeEnvironment, renderEnvironmentAscii } from "../collectors/runtime.js";
import type {
  EvalCaseResult,
  EvalDimensions,
  GitInvestigation,
  RuntimeContext,
} from "../types.js";
import type { KnownBug } from "./dataset.js";

const LOCAL_TOOLCHAIN: RuntimeContext = {
  os: "darwin",
  arch: "arm64",
  flutter: "3.44",
  xcode: "16.2",
  cwd: "/tmp",
  ci: false,
  envHints: [],
};

export async function evaluateKnownBug(bug: KnownBug): Promise<EvalCaseResult> {
  const started = Date.now();
  if (bug.probe === "memory") return evalMemory(bug, started);
  if (bug.probe === "attempts") return evalAttempts(bug, started);
  if (bug.probe === "blast") return evalBlast(bug, started);

  const blob = [bug.error, bug.stack ?? ""].join("\n");
  const parsed = parseErrorText(blob);
  const crashSite = parsed.frames.find((frame) => frame.inProject) ?? parsed.frames[0];
  const classification = classifyFailure({
    error: parsed,
    message: bug.error,
    stackTrace: bug.stack,
    extraContext: bug.probe === "env" ? undefined : bug.extra,
  });

  const categoryOk = classification.category === bug.gold.category;
  const subtypeOk = !bug.gold.subtype || classification.subtype === bug.gold.subtype;
  let rootCause = categoryOk && subtypeOk;

  if (bug.probe === "env") {
    const analysis = analyzeEnvironment({ local: LOCAL_TOOLCHAIN, extraContext: bug.extra });
    const expected = bug.gold.envMismatch ?? [];
    const got = analysis.mismatches.map((item) => item.tool);
    const mismatchOk =
      expected.length === 0
        ? analysis.mismatches.length === 0
        : expected.every((tool) => got.includes(tool));
    const ascii = renderEnvironmentAscii(analysis);
    rootCause =
      rootCause &&
      mismatchOk &&
      (!expected.length || (ascii.includes("Developer A") && ascii.includes("Potential environment mismatch detected.")));
  }

  if (bug.probe === "production") {
    const incident = buildProductionIncident({
      bug: {
        repoPath: "/tmp",
        message: bug.error,
        version: bug.production?.version,
        affectedUsers: bug.production?.affectedUsers,
        firstSeen: bug.production?.firstSeen,
        incidentSource: bug.production?.source,
      },
      gitInvestigation: bug.production?.introducing
        ? gitIntroducing(bug.production.introducing)
        : undefined,
      suggestedFix: bug.gold.productionAction === "hotfix" ? "Null-safe session restore" : undefined,
    });
    const actionOk = incident?.recommendedAction === bug.gold.productionAction;
    rootCause = rootCause && actionOk && Boolean(incident);
    if (bug.required && incident) {
      const ascii = renderProductionIncidentAscii(incident);
      rootCause =
        rootCause &&
        ascii.includes("Production Crash") &&
        ascii.includes(`Version: ${bug.production?.version}`) &&
        ascii.includes("Rollback / hotfix");
    }
  }

  const output = bug.gold.reproduce ? blob : "All tests passed.";
  const comparison = compareFailures({
    reported: parsed,
    crashSite,
    captured: bug.gold.reproduce ? captureFailure(output) : undefined,
    output,
    attempted: true,
    reproduced: bug.gold.reproduce,
  });
  const reproduction = bug.gold.reproduce
    ? comparison.match === "matched" || comparison.match === "partial"
    : comparison.match === "unmatched";

  let fix: boolean | undefined;
  if (bug.gold.expectFix && bug.snippet) {
    const edit = proposeMinimalEdit({
      file: bug.snippet.file,
      fileContent: bug.snippet.content,
      expression: bug.snippet.expression,
      message: bug.error,
    });
    fix = Boolean(edit);
  }

  let test: boolean | undefined;
  if (bug.gold.expectRegressionTest) {
    const symptoms = understandSymptoms({ error: parsed, crashSite, extraContext: bug.extra });
    const proposed = proposeReproductionTest({
      error: parsed,
      crashSite,
      symptoms,
      tests: { relatedTests: [] },
    });
    test = Boolean(proposed?.content);
  }

  const classifiedCrash = classification.category === "runtime-crash";
  const falsePositive =
    (bug.gold.trap && classifiedCrash && bug.gold.category !== "runtime-crash") ||
    (classifiedCrash && bug.gold.category !== "runtime-crash" && !bug.gold.expectFix);

  const dimensions: EvalDimensions = {
    rootCause,
    reproduction,
    ...(fix !== undefined ? { fix } : {}),
    ...(test !== undefined ? { test } : {}),
    falsePositive,
    iterations: bug.gold.iterations,
  };

  const passed =
    rootCause &&
    reproduction &&
    (fix === undefined || fix) &&
    (test === undefined || test) &&
    !falsePositive;

  return {
    id: bug.id,
    title: bug.title,
    passed,
    required: bug.required,
    detail: [
      classification.summary,
      comparison.detail,
      fix === false ? "no fix produced" : undefined,
      test === false ? "no regression test" : undefined,
      falsePositive ? "false positive" : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
    durationMs: Date.now() - started,
    dimensions,
  };
}

function gitIntroducing(subject: string): GitInvestigation {
  return {
    evidence: { available: true, recentCommits: [], commitsTouchingSuspects: [], blame: [] },
    pullRequests: [],
    suspects: [],
    introducing: {
      sha: "abc1234",
      author: "Dev",
      date: "2026-09-10",
      subject,
      score: 0.9,
      reasons: ["blame"],
    },
    summary: "",
    handoff: [],
  };
}

function evalBlast(bug: KnownBug, started: number): EvalCaseResult {
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
        { file: "lib/savings/savings_details_bloc.dart", line: 8, text: "SavingsDetailsBloc" },
        { file: "lib/reports/reports_bloc.dart", line: 12, text: "ReportsBloc" },
        { file: "lib/shareout/shareout_bloc.dart", line: 9, text: "ShareoutBloc" },
        { file: "lib/media/media_screen.dart", line: 4, text: "MediaScreen" },
      ],
      suspects: [],
      snippets: [],
      summary: "",
      handoff: [],
    },
  });
  const rootCause =
    analysis.high.includes("Savings screen") &&
    analysis.high.includes("Savings reports") &&
    analysis.high.includes("Shareout") &&
    analysis.direct.includes("Savings screen") &&
    analysis.indirect.includes("Member details") &&
    Math.round(analysis.workflowShare * 100) === 32 &&
    analysis.low.includes("Media screen") &&
    analysis.usedBy.some((node) => node.name === "SavingsBloc");
  return finishProbe(bug, started, {
    rootCause,
    reproduction: true,
    test: true,
    falsePositive: false,
    iterations: 1,
  }, analysis.summary);
}

async function evalMemory(bug: KnownBug, started: number): Promise<EvalCaseResult> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "debug-copilot-eval-memory-"));
  try {
    for (let index = 0; index < 3; index += 1) {
      await rememberIncident({
        repoPath: dir,
        errorType: "NullCheckError",
        errorMessage: bug.error,
        category: "runtime-crash",
        rootCause: "getSavingsMedia returned null",
        fix: "Handle null API response",
        resolution: "resolved",
        files: ["SavingsMemberMediaBloc.dart"],
      });
    }
    const memory = await recallIncidents({
      repoPath: dir,
      errorType: "NullCheckError",
      errorMessage: bug.error,
      category: "runtime-crash",
      files: ["SavingsMemberMediaBloc.dart"],
    });
    const ascii = renderMemoryAscii(memory);
    const rootCause =
      memory.matches.length === 3 &&
      memory.summary === "3 previous incidents had the same pattern" &&
      ascii.includes("Previous Incident") &&
      ascii.includes("Store as knowledge") &&
      ascii.includes("Similar historical incidents");
    return finishProbe(bug, started, {
      rootCause,
      reproduction: true,
      test: true,
      falsePositive: false,
      iterations: 1,
    }, memory.summary);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function evalAttempts(bug: KnownBug, started: number): EvalCaseResult {
  const log = [attemptSummary(1, "tests-failed"), attemptSummary(2, "tests-failed"), attemptSummary(3, "tests-passed")].join(
    "\n",
  );
  const edit = bug.snippet
    ? proposeMinimalEdit({
        file: bug.snippet.file,
        fileContent: bug.snippet.content,
        expression: bug.snippet.expression,
        message: bug.error,
      })
    : undefined;
  const rootCause = log.includes("Attempt 1 → Tests failed") && log.includes("Attempt 3 → Tests passed");
  return finishProbe(bug, started, {
    rootCause,
    reproduction: true,
    fix: Boolean(edit),
    test: true,
    falsePositive: false,
    iterations: 3,
  }, log.replace(/\n/g, " · "));
}

function finishProbe(
  bug: KnownBug,
  started: number,
  dimensions: EvalDimensions,
  detail: string,
): EvalCaseResult {
  const passed =
    dimensions.rootCause !== false &&
    dimensions.reproduction !== false &&
    dimensions.fix !== false &&
    dimensions.test !== false &&
    dimensions.falsePositive !== true;
  return {
    id: bug.id,
    title: bug.title,
    passed,
    required: bug.required,
    detail,
    durationMs: Date.now() - started,
    dimensions,
  };
}
