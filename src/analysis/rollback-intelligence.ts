import { previousPatch } from "./first-bad-version.js";
import { mergeProductionInput } from "./production.js";
import type {
  BlastRadiusAnalysis,
  BugInput,
  CauseAnalysis,
  CodeInvestigation,
  DependencyAnalysis,
  EnvironmentAnalysis,
  FixAnalysis,
  GitInvestigation,
  MitigationAction,
  RollbackIntelligence,
  ValidationAnalysis,
} from "../types.js";

export const ROLLBACK_INTELLIGENCE_FLOW = [
  "Incident",
  "   ↓",
  "Can safely patch?",
  " ├── YES → Patch",
  " │",
  " └── NO",
  "      ↓",
  "   Rollback?",
  "      ↓",
  "   Feature flag?",
  "      ↓",
  "   Configuration change?",
  "      ↓",
  "   Disable affected functionality?",
].join("\n");

const ACTION_ORDER: MitigationAction[] = ["patch", "rollback", "feature-flag", "configuration", "disable"];

export function buildRollbackIntelligence(input: RollbackIntelligenceInput = {}): RollbackIntelligence {
  const bug = input.bug ? mergeProductionInput(input.bug) : undefined;
  const safety = assessPatchSafety({ ...input, bug });
  const canSafelyPatch = safety.ok;
  const rollbackTarget = rollbackTargetOf(input, bug);
  const flag = detectFeatureFlag(input, bug);
  const config = configurationTarget(input);
  const disableTarget =
    input.blastRadius?.direct[0] ?? input.blastRadius?.origin ?? input.fixAnalysis?.proposal.edits[0]?.path;

  let action: MitigationAction = "patch";
  let target: string | undefined = input.fixAnalysis?.proposal.edits[0]?.path;
  let reason = safety.ok ? "Smallest safe code fix is available." : safety.reason;

  if (!canSafelyPatch) {
    if (rollbackTarget) {
      action = "rollback";
      target = rollbackTarget;
      reason = safety.reason;
    } else if (flag) {
      action = "feature-flag";
      target = flag;
      reason = safety.reason;
    } else if (config) {
      action = "configuration";
      target = config;
      reason = safety.reason;
    } else {
      action = "disable";
      target = disableTarget;
      reason = safety.reason;
    }
  }

  const fallbacks = ACTION_ORDER.filter((item) => item !== action && item !== "patch");
  const steps = stepsFor(action, target, input);
  const summary = canSafelyPatch
    ? `Can safely patch: YES → Patch${target ? ` (${target})` : ""}.`
    : `Can safely patch: NO → ${actionTitle(action)}${target ? ` (${target})` : ""}.`;

  return { canSafelyPatch, action, target, reason, fallbacks, steps, summary };
}

export function canSafelyPatch(input: RollbackIntelligenceInput = {}): boolean {
  return assessPatchSafety(input).ok;
}

/**
 * Incident
 *    ↓
 * Can safely patch?
 *  ├── YES → Patch
 *  │
 *  └── NO
 *       ↓
 *    Rollback?
 */
export function renderRollbackIntelligenceAscii(analysis?: RollbackIntelligence): string {
  if (!analysis) return ROLLBACK_INTELLIGENCE_FLOW;
  const then =
    analysis.action === "patch" || !analysis.fallbacks.length
      ? undefined
      : `Then: ${analysis.fallbacks.map(actionTitle).join(" → ")}`;
  return [
    ROLLBACK_INTELLIGENCE_FLOW,
    "",
    `Can safely patch: ${analysis.canSafelyPatch ? "YES" : "NO"}`,
    `Recommended: ${actionTitle(analysis.action)}`,
    analysis.target ? `Target: ${analysis.target}` : undefined,
    `Reason: ${analysis.reason}`,
    then,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function actionTitle(action: MitigationAction): string {
  if (action === "patch") return "Patch";
  if (action === "rollback") return "Rollback";
  if (action === "feature-flag") return "Feature flag";
  if (action === "configuration") return "Configuration change";
  return "Disable affected functionality";
}

export interface RollbackIntelligenceInput {
  bug?: BugInput;
  fixAnalysis?: FixAnalysis;
  blastRadius?: BlastRadiusAnalysis;
  gitInvestigation?: GitInvestigation;
  validation?: ValidationAnalysis;
  causeAnalysis?: CauseAnalysis;
  environment?: EnvironmentAnalysis;
  dependencyAnalysis?: DependencyAnalysis;
  codeInvestigation?: CodeInvestigation;
}

function assessPatchSafety(input: RollbackIntelligenceInput): { ok: boolean; reason: string } {
  const bug = input.bug ? mergeProductionInput(input.bug) : input.bug;
  const strategy = input.fixAnalysis?.strategy;
  const risk = input.fixAnalysis?.risk?.level;
  const users = bug?.affectedUsers ?? 0;
  const introducing = Boolean(input.gitInvestigation?.introducing);

  if (strategy === "dependency-install" || strategy === "environment-align") {
    return { ok: false, reason: "Do not patch application code for an install or toolchain issue." };
  }
  if (risk === "HIGH") {
    return { ok: false, reason: "HIGH-risk code change is not a safe production patch." };
  }
  if (users >= 100 && introducing) {
    return {
      ok: false,
      reason: `${users} users after a known-bad deploy. Do not ship a code patch first.`,
    };
  }
  if (users >= 100 && input.blastRadius?.severity === "HIGH" && risk !== "LOW") {
    return { ok: false, reason: `HIGH blast radius with ${users} affected users.` };
  }
  return { ok: true, reason: "Smallest safe code fix is available." };
}

function rollbackTargetOf(input: RollbackIntelligenceInput, bug?: BugInput): string | undefined {
  return (
    input.gitInvestigation?.firstBadVersion?.lastHealthy ??
    previousPatch(bug?.version) ??
    (input.gitInvestigation?.introducing ? input.gitInvestigation.introducing.sha.slice(0, 8) : undefined)
  );
}

function detectFeatureFlag(input: RollbackIntelligenceInput, bug?: BugInput): string | undefined {
  const blobs = [
    bug?.extraContext,
    bug?.message,
    bug?.logText,
    ...(input.codeInvestigation?.snippets.map((snippet) => `${snippet.file}\n${snippet.content}`) ?? []),
    ...(input.codeInvestigation?.suspects ?? []),
    ...(input.fixAnalysis?.proposal.edits.map((edit) => `${edit.path}\n${edit.newString}`) ?? []),
  ]
    .filter((item): item is string => Boolean(item))
    .join("\n");
  if (!blobs) return undefined;
  const named = blobs.match(
    /(?:feature[_\s-]?flag|remote[_\s-]?config|launchdarkly|unleash|statsig)\s*[:=]?\s*([A-Za-z][A-Za-z0-9_.:-]*)/i,
  );
  if (named?.[1] && !/^(flag|config|key)$/i.test(named[1])) return named[1];
  if (/feature[_\s-]?flag|launchdarkly|unleash|statsig|remote[_\s-]?config|FeatureFlag/i.test(blobs)) {
    return "feature flag";
  }
  return undefined;
}

function configurationTarget(input: RollbackIntelligenceInput): string | undefined {
  if (input.environment?.mismatches[0]) {
    const mismatch = input.environment.mismatches[0];
    return `${mismatch.tool} ${mismatch.expected}`;
  }
  if (input.dependencyAnalysis?.likelyDependencyBug) {
    return input.dependencyAnalysis.issues[0]?.package ?? "dependency pin";
  }
  if (input.causeAnalysis?.leading?.kind === "environment" || input.causeAnalysis?.leading?.kind === "dependency") {
    return input.causeAnalysis.leading.kind;
  }
  if (input.fixAnalysis?.strategy === "environment-align" || input.fixAnalysis?.strategy === "dependency-install") {
    return input.fixAnalysis.strategy;
  }
  return undefined;
}

function stepsFor(action: MitigationAction, target: string | undefined, input: RollbackIntelligenceInput): string[] {
  if (action === "patch") {
    return [
      input.fixAnalysis?.proposal.summary || "Apply the smallest safe code fix.",
      "Run tests against the patch.",
      "Watch error rate after rollout.",
    ];
  }
  if (action === "rollback") {
    return [
      target ? `Roll back to ${target}` : "Roll back the latest production release",
      "Watch crash-free users and error rate until they recover",
      "Follow with a targeted hotfix on a later release",
    ];
  }
  if (action === "feature-flag") {
    return [
      target ? `Turn off ${target}` : "Disable the feature flag for the failing surface",
      "Watch error rate / crash-free users",
      "Ship a small patch behind the flag once the incident is contained",
    ];
  }
  if (action === "configuration") {
    return [
      target ? `Change ${target} rather than application code` : "Ship a configuration change, not a code patch",
      "Verify the failing environment matches the working baseline",
      "Only then consider a code fix",
    ];
  }
  return [
    target ? `Disable ${target}` : "Disable the affected functionality",
    "Restore service for everyone else",
    "Follow with a contained patch or rollback",
  ];
}
