import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { tryCommand } from "../exec.js";
import type { AgentRun, FlutterAnalysis, FlutterDomain, LogAnalysis } from "../types.js";
import { FLUTTER_AGENT, type AgentContext, type SpecialistAgent } from "./types.js";

export class FlutterAgent implements SpecialistAgent<FlutterAnalysis> {
  readonly id = FLUTTER_AGENT.id;
  readonly name = FLUTTER_AGENT.name;
  readonly responsibility = FLUTTER_AGENT.responsibility;

  async run(ctx: AgentContext): Promise<{ result: FlutterAnalysis; run: AgentRun }> {
    const started = Date.now();
    const result = await this.analyze(
      ctx.input.repoPath,
      ctx.logAnalysis?.error.message,
      ctx.input.extraContext,
      ctx.logAnalysis,
    );
    return {
      result,
      run: {
        id: this.id,
        name: this.name,
        responsibility: this.responsibility,
        status: "ok",
        summary: result.summary,
        durationMs: Date.now() - started,
      },
    };
  }

  async analyze(
    repoPath: string,
    message?: string,
    extra?: string,
    log?: LogAnalysis,
  ): Promise<FlutterAnalysis> {
    const pubspec = await readIfExists(path.join(repoPath, "pubspec.yaml"));
    const dartFiles = await listDartFiles(repoPath);
    const sample = (await readDartSample(repoPath, dartFiles)).join("\n");
    const crashFile = log?.crashSite?.file ?? "";
    const blob = `${pubspec}\n${sample}\n${message ?? ""}\n${extra ?? ""}\n${crashFile}\n${log?.error.message ?? ""}`;

    const usesBloc = /\bbloc\b|flutter_bloc|Cubit</i.test(blob);
    const usesDio = /dioexception|\bdio\b/i.test(blob);
    const usesDrift = /\bdrift\b/i.test(blob);
    const usesDi = /get_it|injectable|riverpod|Provider</i.test(blob);
    const usesPlatformChannels = /MethodChannel|EventChannel|platform channel|MissingPluginException/i.test(blob);
    const usesLifecycle = /WidgetsBinding|AppLifecycle|initState\s*\(|dispose\s*\(|didChangeDependencies/i.test(blob);
    const usesAsync = /\basync\b|\bawait\b|Future<|unawaited\(|TimeoutException/i.test(blob);
    const iosBuild = existsSync(path.join(repoPath, "ios")) || existsSync(path.join(repoPath, "ios/Podfile"));
    const androidBuild =
      existsSync(path.join(repoPath, "android")) ||
      existsSync(path.join(repoPath, "android/app/build.gradle")) ||
      existsSync(path.join(repoPath, "android/app/build.gradle.kts"));
    const blocs = unique(blob.match(/\b[A-Z][A-Za-z0-9]+(?:Bloc|Cubit)\b/g) ?? []).slice(0, 8);
    const widgets = unique(blob.match(/\b[A-Z][A-Za-z0-9]+(?:Page|Screen|View|Widget)\b/g) ?? []).slice(0, 8);
    const implicated = implicatedDomains({
      blob: `${message ?? ""}\n${extra ?? ""}\n${crashFile}`,
      usesBloc,
      usesDio,
      usesDrift,
      usesDi,
      usesPlatformChannels,
      usesLifecycle,
      usesAsync,
      iosBuild,
      androidBuild,
    });

    const parts = [
      usesBloc ? "Bloc" : undefined,
      usesDio ? "Dio" : undefined,
      usesDrift ? "Drift" : undefined,
      usesDi ? "DI" : undefined,
      usesLifecycle ? "lifecycle" : undefined,
      usesAsync ? "async" : undefined,
      usesPlatformChannels ? "platform channels" : undefined,
      iosBuild ? "iOS" : undefined,
      androidBuild ? "Android" : undefined,
    ].filter(Boolean);
    const focus = implicated.length ? ` Implicated: ${implicated.join(", ")}.` : "";

    return {
      usesBloc,
      usesDio,
      usesDrift,
      usesDi,
      usesPlatformChannels,
      usesLifecycle,
      usesAsync,
      iosBuild,
      androidBuild,
      implicated,
      widgets,
      blocs,
      summary: parts.length
        ? `Flutter agent: ${parts.join(", ")}${blocs.length ? ` · ${blocs.join(", ")}` : ""}.${focus}`
        : existsSync(path.join(repoPath, "pubspec.yaml"))
          ? "Flutter project detected; no Bloc/Dio/Drift/lifecycle signals in sampled files."
          : "No Flutter project markers (pubspec.yaml) in this repo.",
      handoff: flutterHandoff({ implicated, usesBloc, usesDio, usesDrift, usesPlatformChannels, iosBuild, androidBuild }),
    };
  }
}

function implicatedDomains(input: {
  blob: string;
  usesBloc: boolean;
  usesDio: boolean;
  usesDrift: boolean;
  usesDi: boolean;
  usesPlatformChannels: boolean;
  usesLifecycle: boolean;
  usesAsync: boolean;
  iosBuild: boolean;
  androidBuild: boolean;
}): FlutterDomain[] {
  const found: FlutterDomain[] = [];
  const add = (domain: FlutterDomain, hit: boolean) => {
    if (hit && !found.includes(domain)) found.push(domain);
  };
  add("ios-build", /xcode|cocoapods|\bpod install\b|iphoneos/i.test(input.blob) && input.iosBuild);
  add("android-build", /gradle|kotlin|assembleDebug/i.test(input.blob) && input.androidBuild);
  add("platform-channel", /MethodChannel|EventChannel|MissingPluginException|platform channel/i.test(input.blob));
  add("bloc", /bloc|cubit|wrong state/i.test(input.blob) || (input.usesBloc && /null|state/i.test(input.blob)));
  add("dio", /dioexception|\bdio\b|status code|SocketException|HttpException/i.test(input.blob));
  add("drift", /\bdrift\b|sqlite|constraint failed/i.test(input.blob));
  add("di", /get_it|injectable|GetIt|unregistered/i.test(input.blob));
  add("lifecycle", /initState|dispose|AppLifecycle|WidgetsBinding/i.test(input.blob));
  add("widget", /RenderFlex|overflowed|BuildContext|widget tree/i.test(input.blob));
  add("async", /TimeoutException|unawaited|Future\.|async gap/i.test(input.blob));
  if (!found.length) {
    add("bloc", input.usesBloc);
    add("dio", input.usesDio);
    add("drift", input.usesDrift);
  }
  return found.slice(0, 5);
}

function flutterHandoff(input: {
  implicated: FlutterDomain[];
  usesBloc: boolean;
  usesDio: boolean;
  usesDrift: boolean;
  usesPlatformChannels: boolean;
  iosBuild: boolean;
  androidBuild: boolean;
}): string[] {
  const notes: string[] = [];
  if (input.implicated.includes("bloc") || input.usesBloc) {
    notes.push("Trace the Bloc/Cubit event that produced this state.");
  }
  if (input.implicated.includes("dio") || input.usesDio) {
    notes.push("Inspect Dio interceptors and null API payloads before the widget rebuild.");
  }
  if (input.implicated.includes("drift") || input.usesDrift) {
    notes.push("Check Drift generated tables against the model and migration.");
  }
  if (input.implicated.includes("di")) notes.push("Confirm the dependency is registered before the widget/Bloc reads it.");
  if (input.implicated.includes("lifecycle")) notes.push("Check initState/dispose and AppLifecycleState against the async call.");
  if (input.implicated.includes("widget")) notes.push("Inspect the widget tree constraints (RenderFlex/overflow) around the crashing build.");
  if (input.implicated.includes("async")) notes.push("Look for an unawaited Future or a setState/emit after dispose.");
  if (input.implicated.includes("platform-channel") || input.usesPlatformChannels) {
    notes.push("Reproduce on both iOS and Android; check MethodChannel codecs and plugin registration.");
  }
  if (input.implicated.includes("ios-build")) notes.push("Inspect the iOS build (Xcode / CocoaPods) before patching Dart.");
  if (input.implicated.includes("android-build")) notes.push("Inspect the Android build (Gradle / Kotlin) before patching Dart.");
  if (!notes.length) notes.push("Confirm the failing path is Dart-only before blaming native builds.");
  return notes.slice(0, 5);
}

async function listDartFiles(repoPath: string): Promise<string[]> {
  const listed = await tryCommand("git", ["--no-pager", "ls-files", "*.dart"], {
    cwd: repoPath,
    timeoutMs: 8_000,
    env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
  });
  if (!listed || listed.code !== 0) return [];
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 40);
}

async function readDartSample(repoPath: string, files: string[]): Promise<string[]> {
  const chunks: string[] = [];
  for (const file of files.slice(0, 12)) {
    const abs = path.join(repoPath, file);
    if (!existsSync(abs)) continue;
    try {
      const text = await readFile(abs, "utf8");
      chunks.push(text.slice(0, 4_000));
    } catch {
      continue;
    }
  }
  return chunks;
}

async function readIfExists(file: string): Promise<string> {
  if (!existsSync(file)) return "";
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
