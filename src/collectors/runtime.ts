import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { tryCommand } from "../exec.js";
import type { EnvironmentAnalysis, EnvironmentMismatch, RuntimeContext } from "../types.js";

const ENV_HINTS = [
  "CI",
  "GITHUB_ACTIONS",
  "NODE_ENV",
  "DEBUG",
  "LOG_LEVEL",
  "DATABASE_URL",
  "REDIS_URL",
  "FLAVOR",
  "APP_FLAVOR",
  "FLUTTER_FLAVOR",
  "SCHEME",
  "FLUTTER_ROOT",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "JAVA_HOME",
  "PUB_HOSTED_URL",
];

const VERSION_TOOLS = ["flutter", "dart", "xcode", "gradle", "kotlin", "node"] as const;
const CONTEXT_TOOLS = ["os", "device", "flavor"] as const;

export async function collectRuntime(repoPath: string): Promise<RuntimeContext> {
  const isFlutter = existsSync(path.join(repoPath, "pubspec.yaml"));
  const isApple = isFlutter || existsSync(path.join(repoPath, "ios")) || existsSync(path.join(repoPath, "macos"));
  const isAndroid = isFlutter || existsSync(path.join(repoPath, "android"));

  const [python, flutter, dart, xcode, gitBranch, gitSha] = await Promise.all([
    tryCommand("python3", ["--version"], { timeoutMs: 4_000 }),
    isFlutter ? tryIfPresent("flutter", ["--version"], 8_000) : Promise.resolve(undefined),
    isFlutter ? tryIfPresent("dart", ["--version"], 5_000) : Promise.resolve(undefined),
    isApple ? tryIfPresent("xcodebuild", ["-version"], 5_000) : Promise.resolve(undefined),
    tryCommand("git", ["--no-pager", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoPath,
      timeoutMs: 4_000,
      env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
    }),
    tryCommand("git", ["--no-pager", "rev-parse", "--short", "HEAD"], {
      cwd: repoPath,
      timeoutMs: 4_000,
      env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
    }),
  ]);

  const hints = ENV_HINTS.filter((name) => Boolean(process.env[name])).map((name) => {
    const value = process.env[name] ?? "";
    const redacted = /URL|TOKEN|KEY|SECRET/i.test(name) ? "[set]" : value;
    return `${name}=${redacted}`;
  });

  const gradle = isAndroid ? await readGradleVersion(repoPath) : undefined;
  const kotlin = isAndroid ? await readKotlinVersion(repoPath) : undefined;
  const dependencies = await readPinnedDependencies(repoPath);

  return {
    os: process.platform,
    arch: process.arch,
    node: process.version,
    python: python?.code === 0 ? firstLine(python.stdout || python.stderr) : undefined,
    flutter: flutter?.code === 0 ? parseFlutterVersion(flutter.stdout || flutter.stderr) : undefined,
    dart: dart?.code === 0 ? parseDartVersion(dart.stdout || dart.stderr) : parseFlutterDart(flutter?.stdout),
    xcode: xcode?.code === 0 ? parseXcodeVersion(xcode.stdout || xcode.stderr) : undefined,
    gradle,
    kotlin,
    device:
      process.env.SIMULATOR_DEVICE_NAME ||
      process.env.ANDROID_SERIAL ||
      process.env.IOS_DEVICE ||
      process.env.ANDROID_DEVICE,
    flavor: process.env.FLAVOR || process.env.APP_FLAVOR || process.env.FLUTTER_FLAVOR || process.env.SCHEME,
    gitBranch: gitBranch?.code === 0 ? gitBranch.stdout.trim() : undefined,
    gitSha: gitSha?.code === 0 ? gitSha.stdout.trim() : undefined,
    dependencies,
    cwd: repoPath,
    ci: Boolean(process.env.CI),
    envHints: hints,
  };
}

export function analyzeEnvironment(input: {
  local: RuntimeContext;
  extraContext?: string;
  baseline?: RuntimeContext;
}): EnvironmentAnalysis {
  const labels = developerLabels(input.extraContext);
  const parsed = parseBaseline(input.extraContext);
  const local = mergeRuntime(input.local, parsed.local);
  const baseline = input.baseline ?? parsed.baseline;
  const mismatches: EnvironmentMismatch[] = [];
  if (baseline) {
    mismatches.push(...diffSnapshots(local, baseline));
  }
  const summary = mismatches.length
    ? `Potential environment mismatch detected (${mismatches.map((item) => item.tool).join(", ")}).`
    : baseline
      ? "Local toolchain matches the baseline."
      : `Captured ${describeSnapshot(local)}.`;
  return {
    local,
    baseline,
    localLabel: labels.local,
    baselineLabel: baseline ? labels.baseline : undefined,
    mismatches,
    summary,
  };
}

export function renderEnvironmentAscii(analysis: EnvironmentAnalysis): string {
  const local = snapshotLines(analysis.localLabel, analysis.local);
  const baseline = analysis.baseline ? snapshotLines(analysis.baselineLabel ?? "Developer B", analysis.baseline) : [];
  const mismatch = analysis.mismatches.length ? ["", "Potential environment mismatch detected."] : [];
  return [...local, ...(baseline.length ? ["", ...baseline] : []), ...mismatch].join("\n");
}

export async function loadBaselineEnv(filePath?: string): Promise<RuntimeContext | undefined> {
  if (!filePath || !existsSync(filePath)) return undefined;
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as RuntimeContext;
  } catch {
    return undefined;
  }
}

function snapshotLines(label: string, runtime: RuntimeContext): string[] {
  const lines = [label];
  if (runtime.flutter) lines.push(`Flutter ${runtime.flutter}`);
  if (runtime.dart) lines.push(`Dart ${runtime.dart}`);
  if (runtime.xcode) lines.push(`Xcode ${runtime.xcode}`);
  if (runtime.gradle) lines.push(`Gradle ${runtime.gradle}`);
  if (runtime.kotlin) lines.push(`Kotlin ${runtime.kotlin}`);
  if (runtime.os) lines.push(`OS ${runtime.os}`);
  if (runtime.device) lines.push(`Device ${runtime.device}`);
  if (runtime.flavor) lines.push(`Flavor ${runtime.flavor}`);
  for (const hint of runtime.envHints) lines.push(hint);
  for (const dep of runtime.dependencies ?? []) lines.push(`${dep.name} ${dep.version}`);
  if (runtime.gitBranch) lines.push(`Git branch ${runtime.gitBranch}`);
  if (runtime.gitSha) lines.push(`Commit SHA ${runtime.gitSha}`);
  return lines;
}

function describeSnapshot(runtime: RuntimeContext): string {
  return [
    runtime.os,
    runtime.flutter ? `Flutter ${runtime.flutter}` : undefined,
    runtime.dart ? `Dart ${runtime.dart}` : undefined,
    runtime.xcode ? `Xcode ${runtime.xcode}` : undefined,
    runtime.gradle ? `Gradle ${runtime.gradle}` : undefined,
    runtime.kotlin ? `Kotlin ${runtime.kotlin}` : undefined,
    runtime.device ? `Device ${runtime.device}` : undefined,
    runtime.flavor ? `Flavor ${runtime.flavor}` : undefined,
    runtime.gitBranch,
    runtime.gitSha,
  ]
    .filter(Boolean)
    .join(" · ");
}

function developerLabels(extra?: string): { local: string; baseline: string } {
  const names = [...(extra?.matchAll(/Developer\s+([A-Za-z0-9_-]+)/gi) ?? [])].map(
    (match) => `Developer ${match[1]}`,
  );
  if (names[0] && names[1]) return { local: names[0], baseline: names[1] };
  if (names[0]) {
    return /B$/i.test(names[0]) ? { local: "Developer A", baseline: names[0] } : { local: names[0], baseline: "Developer B" };
  }
  return { local: "Developer A", baseline: "Developer B" };
}

function parseBaseline(extra?: string): { local?: RuntimeContext; baseline?: RuntimeContext } {
  if (!extra) return {};
  const blocks = splitDeveloperBlocks(extra);
  if (blocks.length >= 2) {
    return {
      local: snapshotFromText(blocks[0]?.body ?? ""),
      baseline: snapshotFromText(blocks[1]?.body ?? ""),
    };
  }
  if (blocks.length === 1) {
    return { baseline: snapshotFromText(blocks[0]?.body ?? extra) };
  }
  const baseline = snapshotFromText(extra);
  if (!hasComparableFields(baseline)) return {};
  return { baseline };
}

function splitDeveloperBlocks(extra: string): Array<{ name: string; body: string }> {
  const matches = [...extra.matchAll(/(?:^|\n)(Developer\s+[A-Za-z0-9_-]+)\s*\n([\s\S]*?)(?=(?:\nDeveloper\s+[A-Za-z0-9_-]+)|$)/gi)];
  return matches
    .map((match) => ({ name: match[1]?.trim() ?? "", body: match[2] ?? "" }))
    .filter((block) => block.name);
}

function snapshotFromText(text: string): RuntimeContext {
  const flutter = text.match(/Flutter\s+([\d.]+)/i)?.[1];
  const dart = text.match(/Dart\s+([\d.]+)/i)?.[1];
  const xcode = text.match(/Xcode\s+([\d.]+)/i)?.[1];
  const gradle = text.match(/Gradle\s+([\d.]+)/i)?.[1];
  const kotlin = text.match(/Kotlin\s+([\d.]+)/i)?.[1];
  const os = text.match(/\bOS\s+([A-Za-z0-9._-]+)/i)?.[1] ?? text.match(/\b(macOS|darwin|linux|windows)\b/i)?.[1];
  const device = text.match(/Device\s+([^\n]+)/i)?.[1]?.trim();
  const flavor = text.match(/(?:Build\s+)?Flavor\s+([A-Za-z0-9._-]+)/i)?.[1];
  const gitBranch = text.match(/Git(?:\s+branch)?\s+([A-Za-z0-9._/-]+)/i)?.[1];
  const gitSha = text.match(/(?:Commit\s+)?SHA\s+([A-Fa-f0-9]{7,40})/i)?.[1];
  const envHints = [...text.matchAll(/^(FLAVOR|APP_FLAVOR|FLUTTER_FLAVOR|SCHEME|NODE_ENV|CI)=(\S+)/gm)].map(
    (match) => `${match[1]}=${match[2]}`,
  );
  const dependencies: Array<{ name: string; version: string }> = [];
  for (const match of text.matchAll(/^\s{0,2}([A-Za-z0-9_]+):\s+[\^~]?(<?[\d.]+>?)\s*$/gm)) {
    if (match[1] && match[2] && !["sdk", "flutter", "flavor"].includes(match[1].toLowerCase())) {
      dependencies.push({ name: match[1], version: match[2] });
    }
  }
  return emptyRuntime({
    os: os ?? "",
    flutter,
    dart,
    xcode,
    gradle,
    kotlin,
    device,
    flavor,
    gitBranch,
    gitSha,
    envHints,
    dependencies: dependencies.length ? dependencies : undefined,
  });
}

function mergeRuntime(local: RuntimeContext, overlay?: RuntimeContext): RuntimeContext {
  if (!overlay) return local;
  return {
    ...local,
    flutter: local.flutter || overlay.flutter,
    dart: local.dart || overlay.dart,
    xcode: local.xcode || overlay.xcode,
    gradle: local.gradle || overlay.gradle,
    kotlin: local.kotlin || overlay.kotlin,
    device: local.device || overlay.device,
    flavor: local.flavor || overlay.flavor,
    gitBranch: local.gitBranch || overlay.gitBranch,
    gitSha: local.gitSha || overlay.gitSha,
    os: local.os || overlay.os,
    dependencies: local.dependencies?.length ? local.dependencies : overlay.dependencies,
    envHints: local.envHints.length ? local.envHints : overlay.envHints,
  };
}

function diffSnapshots(local: RuntimeContext, baseline: RuntimeContext): EnvironmentMismatch[] {
  const mismatches: EnvironmentMismatch[] = [];
  for (const tool of VERSION_TOOLS) {
    pushMismatch(mismatches, tool, baseline[tool], local[tool], normalizeVersion);
  }
  for (const tool of CONTEXT_TOOLS) {
    pushMismatch(mismatches, tool, baseline[tool], local[tool], tool === "os" ? normalizeOs : normalizeVersion);
  }
  for (const hint of local.envHints) {
    const [name, actual] = splitHint(hint);
    if (!name || actual === undefined) continue;
    const expected = envMap(baseline.envHints).get(name);
    if (expected && expected !== actual) mismatches.push({ tool: name, expected, actual });
  }
  for (const dep of local.dependencies ?? []) {
    const expected = baseline.dependencies?.find((item) => item.name === dep.name)?.version;
    if (expected && normalizeVersion(expected) !== normalizeVersion(dep.version)) {
      mismatches.push({ tool: dep.name, expected, actual: dep.version });
    }
  }
  return mismatches;
}

function pushMismatch(
  mismatches: EnvironmentMismatch[],
  tool: string,
  expected: string | undefined,
  actual: string | undefined,
  normalize: (value: string) => string,
): void {
  if (!expected || !actual) return;
  if (normalize(expected) === normalize(actual)) return;
  mismatches.push({ tool, expected, actual });
}

function envMap(hints: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const hint of hints) {
    const [name, value] = splitHint(hint);
    if (name && value !== undefined) map.set(name, value);
  }
  return map;
}

function splitHint(hint: string): [string | undefined, string | undefined] {
  const index = hint.indexOf("=");
  if (index <= 0) return [undefined, undefined];
  return [hint.slice(0, index), hint.slice(index + 1)];
}

function hasComparableFields(runtime: RuntimeContext): boolean {
  return Boolean(
    runtime.flutter ||
      runtime.dart ||
      runtime.xcode ||
      runtime.gradle ||
      runtime.kotlin ||
      runtime.device ||
      runtime.flavor ||
      runtime.os,
  );
}

function emptyRuntime(partial: Partial<RuntimeContext>): RuntimeContext {
  return {
    os: partial.os ?? "",
    arch: partial.arch ?? "unknown",
    node: partial.node,
    python: partial.python,
    flutter: partial.flutter,
    dart: partial.dart,
    xcode: partial.xcode,
    gradle: partial.gradle,
    kotlin: partial.kotlin,
    device: partial.device,
    flavor: partial.flavor,
    gitBranch: partial.gitBranch,
    gitSha: partial.gitSha,
    dependencies: partial.dependencies,
    cwd: partial.cwd ?? "",
    ci: partial.ci ?? false,
    envHints: partial.envHints ?? [],
  };
}

async function tryIfPresent(command: string, args: string[], timeoutMs: number) {
  const found = await tryCommand("which", [command], { timeoutMs: 1_500 });
  if (!found || found.code !== 0 || !found.stdout.trim()) return undefined;
  return tryCommand(command, args, { timeoutMs });
}

function parseFlutterVersion(text: string): string | undefined {
  return text.match(/Flutter\s+([\d.]+)/i)?.[1];
}

function parseFlutterDart(text?: string): string | undefined {
  return text?.match(/Dart\s+([\d.]+)/i)?.[1];
}

function parseDartVersion(text: string): string | undefined {
  return text.match(/Dart\s+SDK\s+version:\s+([\d.]+)/i)?.[1] ?? text.match(/([\d]+\.[\d.]+)/)?.[1];
}

function parseXcodeVersion(text: string): string | undefined {
  return text.match(/Xcode\s+([\d.]+)/i)?.[1];
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() || text.trim();
}

function normalizeVersion(value: string): string {
  return value.replace(/^v/i, "").replace(/(\.0)+$/, "").trim();
}

function normalizeOs(value: string): string {
  const lower = value.toLowerCase();
  if (/darwin|mac/.test(lower)) return "macos";
  if (/win/.test(lower)) return "windows";
  if (/linux/.test(lower)) return "linux";
  return lower;
}

async function readGradleVersion(repoPath: string): Promise<string | undefined> {
  const wrapper = path.join(repoPath, "android/gradle/wrapper/gradle-wrapper.properties");
  const rootWrapper = path.join(repoPath, "gradle/wrapper/gradle-wrapper.properties");
  for (const file of [wrapper, rootWrapper]) {
    if (!existsSync(file)) continue;
    try {
      const text = await readFile(file, "utf8");
      const version = text.match(/gradle-([\d.]+)-/)?.[1];
      if (version) return version;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function readKotlinVersion(repoPath: string): Promise<string | undefined> {
  for (const rel of ["android/build.gradle", "android/build.gradle.kts", "build.gradle.kts", "build.gradle"]) {
    const file = path.join(repoPath, rel);
    if (!existsSync(file)) continue;
    try {
      const text = await readFile(file, "utf8");
      const version =
        text.match(/kotlin(?:Version)?\s*[=:]\s*["']([\d.]+)["']/)?.[1] ??
        text.match(/org\.jetbrains\.kotlin[^"']*["']([\d.]+)["']/)?.[1];
      if (version) return version;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function readPinnedDependencies(repoPath: string): Promise<Array<{ name: string; version: string }>> {
  const pubspec = path.join(repoPath, "pubspec.yaml");
  if (existsSync(pubspec)) {
    try {
      const text = await readFile(pubspec, "utf8");
      const deps: Array<{ name: string; version: string }> = [];
      for (const match of text.matchAll(/^\s{2}([A-Za-z0-9_]+):\s+[\^]?(<?[\d.]+>?)/gm)) {
        if (match[1] && match[2] && !["sdk", "flutter"].includes(match[1])) {
          deps.push({ name: match[1], version: match[2] });
        }
      }
      return deps.slice(0, 12);
    } catch {
      return [];
    }
  }
  const pkg = path.join(repoPath, "package.json");
  if (!existsSync(pkg)) return [];
  try {
    const parsed = JSON.parse(await readFile(pkg, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Object.entries({ ...parsed.dependencies, ...parsed.devDependencies })
      .slice(0, 12)
      .map(([name, version]) => ({ name, version }));
  } catch {
    return [];
  }
}
