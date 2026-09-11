import { describe, expect, it } from "vitest";
import { classifyFailure, renderClassificationAscii } from "../src/analysis/classify.js";
import { ClassifierAgent } from "../src/agents/classifier-agent.js";
import { CLASSIFIER } from "../src/agents/types.js";
import type { FailureCategory } from "../src/types.js";

describe("Failure Classifier", () => {
  it("exposes the core-agent contract", () => {
    const agent = new ClassifierAgent();
    expect(agent.id).toBe("classifier");
    expect(agent.name).toBe(CLASSIFIER.name);
    expect(agent.responsibility).toBe("Classify the failure before investigation and route specialists");
  });

  it("classifies a Dart null crash as Runtime → Null Crash and routes crash + Flutter agents", () => {
    const result = classifyFailure({
      message: "Null check operator used on a null value",
      stackTrace: "SavingsMemberMediaBloc.dart:217",
    });
    expect(result.family).toBe("runtime");
    expect(result.category).toBe("runtime-crash");
    expect(result.subtype).toBe("Null Crash");
    expect(result.routedAgents).toEqual(expect.arrayContaining(["crash-agent", "flutter-agent", "code-investigator"]));
    const ascii = renderClassificationAscii(result);
    expect(ascii).toContain("Runtime");
    expect(ascii).toContain("Build");
    expect(ascii).toContain("Logic");
    expect(ascii).toContain("▶ Null Crash");
    expect(ascii).toContain("Category: Runtime crash");
  });

  it("classifies Gradle, CocoaPods, and Xcode as build failures", () => {
    expect(classifyFailure({ message: "FAILURE: Build failed Gradle" }).subtype).toBe("Gradle");
    expect(classifyFailure({ message: "pod install CocoaPods failed" }).subtype).toBe("CocoaPods");
    expect(classifyFailure({ message: "xcodebuild failed" }).subtype).toBe("Xcode");
    expect(classifyFailure({ message: "FAILURE: Build failed Gradle" }).category).toBe("build-failure");
    expect(classifyFailure({ message: "FAILURE: Build failed Gradle" }).family).toBe("build");
  });

  it("puts ANR under Runtime and calculation/state/race under Logic", () => {
    const anr = classifyFailure({ message: "ANR in com.app.MainActivity" });
    expect(anr.family).toBe("runtime");
    expect(anr.subtype).toBe("ANR");
    expect(anr.category).toBe("performance-issue");

    const state = classifyFailure({ message: "SavingsBloc emitted the wrong state after LoadMedia" });
    expect(state.family).toBe("logic");
    expect(state.subtype).toBe("Wrong state");
    expect(state.category).toBe("state-management-issue");

    const calc = classifyFailure({ message: "AssertionError: Expected NaN to equal 10" });
    expect(calc.family).toBe("logic");
    expect(calc.subtype).toBe("Wrong calculation");

    const race = classifyFailure({ message: "Concurrent modification during isolate race" });
    expect(race.family).toBe("logic");
    expect(race.subtype).toBe("Race condition");
    expect(race.category).toBe("concurrency-race");
  });

  it("classifies every routing category", () => {
    const cases: Array<[string, FailureCategory, string]> = [
      ["TypeError: crash in foo", "runtime-crash", "crash-agent"],
      ["FAILURE: Build failed Gradle", "build-failure", "dependency-analyst"],
      ["Cannot find module 'left-pad'", "dependency-issue", "dependency-analyst"],
      ["DioException: status code 500 from https://api.example.com/media", "api-backend-issue", "network-agent"],
      ["DioException: status code 500 from https://api.example.com/media", "api-backend-issue", "flutter-agent"],
      ["Drift database constraint failed on insert", "database-issue", "database-agent"],
      ["A RenderFlex overflowed by 23 pixels", "ui-issue", "flutter-agent"],
      ["Cubit emit wrong state", "state-management-issue", "flutter-agent"],
      ["skipped 120 frames, jank on scroll", "performance-issue", "crash-agent"],
      ["deadlock in mutex", "concurrency-race", "crash-agent"],
      ["works on my machine, flavor staging", "configuration-environment", "code-investigator"],
      ["possible XSS injection in token", "security-issue", "code-investigator"],
    ];
    for (const [message, category, agent] of cases) {
      const result = classifyFailure({ message });
      expect(result.category, message).toBe(category);
      expect(result.routedAgents, message).toContain(agent);
    }
  });
});
