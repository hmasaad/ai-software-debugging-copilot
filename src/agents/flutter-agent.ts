import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { tryCommand } from "../exec.js";
import type { AgentRun, FlutterAnalysis } from "../types.js";
import { FLUTTER_AGENT, type AgentContext, type SpecialistAgent } from "./types.js";

export class FlutterAgent implements SpecialistAgent<FlutterAnalysis> {
  readonly id = FLUTTER_AGENT.id;
  readonly name = FLUTTER_AGENT.name;
  readonly responsibility = FLUTTER_AGENT.responsibility;

  async run(ctx: AgentContext): Promise<{ result: FlutterAnalysis; run: AgentRun }> {
    const started = Date.now();
    const result = await this.analyze(ctx.input.repoPath, ctx.logAnalysis?.error.message, ctx.input.extraContext);
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

  async analyze(repoPath: string, message?: string, extra?: string): Promise<FlutterAnalysis> {
    const pubspec = await readIfExists(path.join(repoPath, "pubspec.yaml"));
    const dartFiles = await listDartFiles(repoPath);
    const sample = (await readDartSample(repoPath, dartFiles)).join("\n");
    const blob = `${pubspec}\n${sample}\n${message ?? ""}\n${extra ?? ""}`;

    const usesBloc = /\bbloc\b|flutter_bloc|Cubit</i.test(blob);
    const usesDio = /\bdio\b/i.test(blob);
    const usesDrift = /\bdrift\b/i.test(blob);
    const usesDi = /get_it|injectable|riverpod|Provider</i.test(blob);
    const usesPlatformChannels = /MethodChannel|EventChannel|platform channel/i.test(blob);
    const blocs = unique(blob.match(/\b[A-Z][A-Za-z0-9]+(?:Bloc|Cubit)\b/g) ?? []).slice(0, 8);
    const widgets = unique(blob.match(/\b[A-Z][A-Za-z0-9]+(?:Page|Screen|View|Widget)\b/g) ?? []).slice(0, 8);

    const parts = [
      usesBloc ? "Bloc" : undefined,
      usesDio ? "Dio" : undefined,
      usesDrift ? "Drift" : undefined,
      usesDi ? "DI" : undefined,
      usesPlatformChannels ? "platform channels" : undefined,
    ].filter(Boolean);

    return {
      usesBloc,
      usesDio,
      usesDrift,
      usesDi,
      usesPlatformChannels,
      widgets,
      blocs,
      summary: parts.length
        ? `Flutter agent: ${parts.join(", ")}${blocs.length ? ` · ${blocs.join(", ")}` : ""}.`
        : existsSync(path.join(repoPath, "pubspec.yaml"))
          ? "Flutter project detected; no Bloc/Dio/Drift signals in sampled files."
          : "No Flutter project markers (pubspec.yaml) in this repo.",
      handoff: [
        usesBloc ? "Trace the Bloc/Cubit event that produced this state." : "Check widget lifecycle and async gaps.",
        usesDio ? "Inspect Dio interceptors and null API payloads." : "Look at repository return types for nullability.",
        usesPlatformChannels ? "Reproduce on both iOS and Android; check platform channel codecs." : "Confirm the failing path is Dart-only before blaming native builds.",
      ],
    };
  }
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
