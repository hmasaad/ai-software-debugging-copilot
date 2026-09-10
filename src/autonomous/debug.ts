import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { applyEdits } from "../analysis/patch.js";
import { debugBug } from "../pipeline.js";
import { writeReports } from "../report/markdown.js";
import { createSandbox, pathAliases, SandboxTools } from "../sandbox/index.js";
import type { AutonomousDebugResult, BugInput, DebuggingReport, PipelineEvent, PipelineOptions } from "../types.js";

export async function debugAutonomously(input: BugInput, options: PipelineOptions): Promise<AutonomousDebugResult> {
  const originRepo = path.resolve(options.repoPath || input.repoPath);
  const emit = (event: PipelineEvent) => options.onEvent?.(event);

  emit({ stage: "sandbox", agent: "Sandbox", message: "Creating isolated workspace (will not touch production code)..." });
  const sandbox = await createSandbox(originRepo);
  const tools = new SandboxTools(sandbox);
  const promote = Boolean(options.apply);
  let promoted = false;
  let reverted = false;
  let diff = "";
  let report: DebuggingReport | undefined;

  try {
    emit({ stage: "sandbox", agent: "Sandbox", message: "Inspect repository" });
    await tools.inspectRepo();

    emit({ stage: "sandbox", agent: "Sandbox", message: "Search code" });
    await tools.searchCode(input);

    emit({ stage: "sandbox", agent: "Sandbox", message: "Inspect git history" });
    await tools.inspectGit(input);

    const runTests = options.runTests !== false;
    if (runTests) {
      emit({ stage: "sandbox", agent: "Sandbox", message: "Reproduce error" });
      await tools.reproduce();
    } else {
      tools.observe("reproduce", "Skipped live reproduction (--no-run-tests)", true);
    }

    const sandboxedInput = await remapInput(input, originRepo, sandbox.path);

    emit({ stage: "autonomous", agent: "Sandbox", message: "Investigate, patch, and validate inside the sandbox..." });
    report = await debugBug(sandboxedInput, {
      ...options,
      repoPath: sandbox.path,
      apply: true,
      autonomous: true,
      reportPath: undefined,
      jsonReportPath: undefined,
    });

    const patched = report.proposedFix.applied && report.proposedFix.edits.length > 0;
    tools.observe(
      "modify-code",
      patched
        ? `Applied ${report.proposedFix.edits.length} edit(s): ${report.proposedFix.edits.map((edit) => edit.path).join(", ")}`
        : report.proposedFix.edits.length
          ? `Edits proposed but not applied: ${report.proposedFix.applyErrors.join("; ") || "unknown"}`
          : "No patch generated",
      patched,
    );

    emit({ stage: "sandbox", agent: "Sandbox", message: "Inspect diff" });
    const inspected = await tools.inspectDiff();
    diff = inspected.diff;

    const validated = report.validationAnalysis.resolved || report.validationAnalysis.verdict === "likely-resolved";
    if (!validated && patched) {
      emit({ stage: "sandbox", agent: "Sandbox", message: "Validation failed; reverting sandbox changes" });
      await tools.revert();
      reverted = true;
      report.proposedFix = { ...report.proposedFix, applied: false };
      report.notes = [
        ...report.notes,
        "Autonomous debugger reverted the sandbox because validation did not confirm a fix.",
      ];
    }

    if (validated && patched && promote) {
      emit({
        stage: "autonomous",
        agent: "Sandbox",
        message: "Validation passed; promoting patch to the original repository",
      });
      const promotedFix = await applyEdits(originRepo, { ...report.proposedFix, applied: false, applyErrors: [] });
      promoted = promotedFix.applied;
      report.proposedFix = promotedFix;
      report.notes = [
        ...report.notes.filter((note) => !note.includes("Edits were not applied")),
        promoted
          ? "Autonomous debugger promoted the validated patch to the original repository."
          : `Promotion failed: ${promotedFix.applyErrors.join("; ")}`,
      ];
    } else if (validated && patched && !promote) {
      report.notes = [
        ...report.notes.filter((note) => !note.includes("Edits were not applied")),
        "Fix validated in the sandbox only. Re-run with --apply to promote the patch.",
      ];
      report.proposedFix = { ...report.proposedFix, applied: false };
    }

    report.repoPath = originRepo;
    report.sandbox = {
      originRepo,
      path: sandbox.path,
      kind: sandbox.kind,
      promoted,
      reverted,
      actions: tools.actions,
    };
    if (options.keepSandbox) {
      report.notes = [...report.notes, `Sandbox kept at ${sandbox.path}`];
    }

    emit({ stage: "report", message: "Writing debugging report..." });
    await writeReports(report, {
      markdownPath: options.reportPath,
      jsonPath: options.jsonReportPath,
    });

    return {
      report,
      originRepo,
      sandboxPath: sandbox.path,
      sandboxKind: sandbox.kind,
      promoted,
      reverted,
      diff,
      actions: tools.actions,
    };
  } finally {
    if (!options.keepSandbox) {
      emit({ stage: "sandbox", agent: "Sandbox", message: "Destroying isolated workspace" });
      await sandbox.destroy();
    }
  }
}

async function remapInput(input: BugInput, origin: string, sandbox: string): Promise<BugInput> {
  const rewrite = (text?: string) => (text ? rewritePaths(text, origin, sandbox) : undefined);
  let logText = rewrite(input.logText);
  const logPath = input.logPath
    ? path.isAbsolute(input.logPath)
      ? input.logPath
      : path.resolve(origin, input.logPath)
    : undefined;

  if (logPath && existsSync(logPath)) {
    const raw = await readFile(logPath, "utf8");
    const remapped = rewritePaths(raw, origin, sandbox);
    logText = [logText, remapped].filter(Boolean).join("\n\n") || remapped;
  }

  return {
    ...input,
    repoPath: sandbox,
    message: rewrite(input.message) ?? input.message,
    stackTrace: rewrite(input.stackTrace),
    logText,
    logPath: logText ? undefined : logPath,
    extraContext: rewrite(input.extraContext),
    failingTest: rewrite(input.failingTest) ?? input.failingTest,
  };
}

function rewritePaths(text: string, origin: string, sandbox: string): string {
  let out = text;
  const froms = pathAliases(origin);
  const to = pathAliases(sandbox)[0] ?? sandbox;
  for (const from of froms) {
    if (from && out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}
