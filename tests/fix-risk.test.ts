import { describe, expect, it } from "vitest";
import {
  FIX_RISK_RULE,
  labelFixCandidates,
  preferSmallestSafeFix,
  renderFixRiskAscii,
  scoreFixRisk,
} from "../src/analysis/fix-risk.js";
import type { FileEdit, FixRisk } from "../src/types.js";

const FIX_A_FILES = ["src/cart.js", "src/cart-utils.js"];
const FIX_B_FILES = [
  "lib/savings/a.dart",
  "lib/savings/b.dart",
  "lib/reports/c.dart",
  "lib/reports/d.dart",
  "lib/shareout/e.dart",
  "lib/shareout/f.dart",
  "lib/media/g.dart",
];

const LOCKED_ASCII = [
  "Fix A",
  "─".repeat(16),
  "Change: 2 files",
  "Tests: 18",
  "Affected modules: 1",
  "Risk: LOW",
  "Confidence: 94%",
  "",
  "Fix B",
  "─".repeat(16),
  "Change: 7 files",
  "Tests: 43",
  "Affected modules: 4",
  "Risk: HIGH",
  "Confidence: 71%",
  "",
  FIX_RISK_RULE,
].join("\n");

function dummyEdits(files: string[]): FileEdit[] {
  return files.map((path) => ({ path, oldString: "old", newString: "new" }));
}

function candidate(risk: FixRisk) {
  return { risk, edits: dummyEdits(risk.filePaths) };
}

describe("risk-aware fixing", () => {
  it("scores Fix A as LOW 94% and Fix B as HIGH 71%, then prefers A", () => {
    const a = scoreFixRisk({ files: FIX_A_FILES, tests: 18 });
    const b = scoreFixRisk({ files: FIX_B_FILES, tests: 43 });

    expect(a.files).toBe(2);
    expect(a.tests).toBe(18);
    expect(a.modules).toBe(1);
    expect(a.level).toBe("LOW");
    expect(Math.round(a.confidence * 100)).toBe(94);

    expect(b.files).toBe(7);
    expect(b.tests).toBe(43);
    expect(b.modules).toBe(4);
    expect(b.level).toBe("HIGH");
    expect(Math.round(b.confidence * 100)).toBe(71);

    const ranked = preferSmallestSafeFix([candidate(b), candidate(a)]);
    expect(ranked[0]?.risk.files).toBe(2);
    expect(ranked[0]?.risk.level).toBe("LOW");

    const labeled = labelFixCandidates(ranked.map((item) => item.risk));
    expect(labeled[0]?.label).toBe("Fix A");
    expect(labeled[0]?.preferred).toBe(true);
    expect(labeled[1]?.label).toBe("Fix B");
    expect(renderFixRiskAscii(labeled)).toBe(LOCKED_ASCII);
  });

  it("treats a one-file optional-chain guard as LOW risk", () => {
    const risk = scoreFixRisk({
      files: ["src/cart.js"],
      tests: 1,
      strategy: "optional-chain",
    });
    expect(risk.level).toBe("LOW");
    expect(risk.files).toBe(1);
    expect(risk.modules).toBe(1);
  });
});
