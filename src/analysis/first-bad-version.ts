import { countCommitsBetween, listCommitsBetween, resolveVersionRef } from "../collectors/git.js";
import type { BugInput, FirstBadVersion, GitCommit, VersionHealth, VersionHealthStatus } from "../types.js";

const HEALTHY = /^(healthy|ok|good|pass(?:ing)?|crash-free)$/i;
const CRASHING = /^(crash(?:es|ing)?|bad|unhealthy|broken|fail(?:ing)?)$/i;

/**
 * Parse a version health timeline from crash notes / `--context`.
 *
 * Accepts lines like `v1.0.180 → healthy` / `v1.0.181 → crashes`,
 * JSON `{ versions: [...] }`, and `12 commits between 1.0.180 and 1.0.181`.
 */
export function parseVersionHealth(text?: string): VersionHealth[] {
  if (!text?.trim()) return [];
  const found = new Map<string, VersionHealth>();
  const remember = (version: string, status: VersionHealthStatus, source: VersionHealth["source"] = "reported") => {
    const normalized = normalizeVersion(version);
    if (!normalized || status === "unknown") return;
    found.set(normalized, { version: normalized, status, source });
  };

  for (const row of parseJsonVersions(text)) {
    remember(row.version, row.status, row.source ?? "reported");
  }

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(
      /^\s*v?(\d+(?:\.\d+){1,3})\s*(?:→|->|=>|—|–|:)?\s*(crash-free|healthy|ok|good|pass(?:ing)?|crash(?:es|ing)?|bad|unhealthy|broken|fail(?:ing)?)\b/i,
    );
    if (!match?.[1] || !match[2]) continue;
    remember(match[1], classifyStatus(match[2]));
  }

  return [...found.values()];
}

export function parseCommitCount(text?: string): number | undefined {
  if (!text) return undefined;
  const between = text.match(/(\d+)\s+commits?\s+between\b/i)?.[1];
  const diagram = text.match(/(?:^|\n)\s*(\d+)\s+commits\s*(?:\n|$)/i)?.[1];
  const raw = between ?? diagram;
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Last patch before `1.0.181` → `1.0.180`. */
export function previousPatch(version?: string): string | undefined {
  const normalized = version ? normalizeVersion(version) : undefined;
  const match = normalized?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match?.[1] || !match[2] || match[3] == null) return undefined;
  const patch = Number.parseInt(match[3], 10);
  if (!Number.isFinite(patch) || patch <= 0) return undefined;
  return `${match[1]}.${match[2]}.${patch - 1}`;
}

export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

export function displayVersion(version: string): string {
  const normalized = normalizeVersion(version);
  return normalized ? `v${normalized}` : version;
}

/**
 * First crashing release after a healthy one, in semver order.
 * `v1.0.180` healthy + `v1.0.181`/`v1.0.182` crashing → first bad is `1.0.181`.
 */
export function detectFirstBadVersion(input: {
  versions?: VersionHealth[];
  current?: string;
  extraContext?: string;
  commitCount?: number;
  commits?: GitCommit[];
}): FirstBadVersion | undefined {
  const parsed = input.versions?.length ? input.versions : parseVersionHealth(input.extraContext);
  if (!parsed.length) return undefined;
  const versions = mergeCurrentVersion(parsed, input.current);

  const sorted = [...versions].sort((a, b) => compareVersions(a.version, b.version));
  let lastHealthy: string | undefined;
  let lastHealthySource: VersionHealth["source"] | undefined;
  let firstBad: string | undefined;
  const laterBad: string[] = [];

  for (const row of sorted) {
    if (row.status === "healthy") {
      if (!firstBad) {
        lastHealthy = row.version;
        lastHealthySource = row.source;
      }
      continue;
    }
    if (row.status !== "crashes") continue;
    if (!firstBad) {
      firstBad = row.version;
      continue;
    }
    laterBad.push(row.version);
  }

  if (!firstBad) return undefined;

  let inferredLastHealthy = false;
  if (!lastHealthy) {
    lastHealthy = previousPatch(firstBad);
    inferredLastHealthy = Boolean(lastHealthy);
    lastHealthySource = lastHealthy ? "inferred" : undefined;
  } else {
    inferredLastHealthy = lastHealthySource === "inferred";
  }

  const commitCount = input.commitCount ?? parseCommitCount(input.extraContext) ?? 0;
  const commits = input.commits ?? [];
  return buildResult({
    lastHealthy,
    firstBad,
    laterBad,
    versions: sorted,
    commitCount,
    commits,
    inferredLastHealthy,
  });
}

/** Resolve last-healthy → first-bad git tags and list the commits in that window. */
export async function investigateFirstBadVersion(input: {
  repoPath: string;
  bug?: BugInput;
  version?: string;
  extraContext?: string;
}): Promise<FirstBadVersion | undefined> {
  const extraContext = [input.extraContext, input.bug?.extraContext, input.bug?.logText, input.bug?.message]
    .filter(Boolean)
    .join("\n");
  const current = input.version ?? input.bug?.version;
  const detected = detectFirstBadVersion({ current, extraContext });

  const lastHealthy = detected?.lastHealthy ?? (current ? previousPatch(current) : undefined);
  const firstBad = detected?.firstBad ?? (current ? normalizeVersion(current) : undefined);
  if (!firstBad || !lastHealthy) return detected;

  const fromRef = await resolveVersionRef(input.repoPath, lastHealthy);
  const toRef = await resolveVersionRef(input.repoPath, firstBad);
  if (!fromRef || !toRef) {
    if (detected) return { ...detected, fromRef, toRef };
    return undefined;
  }

  const [commitCount, commits] = await Promise.all([
    countCommitsBetween(input.repoPath, fromRef, toRef),
    listCommitsBetween(input.repoPath, fromRef, toRef),
  ]);

  const laterBad = detected?.laterBad ?? [];
  const versions =
    detected?.versions ??
    [
      { version: lastHealthy, status: "healthy" as const, source: "inferred" as const },
      { version: firstBad, status: "crashes" as const, source: "current" as const },
    ];

  return buildResult({
    lastHealthy,
    firstBad,
    laterBad,
    versions,
    commitCount,
    commits,
    fromRef,
    toRef,
    inferredLastHealthy: detected?.inferredLastHealthy ?? !detected,
  });
}

/**
 * Exact window diagram:
 *
 * v1.0.180
 *    ↓
 * 12 commits
 *    ↓
 * v1.0.181
 *    ↓
 * Crash begins
 */
export function renderFirstBadVersionAscii(result: FirstBadVersion): string {
  if (!result.lastHealthy) {
    return [displayVersion(result.firstBad), "   ↓", "Crash begins"].join("\n");
  }
  return [
    displayVersion(result.lastHealthy),
    "   ↓",
    `${result.commitCount} commits`,
    "   ↓",
    displayVersion(result.firstBad),
    "   ↓",
    "Crash begins",
  ].join("\n");
}

function buildResult(input: {
  lastHealthy?: string;
  firstBad: string;
  laterBad: string[];
  versions: VersionHealth[];
  commitCount: number;
  commits: GitCommit[];
  fromRef?: string;
  toRef?: string;
  inferredLastHealthy?: boolean;
}): FirstBadVersion {
  const window =
    input.commitCount > 0 && input.lastHealthy
      ? ` Investigate the ${input.commitCount} commits between ${displayVersion(input.lastHealthy)} and ${displayVersion(input.firstBad)}.`
      : input.lastHealthy
        ? ` Investigate commits between ${displayVersion(input.lastHealthy)} and ${displayVersion(input.firstBad)}.`
        : "";
  return {
    lastHealthy: input.lastHealthy,
    firstBad: input.firstBad,
    laterBad: input.laterBad,
    versions: input.versions,
    commitCount: input.commitCount,
    commits: input.commits,
    fromRef: input.fromRef,
    toRef: input.toRef,
    inferredLastHealthy: input.inferredLastHealthy,
    summary: `${displayVersion(input.firstBad)} is the first known bad version.${window}`,
  };
}

function mergeCurrentVersion(versions: VersionHealth[], current?: string): VersionHealth[] {
  if (!current) return versions;
  const normalized = normalizeVersion(current);
  if (!normalized) return versions;
  if (versions.some((row) => row.version === normalized)) return versions;
  return [...versions, { version: normalized, status: "crashes", source: "current" }];
}

function classifyStatus(raw: string): VersionHealthStatus {
  if (HEALTHY.test(raw)) return "healthy";
  if (CRASHING.test(raw)) return "crashes";
  return "unknown";
}

function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const da = left[i] ?? 0;
    const db = right[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

function versionParts(version: string): number[] {
  return normalizeVersion(version)
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function parseJsonVersions(text: string): VersionHealth[] {
  const candidates: unknown[] = [];
  try {
    candidates.push(JSON.parse(text));
  } catch {
    const match = text.match(/\{[\s\S]*"versions"\s*:\s*\[[\s\S]*\][\s\S]*\}/);
    if (match?.[0]) {
      try {
        candidates.push(JSON.parse(match[0]));
      } catch {
        return [];
      }
    }
  }

  const rows: VersionHealth[] = [];
  for (const candidate of candidates) {
    const list = Array.isArray(candidate)
      ? candidate
      : candidate && typeof candidate === "object" && Array.isArray((candidate as { versions?: unknown }).versions)
        ? (candidate as { versions: unknown[] }).versions
        : [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const row = item as { version?: unknown; status?: unknown; healthy?: unknown; crashes?: unknown };
      if (typeof row.version !== "string") continue;
      const status = jsonStatus(row);
      if (status === "unknown") continue;
      rows.push({ version: normalizeVersion(row.version), status, source: "reported" });
    }
  }
  return rows;
}

function jsonStatus(row: { status?: unknown; healthy?: unknown; crashes?: unknown }): VersionHealthStatus {
  if (typeof row.status === "string") return classifyStatus(row.status);
  if (row.healthy === true) return "healthy";
  if (row.healthy === false || row.crashes === true) return "crashes";
  return "unknown";
}
