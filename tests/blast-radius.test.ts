import { describe, expect, it } from "vitest";
import { BLAST_RADIUS_FLOW, buildBlastRadius, renderBlastRadiusAscii } from "../src/analysis/blast-radius.js";
import type { CodeInvestigation } from "../src/types.js";

const savings: CodeInvestigation = {
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
};

describe("blast-radius analysis", () => {
  it("walks function → users and ranks the savings blast radius as HIGH", () => {
    const analysis = buildBlastRadius({ codeInvestigation: savings });
    expect(analysis.question).toBe("What else could this affect?");
    expect(analysis.origin).toBe("SavingsRepository");
    expect(analysis.usedBy.map((node) => node.name)).toEqual([
      "SavingsBloc",
      "SavingsDetailsBloc",
      "ReportsBloc",
      "ShareoutBloc",
      "MediaScreen",
    ]);
    expect(analysis.severity).toBe("HIGH");
    expect(analysis.direct).toEqual(["Savings screen"]);
    expect(analysis.indirect).toEqual(["Savings reports", "Shareout", "Member details"]);
    expect(analysis.high).toEqual(["Savings screen", "Savings reports", "Shareout", "Member details"]);
    expect(analysis.low).toEqual(["Media screen"]);
    expect(Math.round(analysis.workflowShare * 100)).toBe(32);
    expect(analysis.workflowLabel).toBe("Savings workflows");
    expect(BLAST_RADIUS_FLOW).toBe(
      [
        "Changed function",
        "      ↓",
        "Call graph",
        "      ↓",
        "Modules",
        "      ↓",
        "Features",
        "      ↓",
        "APIs",
        "      ↓",
        "Database",
        "      ↓",
        "Users",
      ].join("\n"),
    );
    expect(renderBlastRadiusAscii(analysis)).toBe(
      [
        "Changed function",
        "      ↓",
        "Call graph",
        "      ↓",
        "Modules",
        "      ↓",
        "Features",
        "      ↓",
        "APIs",
        "      ↓",
        "Database",
        "      ↓",
        "Users",
        "",
        "Blast Radius: HIGH",
        "",
        "Direct:",
        "- Savings screen",
        "",
        "Indirect:",
        "- Savings reports",
        "- Shareout",
        "- Member details",
        "",
        "Potentially affected:",
        "~32% of Savings workflows",
      ].join("\n"),
    );
  });
});
