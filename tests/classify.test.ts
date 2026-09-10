import { describe, expect, it } from "vitest";
import { classifyFailure, renderClassificationAscii } from "../src/analysis/classify.js";

describe("failure classification", () => {
  it("classifies a Dart null crash as runtime", () => {
    const result = classifyFailure({
      message: "Null check operator used on a null value",
      stackTrace: "SavingsMemberMediaBloc.dart:217",
    });
    expect(result.family).toBe("runtime");
    expect(result.category).toBe("runtime-crash");
    expect(result.subtype).toBe("Null Crash");
    expect(result.routedAgents).toContain("crash-agent");
    expect(renderClassificationAscii(result)).toContain("Runtime crash");
  });

  it("classifies Gradle, CocoaPods, and Xcode as build failures", () => {
    expect(classifyFailure({ message: "FAILURE: Build failed Gradle" }).subtype).toBe("Gradle");
    expect(classifyFailure({ message: "pod install CocoaPods failed" }).subtype).toBe("CocoaPods");
    expect(classifyFailure({ message: "xcodebuild failed" }).subtype).toBe("Xcode");
    expect(classifyFailure({ message: "FAILURE: Build failed Gradle" }).category).toBe("build-failure");
  });

  it("routes API and database failures to specialized agents", () => {
    const api = classifyFailure({ message: "DioException: status code 500 from https://api.example.com/media" });
    expect(api.category).toBe("api-backend-issue");
    expect(api.routedAgents).toContain("network-agent");
    const db = classifyFailure({ message: "Drift database constraint failed on insert" });
    expect(db.category).toBe("database-issue");
    expect(db.routedAgents).toContain("database-agent");
  });
});
