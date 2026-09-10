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
  "SCHEME",
];

export async function collectRuntime(repoPath: string): Promise<RuntimeContext> {
  const isFlutter = existsSync(path.join(repoPath, "pubspec.yaml"));
  const isApple = isFlutter || existsSync(path.join(repoPath, "ios")) || existsSync(path.join(repoPath, "macos"));
  const isAndroid = isFlutter || existsSync(path.join(repoPath, "android"));

  const [python, flutter, dart, xcode, gitBranch, gitSha] = await Promise.all([
    tryCommand("python3", ["--version"], { timeoutMs: 4_000 }),
    isFlutter ? tryCommand("flutter", ["--version"], { timeoutMs: 8_000 }) : Promise.resolve(undefined),
    isFlutter ? tryCommand("dart", ["--version"], { timeoutMs: 5_000 }) : Promise.resolve(undefined),
    isApple ? tryCommand("xcodebuild", ["-version"], { timeoutMs: 5_000 }) : Promise.resolve(undefined),
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
    device: process.env.SIMULATOR_DEVICE_NAME || process.env.ANDROID_SERIAL,
    flavor: process.env.FLAVOR || process.env.APP_FLAVOR || process.env.SCHEME,
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
  const baseline = input.baseline ?? parseBaseline(input.extraContext);
  const mismatches: EnvironmentMismatch[] = [];
  if (baseline) {
    for (const tool of ["flutter", "dart", "xcode", "gradle", "kotlin", "node"] as const) {
      const expected = baseline[tool];
      const actual = input.local[tool];
      if (expected && actual && normalizeVersion(expected) !== normalizeVersion(actual)) {
        mismatches.push({ tool, expected, actual });
      }
    }
  }
  const summary = mismatches.length
    ? `Potential environment mismatch detected (${mismatches.map((item) => item.tool).join(", ")}).`
    : baseline
      ? "Local toolchain matches the baseline."
      : `Captured ${describeSnapshot(input.local)}.`;
  return { local: input.local, baseline, mismatches, summary };
}

export function renderEnvironmentAscii(analysis: EnvironmentAnalysis): string {
  const local = snapshotLines("Local", analysis.local);
  const baseline = analysis.baseline ? snapshotLines("Baseline", analysis.baseline) : [];
  const mismatch = analysis.mismatches.length ? ["", "Potential environment mismatch detected."] : [];
  return [...local, ...(baseline.length ? ["", ...baseline] : []), ...mismatch, "", analysis.summary].join("\n");
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
  if (runtime.node) lines.push(`Node ${runtime.node}`);
  if (runtime.os) lines.push(`OS ${runtime.os}`);
  if (runtime.device) lines.push(`Device ${runtime.device}`);
  if (runtime.flavor) lines.push(`Flavor ${runtime.flavor}`);
  if (runtime.gitBranch) lines.push(`Git ${runtime.gitBranch}${runtime.gitSha ? ` @ ${runtime.gitSha}` : ""}`);
  return lines;
}

function describeSnapshot(runtime: RuntimeContext): string {
  return [
    runtime.os,
    runtime.flutter ? `Flutter ${runtime.flutter}` : undefined,
    runtime.xcode ? `Xcode ${runtime.xcode}` : undefined,
    runtime.node,
    runtime.gitBranch,
  ]
    .filter(Boolean)
    .join(" · ");
}

function parseBaseline(extra?: string): RuntimeContext | undefined {
  if (!extra) return undefined;
  const flutter = extra.match(/Flutter\s+([\d.]+)/i)?.[1];
  const dart = extra.match(/Dart\s+([\d.]+)/i)?.[1];
  const xcode = extra.match(/Xcode\s+([\d.]+)/i)?.[1];
  const gradle = extra.match(/Gradle\s+([\d.]+)/i)?.[1];
  const kotlin = extra.match(/Kotlin\s+([\d.]+)/i)?.[1];
  if (!flutter && !dart && !xcode && !gradle && !kotlin) return undefined;
  return {
    os: "baseline",
    arch: "unknown",
    flutter,
    dart,
    xcode,
    gradle,
    kotlin,
    cwd: "",
    ci: false,
    envHints: [],
  };
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
  return value.replace(/^v/, "").trim();
}

async function readGradleVersion(repoPath: string): Promise<string | undefined> {
  const wrapper = path.join(repoPath, "gradle/wrapper/gradle-wrapper.properties");
  if (!existsSync(wrapper)) return undefined;
  try {
    const text = await readFile(wrapper, "utf8");
    return text.match(/gradle-([\d.]+)-/)?.[1];
  } catch {
    return undefined;
  }
}

async function readKotlinVersion(repoPath: string): Promise<string | undefined> {
  for (const rel of ["android/build.gradle", "android/build.gradle.kts", "build.gradle.kts", "build.gradle"]) {
    const file = path.join(repoPath, rel);
    if (!existsSync(file)) continue;
    try {
      const text = await readFile(file, "utf8");
      const version = text.match(/kotlin(?:Version)?\s*[=:]\s*["']([\d.]+)["']/)?.[1];
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
