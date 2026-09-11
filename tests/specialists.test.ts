import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CrashAgent } from "../src/agents/crash-agent.js";
import { DatabaseAgent } from "../src/agents/database-agent.js";
import { FlutterAgent } from "../src/agents/flutter-agent.js";
import { NetworkAgent } from "../src/agents/network-agent.js";
import { rankCauses } from "../src/agents/root-cause-agent.js";
import { renderSpecialistsAscii, runRoutedSpecialists } from "../src/agents/specialists.js";
import { CRASH_AGENT, DATABASE_AGENT, FLUTTER_AGENT, NETWORK_AGENT } from "../src/agents/types.js";
import { runCommand } from "../src/exec.js";
import type { FlutterAnalysis, LogAnalysis } from "../src/types.js";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const emptyFlutter = (partial: Partial<FlutterAnalysis>): FlutterAnalysis => ({
  usesBloc: false,
  usesDio: false,
  usesDrift: false,
  usesDi: false,
  usesPlatformChannels: false,
  usesLifecycle: false,
  usesAsync: false,
  iosBuild: false,
  androidBuild: false,
  implicated: [],
  widgets: [],
  blocs: [],
  summary: "",
  handoff: [],
  ...partial,
});

describe("specialized debugging agents", () => {
  it("exposes Crash, Network, Database, and Flutter contracts", () => {
    expect(new CrashAgent().responsibility).toBe(CRASH_AGENT.responsibility);
    expect(new NetworkAgent().responsibility).toBe(NETWORK_AGENT.responsibility);
    expect(new DatabaseAgent().responsibility).toBe(DATABASE_AGENT.responsibility);
    expect(new FlutterAgent().id).toBe("flutter-agent");
    expect(new FlutterAgent().responsibility).toBe(FLUTTER_AGENT.responsibility);
  });

  it("Crash Agent classifies a null deref at the crash site", () => {
    const result = new CrashAgent().analyze({
      error: {
        type: "NullCheckError",
        message: "Null check operator used on a null value",
        frames: [],
      },
      logs: { sources: [], excerpt: "" },
      crashSite: { file: "lib/bloc.dart", line: 217, raw: "", inProject: true },
      exceptionChain: [],
      logLevels: { fatal: 0, error: 1, warn: 0, info: 0, debug: 0 },
      timestamps: [],
      correlationIds: [],
      repeating: [],
      summary: "",
      handoff: [],
    });
    expect(result.kind).toBe("null-crash");
    expect(result.crashSite).toContain("bloc.dart:217");
  });

  it("Network Agent extracts Dio HTTP failures", () => {
    const result = new NetworkAgent().analyze(undefined, "DioException: status code 500 from https://api.example.com/media");
    expect(result.protocol).toBe("dio");
    expect(result.status).toBe("500");
    expect(result.endpoint).toContain("api.example.com");
  });

  it("Database Agent recognizes Drift", () => {
    const result = new DatabaseAgent().analyze(undefined, "Drift database constraint failed on insert");
    expect(result.engine).toBe("drift");
    expect(result.operation).toBe("insert");
  });

  it("Flutter agent understands Bloc, Dio, Drift, DI, lifecycle, async, channels, and native builds", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "debug-flutter-"));
    fixtures.push(dir);
    await writeFile(
      path.join(dir, "pubspec.yaml"),
      `name: savings
dependencies:
  flutter:
    sdk: flutter
  flutter_bloc: ^8.0.0
  dio: ^5.0.0
  drift: ^2.0.0
  get_it: ^7.0.0
`,
    );
    await mkdir(path.join(dir, "lib"));
    await mkdir(path.join(dir, "ios"));
    await mkdir(path.join(dir, "android/app"), { recursive: true });
    await writeFile(path.join(dir, "ios/Podfile"), "platform :ios, '13.0'\n");
    await writeFile(path.join(dir, "android/app/build.gradle"), "android {}\n");
    await writeFile(
      path.join(dir, "lib/savings_bloc.dart"),
      `class SavingsBloc extends Bloc<Event, State> {
  final Dio dio;
  @override
  void initState() {}
  Future<void> load() async {
    await dio.get("/media");
  }
}
final channel = MethodChannel("savings");
class SavingsScreen extends StatelessWidget {}
`,
    );
    await runCommand("git", ["-c", "commit.gpgsign=false", "init"], { cwd: dir, timeoutMs: 8_000 });
    await runCommand("git", ["-c", "commit.gpgsign=false", "add", "."], { cwd: dir, timeoutMs: 8_000 });

    const analysis = await new FlutterAgent().analyze(dir, "DioException: null payload in SavingsBloc", undefined, {
      error: { type: "DioException", message: "null payload", frames: [] },
      logs: { sources: [], excerpt: "" },
      crashSite: { file: "lib/savings_bloc.dart", line: 4, raw: "", inProject: true },
      exceptionChain: [],
      logLevels: { fatal: 0, error: 1, warn: 0, info: 0, debug: 0 },
      timestamps: [],
      correlationIds: [],
      repeating: [],
      summary: "",
      handoff: [],
    });

    expect(analysis.usesBloc).toBe(true);
    expect(analysis.usesDio).toBe(true);
    expect(analysis.usesDrift).toBe(true);
    expect(analysis.usesDi).toBe(true);
    expect(analysis.usesLifecycle).toBe(true);
    expect(analysis.usesAsync).toBe(true);
    expect(analysis.usesPlatformChannels).toBe(true);
    expect(analysis.iosBuild).toBe(true);
    expect(analysis.androidBuild).toBe(true);
    expect(analysis.implicated).toContain("dio");
    expect(analysis.implicated).toContain("bloc");
    expect(analysis.blocs).toContain("SavingsBloc");
    expect(analysis.widgets).toContain("SavingsScreen");
    expect(analysis.handoff.some((note) => /Dio|Bloc/i.test(note))).toBe(true);
  });

  it("orchestrator runs only the routed specialists", async () => {
    const { findings } = await runRoutedSpecialists(
      {
        input: { repoPath: process.cwd(), extraContext: "DioException: status code 500 from https://api.example.com" },
        logAnalysis: {
          error: { type: "DioException", message: "status code 500", frames: [] },
          logs: { sources: [], excerpt: "" },
          exceptionChain: [],
          logLevels: { fatal: 0, error: 1, warn: 0, info: 0, debug: 0 },
          timestamps: [],
          correlationIds: [],
          repeating: [],
          summary: "",
          handoff: [],
        },
      },
      ["crash-agent", "network-agent"],
    );
    expect(findings.crash).toBeDefined();
    expect(findings.network?.protocol).toBe("dio");
    expect(findings.flutter).toBeUndefined();
    expect(findings.database).toBeUndefined();
    expect(renderSpecialistsAscii(findings)).toContain("Debugging Orchestrator");
    expect(renderSpecialistsAscii(findings)).toContain("Root Cause Agent");
  });

  it("feeds Flutter Dio findings into Root Cause Agent", () => {
    const log: LogAnalysis = {
      error: {
        type: "NullCheckError",
        message: "Null check operator used on a null value",
        frames: [{ file: "lib/savings_bloc.dart", line: 217, raw: "", inProject: true }],
      },
      logs: { sources: [], excerpt: "" },
      crashSite: { file: "lib/savings_bloc.dart", line: 217, raw: "", inProject: true },
      exceptionChain: [],
      logLevels: { fatal: 0, error: 1, warn: 0, info: 0, debug: 0 },
      timestamps: [],
      correlationIds: [],
      repeating: [],
      summary: "null at SavingsBloc",
      handoff: [],
    };
    const ranked = rankCauses({
      logAnalysis: log,
      specialists: {
        flutter: emptyFlutter({
          usesBloc: true,
          usesDio: true,
          implicated: ["dio", "bloc"],
          blocs: ["SavingsBloc"],
          summary: "Flutter agent: Bloc, Dio · SavingsBloc. Implicated: dio, bloc.",
          handoff: ["Inspect Dio interceptors and null API payloads before the widget rebuild."],
        }),
      },
    });
    expect(ranked.leading?.kind).toBe("flutter");
    expect(ranked.leading?.description).toMatch(/Dio|Bloc/i);
    expect(renderSpecialistsAscii({ flutter: ranked.leading ? emptyFlutter({ usesDio: true }) : undefined })).toContain(
      "Flutter",
    );
  });
});
