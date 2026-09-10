import { describe, expect, it } from "vitest";
import { parseJsonObject } from "../src/prompts/investigation.js";

describe("parseJsonObject", () => {
  it("extracts JSON from a fenced model reply", () => {
    const parsed = parseJsonObject<{ summary: string }>("```json\n{\"summary\":\"root cause\"}\n```");
    expect(parsed.summary).toBe("root cause");
  });

  it("throws when no object is present", () => {
    expect(() => parseJsonObject("nope")).toThrow(/did not return JSON/);
  });
});
