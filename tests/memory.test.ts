import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rankCauses } from "../src/agents/root-cause-agent.js";
import { recallIncidents, rememberIncident, renderMemoryAscii } from "../src/analysis/memory.js";
import type { LogAnalysis } from "../src/types.js";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const incident = {
  errorType: "NullCheckError",
  errorMessage: "Null check operator used on a null value",
  category: "runtime-crash" as const,
  rootCause: "Null API response",
  fix: "Handle null",
  resolution: "resolved",
  files: ["SavingsMemberMediaBloc.dart"],
};

describe("debugging memory", () => {
  it("stores root cause, fix, and resolution as knowledge and recalls the pattern", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "debug-memory-"));
    fixtures.push(dir);
    for (let index = 0; index < 3; index += 1) {
      await rememberIncident({ repoPath: dir, ...incident });
    }
    const memory = await recallIncidents({
      repoPath: dir,
      errorType: incident.errorType,
      errorMessage: incident.errorMessage,
      category: incident.category,
      files: incident.files,
    });
    expect(memory.matches).toHaveLength(3);
    expect(memory.summary).toBe("3 previous incidents had the same pattern");
    expect(renderMemoryAscii(memory)).toBe(
      [
        "Debugging memory",
        "",
        "Previous Incident",
        "       ↓",
        "Root cause",
        "Null API response",
        "       ↓",
        "Fix",
        "Handle null",
        "       ↓",
        "Resolution",
        "resolved",
        "       ↓",
        "Store as knowledge",
        "",
        "New error",
        "   ↓",
        "Similar historical incidents",
        "   ↓",
        "3 previous incidents had the same pattern",
        `- NullCheckError: Null API response (${Math.round((memory.matches[0]?.score ?? 0) * 100)}%)`,
        "  Fix: Handle null",
        `- NullCheckError: Null API response (${Math.round((memory.matches[1]?.score ?? 0) * 100)}%)`,
        "  Fix: Handle null",
        `- NullCheckError: Null API response (${Math.round((memory.matches[2]?.score ?? 0) * 100)}%)`,
        "  Fix: Handle null",
      ].join("\n"),
    );
  });

  it("feeds historical incidents into Root Cause Agent", () => {
    const log: LogAnalysis = {
      error: { type: "NullCheckError", message: "Null check operator used on a null value", frames: [] },
      logs: { sources: [], excerpt: "" },
      exceptionChain: [],
      logLevels: { fatal: 0, error: 1, warn: 0, info: 0, debug: 0 },
      timestamps: [],
      correlationIds: [],
      repeating: [],
      summary: "",
      handoff: [],
    };
    const ranked = rankCauses({
      logAnalysis: log,
      memory: {
        stored: false,
        matches: [
          {
            entry: {
              id: "1",
              createdAt: "2026-09-01T00:00:00.000Z",
              errorType: "NullCheckError",
              errorMessage: "Null check operator used on a null value",
              category: "runtime-crash",
              rootCause: "Null API response",
              fix: "Handle null",
              resolution: "resolved",
              files: ["SavingsMemberMediaBloc.dart"],
            },
            score: 0.9,
          },
          {
            entry: {
              id: "2",
              createdAt: "2026-09-02T00:00:00.000Z",
              errorType: "NullCheckError",
              errorMessage: "Null check operator used on a null value",
              category: "runtime-crash",
              rootCause: "Null API response",
              fix: "Handle null",
              resolution: "resolved",
              files: ["SavingsMemberMediaBloc.dart"],
            },
            score: 0.85,
          },
          {
            entry: {
              id: "3",
              createdAt: "2026-09-03T00:00:00.000Z",
              errorType: "NullCheckError",
              errorMessage: "Null check operator used on a null value",
              category: "runtime-crash",
              rootCause: "Null API response",
              fix: "Handle null",
              resolution: "resolved",
              files: ["SavingsMemberMediaBloc.dart"],
            },
            score: 0.8,
          },
        ],
        summary: "3 previous incidents had the same pattern",
      },
    });
    expect(ranked.causes.some((cause) => cause.kind === "known-incident")).toBe(true);
    expect(ranked.causes.find((cause) => cause.kind === "known-incident")?.description).toMatch(
      /3 previous incidents had the same pattern/,
    );
  });
});
