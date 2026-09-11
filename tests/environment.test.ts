import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rankCauses } from "../src/agents/root-cause-agent.js";
import { analyzeEnvironment, collectRuntime, renderEnvironmentAscii } from "../src/collectors/runtime.js";
import { runCommand } from "../src/exec.js";
import type { LogAnalysis, RuntimeContext } from "../src/types.js";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const developerA: RuntimeContext = {
  os: "darwin",
  arch: "arm64",
  flutter: "3.44",
  dart: "3.6.0",
  xcode: "16.2",
  gradle: "8.7",
  kotlin: "1.9.24",
  device: "iPhone 16",
  flavor: "prod",
  gitBranch: "main",
  gitSha: "abc1234",
  dependencies: [{ name: "dio", version: "5.4.0" }],
  cwd: "/tmp",
  ci: false,
  envHints: ["FLAVOR=prod"],
};

describe("environment-aware debugging", () => {
  it("prints Developer A vs Developer B and flags a toolchain mismatch", () => {
    const analysis = analyzeEnvironment({
      local: developerA,
      extraContext: "Developer B\nFlutter 3.27\nXcode 15.1",
    });
    expect(analysis.localLabel).toBe("Developer A");
    expect(analysis.baselineLabel).toBe("Developer B");
    expect(analysis.mismatches.map((item) => item.tool).sort()).toEqual(["flutter", "xcode"]);
    expect(renderEnvironmentAscii(analysis)).toBe(
      [
        "Developer A",
        "Flutter 3.44",
        "Dart 3.6.0",
        "Xcode 16.2",
        "Gradle 8.7",
        "Kotlin 1.9.24",
        "OS darwin",
        "Device iPhone 16",
        "Flavor prod",
        "FLAVOR=prod",
        "dio 5.4.0",
        "Git branch main",
        "Commit SHA abc1234",
        "",
        "Developer B",
        "Flutter 3.27",
        "Xcode 15.1",
        "",
        "Potential environment mismatch detected.",
      ].join("\n"),
    );
  });

  it("parses two developer snapshots from a works-on-my-machine report", () => {
    const analysis = analyzeEnvironment({
      local: { os: "linux", arch: "x64", cwd: "/ci", ci: true, envHints: [] },
      extraContext: `Developer A
Flutter 3.44
Xcode 16.2

Developer B
Flutter 3.27
Xcode 15.1`,
    });
    expect(analysis.local.flutter).toBe("3.44");
    expect(analysis.baseline?.flutter).toBe("3.27");
    expect(analysis.mismatches.map((item) => item.tool).sort()).toEqual(["flutter", "xcode"]);
  });

  it("detects Gradle, Kotlin, flavor, and dependency mismatches", () => {
    const analysis = analyzeEnvironment({
      local: developerA,
      extraContext: `Developer B
Gradle 8.4
Kotlin 1.8.22
Flavor staging
dio: 5.1.0`,
    });
    expect(analysis.mismatches.map((item) => item.tool).sort()).toEqual(["dio", "flavor", "gradle", "kotlin"]);
  });

  it("collects Gradle, Kotlin, flavor, git, and dependency pins from the repo", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "debug-env-"));
    fixtures.push(dir);
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "savings", dependencies: { leftpad: "1.0.0" } }),
    );
    await mkdir(path.join(dir, "android/gradle/wrapper"), { recursive: true });
    await writeFile(
      path.join(dir, "android/gradle/wrapper/gradle-wrapper.properties"),
      "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.7-all.zip\n",
    );
    await writeFile(path.join(dir, "android/build.gradle"), 'kotlinVersion = "1.9.24"\n');
    await runCommand("git", ["-c", "commit.gpgsign=false", "init"], { cwd: dir, timeoutMs: 8_000 });
    await runCommand("git", ["-c", "commit.gpgsign=false", "add", "."], { cwd: dir, timeoutMs: 8_000 });
    await runCommand(
      "git",
      ["-c", "commit.gpgsign=false", "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"],
      { cwd: dir, timeoutMs: 8_000 },
    );
    const previousFlavor = process.env.FLAVOR;
    process.env.FLAVOR = "staging";
    try {
      const runtime = await collectRuntime(dir);
      expect(runtime.os).toBeTruthy();
      expect(runtime.gradle).toBe("8.7");
      expect(runtime.kotlin).toBe("1.9.24");
      expect(runtime.flavor).toBe("staging");
      expect(runtime.gitBranch).toBeTruthy();
      expect(runtime.gitSha).toBeTruthy();
      expect(runtime.dependencies?.some((dep) => dep.name === "leftpad")).toBe(true);
      expect(runtime.envHints.some((hint) => hint.startsWith("FLAVOR="))).toBe(true);
    } finally {
      if (previousFlavor === undefined) delete process.env.FLAVOR;
      else process.env.FLAVOR = previousFlavor;
    }
  });

  it("ranks a toolchain mismatch first for build failures", () => {
    const log: LogAnalysis = {
      error: { type: "GradleException", message: "FAILURE: Build failed Gradle", frames: [] },
      logs: { sources: [], excerpt: "" },
      exceptionChain: [],
      logLevels: { fatal: 0, error: 1, warn: 0, info: 0, debug: 0 },
      timestamps: [],
      correlationIds: [],
      repeating: [],
      summary: "Gradle build failed",
      handoff: [],
    };
    const environment = analyzeEnvironment({
      local: developerA,
      extraContext: "Developer B\nFlutter 3.27\nXcode 15.1",
    });
    const ranked = rankCauses({
      logAnalysis: log,
      environment,
      classification: {
        family: "build",
        category: "build-failure",
        subtype: "Gradle",
        confidence: 0.9,
        signals: ["build-tool"],
        routedAgents: ["code-investigator", "dependency-analyst", "flutter-agent"],
        summary: "Build · Build failure · Gradle",
      },
    });
    expect(ranked.leading?.kind).toBe("environment");
    expect(ranked.leading?.description).toMatch(/mismatch/i);
    expect(ranked.handoff.some((note) => /Align Flutter/i.test(note))).toBe(true);
  });
});
