import { describe, expect, it } from "vitest";
import { buildBlastRadius, renderBlastRadiusAscii } from "../src/analysis/blast-radius.js";
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
  it("asks what else the change could break and ranks HIGH vs LOW surfaces", () => {
    const analysis = buildBlastRadius({ codeInvestigation: savings });
    expect(analysis.question).toBe("What else could this change break?");
    expect(analysis.origin).toBe("SavingsRepository");
    expect(analysis.usedBy.map((node) => node.name)).toEqual([
      "SavingsBloc",
      "SavingsDetailsBloc",
      "ReportsBloc",
      "ShareoutBloc",
      "MediaScreen",
    ]);
    expect(analysis.high).toEqual(["Savings screen", "Savings reports", "Shareout calculation"]);
    expect(analysis.low).toEqual(["Media screen"]);
    expect(renderBlastRadiusAscii(analysis)).toBe(
      [
        "What else could this change break?",
        "",
        "Bug",
        " ↓",
        "SavingsRepository",
        " ↓",
        "Used by",
        " ├── SavingsBloc",
        " ├── SavingsDetailsBloc",
        " ├── ReportsBloc",
        " └── ShareoutBloc",
        "",
        "Potential blast radius:",
        "",
        "HIGH",
        "├── Savings screen",
        "├── Savings reports",
        "└── Shareout calculation",
        "",
        "LOW",
        "└── Media screen",
      ].join("\n"),
    );
  });
});
