# Debugging Copilot

An AI system that doesn't just explain errors — it **investigates a bug like an engineer**: gathers evidence, identifies the likely root cause, proposes a fix, and validates that fix.

```
                    ┌───────────────┐
                    │   Bug Report  │
                    └───────┬───────┘
                            ↓
                    Classify failure
                            ↓
                    🔍 Investigate
                            ↓
                    🧪 Reproduce
                            ↓
                    🧠 Root Cause
                            ↓
                    🔧 Generate Patch
                            ↓
                    🧪 Run Tests
                            ↓
                    ❌ Failed ──────┐
                            ↓        │
                          PASS       │
                            ↓        │
                    🔎 Validate      │
                            ↓        │
                       ┌───────┐     │
                       │ DONE  │     │
                       └───────┘     │
                            ↑        │
                            └────────┘
```

## What it does

1. **Collect evidence** from the repo and the crash: parsed stack frames, source around those lines, `git log` / `git blame`, merged PRs (via `gh`), related tests, overlapping dependencies, and runtime/CI context.
2. **Reproduce** the bug: understand symptoms, build a scenario, run tests (or generate a Flutter/JS regression), capture the failure, and compare it to the report.
3. **Root-cause analysis** with an evidence graph — ranked hypotheses plus supporting and contradicting evidence, not a free-form guess.
4. **Generate a fix** as exact search/replace edits.
5. **Patch → test → verify** in a bounded loop (`--max-iterations`, default 3). Failed tests restore the files, re-investigate, and modify the patch (`Attempt 1 → Tests failed` … `Attempt 3 → Tests passed`). After a pass it records a regression test and runs final verification.
6. **Write a debugging report** (Markdown + JSON) and open an **investigation board** (`--board`) with every stage, hypothesis, snippet, and test result.

Without an LLM key it still collects evidence and produces a heuristic report. With OpenAI, Anthropic, or a Cursor API key it generates and (optionally) applies a patch.

## Core agents

The copilot is an **orchestrator**, not one giant debugging prompt. Classification routes Crash, Network, Database, Flutter, and Dependency specialists; their findings feed Root Cause Agent.

```
                 Debugging Orchestrator
                          │
       ┌──────────┬───────┼────────┬──────────┐
       ↓          ↓       ↓        ↓          ↓
    Crash      Network   DB      Flutter   Dependency
       │          │       │        │          │
       └──────────┴───────┼────────┴──────────┘
                          ↓
                    Root Cause Agent
```

Specialists run in parallel where possible and hand off structured findings.

| Agent | Responsibility |
|---|---|
| **Log Analyzer** | Understand logs, exceptions and stack traces |
| **Failure Classifier** | Classify the failure before investigation and route specialists |
| **Crash Agent** | Specialize in runtime crashes, null derefs, and ANRs |
| **Network Agent** | Specialize in API, HTTP, and backend failures |
| **Database Agent** | Specialize in database and persistence failures |
| **Flutter Debugging Agent** | Understand Bloc, Dio, Drift, DI, lifecycle, widgets, async, platform channels, and iOS/Android builds |
| **Code Investigator** | Trace the error through the codebase |
| **Git Investigator** | Find when the bug appeared (git regression) |
| **Dependency Analyst** | Detect dependency/version-related issues |
| **Reproduction Agent** | Reproduce the issue and match it against the reported failure |
| **Root Cause Agent** | Build an evidence graph and rank possible causes |
| **Fix Agent** | Generate a minimal code fix |
| **Test Agent** | Create/run tests against the fix |
| **Validation Agent** | Check whether the fix actually resolves the issue |
| **Incident Agent** | Produce an engineer-friendly incident report |

Log Analyzer runs first. It parses exception chains (`Caused by`, nested errors), finds the crash site (top project frame), counts log levels, extracts timestamps and correlation IDs, and writes a handoff for later stages.

Code Investigator consumes that crash site and walks the source: enclosing function, inbound callers, callees, and the crashing expression.

Git Investigator answers **“When did this bug appear?”** It follows the current failure into git history, recent commits, file changes, and blame, then ranks a likely introducing commit. If a PR number is in the subject, files overlap a merged PR, or `gh` can search the SHA, it inspects that PR — it will not attach an unrelated first PR.

```
Current failure
      ↓
Git history
      ↓
Recent commits
      ↓
File changes
      ↓
Blame analysis
      ↓
Potential introducing commit
```

Example output:

```
Likely introduced by:

Commit: 8f31a2c
Author: Developer
PR: #421

Changed:
SavingsRepository.dart

Confidence: 89%
```

When version health is known, Git Investigator also names the **first bad version** and inspects the commit window after the last healthy release:

```
v1.0.180 → healthy
v1.0.181 → crashes
v1.0.182 → crashes
```

```
v1.0.180
   ↓
12 commits
   ↓
v1.0.181
   ↓
Crash begins
```

`v1.0.181` is the first known bad version. Later crashing builds (182) are treated as the same regression, not new introductions.

It then **automatically git-bisects** that window: test the middle commit, keep the good or bad half, and repeat until the introducing commit is isolated.

```
Good commit
     ↓
          Middle commit
          ↓
       Test
      ↙     ↘
   Good     Bad
     ↓       ↓
   search  search
      ↘     ↙
      Bad commit
```

The origin working tree is never checked out. Bisect uses `git show` (crash fingerprint) or an isolated worktree when a test command is available.

Dependency Analyst classifies missing modules, lockfile drift, peer-dep failures, and ESM/CJS mismatches so later stages do not patch application code for an install problem.

Reproduction Agent asks “can I reproduce this bug?”: it names the symptoms, builds a scenario, runs the app/tests (or generates a Flutter/JS regression test), captures the live failure, and compares it to the report. A match raises diagnosis confidence.

Root Cause Agent builds an **evidence graph** from crash → source → data → commit/PR, then ranks competing causes. Every conclusion lists supporting checks (stack, source, API/null, git, reproduction) and contradicting evidence, instead of a free-form explanation.

Fix Agent turns the leading cause into the smallest safe search/replace edit (optional chaining, nullish defaults, or an LLM patch). Every candidate gets a risk score — files changed, tests in range, modules touched, and confidence — and the agent prefers the **smallest safe fix that resolves the problem**. HIGH-risk patches are not applied to production code.

```
Fix A
────────────────
Change: 2 files
Tests: 18
Affected modules: 1
Risk: LOW
Confidence: 94%

Fix B
────────────────
Change: 7 files
Tests: 43
Affected modules: 4
Risk: HIGH
Confidence: 71%

Prefer: smallest safe fix that resolves the problem.
```

It will not patch application code when Dependency Analyst says the failure is an install/version issue.

**Rollback intelligence** asks whether a code change is even the right response. Sometimes the best fix is a rollback, a feature flag, a configuration change, or disabling the affected surface:

```
Incident
   ↓
Can safely patch?
 ├── YES → Patch
 │
 └── NO
      ↓
   Rollback?
      ↓
   Feature flag?
      ↓
   Configuration change?
      ↓
   Disable affected functionality?
```

Test Agent proposes a regression test around the crashing function and, with `--apply`, runs the suite against the patch.

Validation Agent judges whether the original issue is actually gone: patch applied, crash-site source updated, tests passing, original error absent from output, and a failing-then-passing flip.

Incident Agent writes a SEV-style report (what happened, impact, root cause, fix, validation, timeline, follow-ups) that an engineer can paste into Slack or a postmortem.

**Incident timeline** reconstructs the clock from deploy, metrics, first customer impact, git regression, and the fix/validation loop:

```
14:02  Deployment started
14:07  Deployment completed
14:11  Error rate increased
14:13  Crash threshold exceeded
14:15  First customer impact detected
14:18  Regression identified
14:23  Fix generated
14:27  Fix validated
```

**Autonomous incident response** connects detection through resolution, and keeps humans on destructive actions:

```
             Detection
                 ↓
          Investigation
                 ↓
            Diagnosis
                 ↓
          Risk Analysis
                 ↓
       ┌─────────┴─────────┐
       ↓                   ↓
    Rollback             Fix
       │                   │
       └─────────┬─────────┘
                 ↓
             Validation
                 ↓
            Monitoring
                 ↓
              RESOLVED
```

```
Read logs                 AUTO
Investigate               AUTO
Create reproduction       AUTO
Generate patch            AUTO
Run tests                 AUTO
Create PR                 AUTO
Deploy                    APPROVAL
Rollback production       APPROVAL
Delete/modify data        APPROVAL
```

`--apply` still writes a local (or sandbox) patch. It never deploys, never rolls back production, and never applies a delete/modify-data patch.

Before investigation, **Failure Classifier** splits the problem into Runtime / Build / Logic, then names a subtype (Null Crash, Gradle, Wrong state, …) and a routing category (runtime crash, build failure, dependency, API, database, UI, state, performance, race, environment, security). That routing starts Crash, Network, Database, Flutter, and Dependency specialists. Their findings feed **Root Cause Agent**.

The **Flutter Debugging Agent** inspects Bloc/Cubit, Dio, Drift, DI (get_it/injectable/riverpod), widget lifecycle, the widget tree, async gaps, platform channels, and iOS/Android build trees (`ios/`, `android/`).

**Environment-aware debugging** captures the local toolchain so “it works on my machine” becomes a ranked cause, especially for build and dependency failures:

```
Developer A
Flutter 3.44
Xcode 16.2

Developer B
Flutter 3.27
Xcode 15.1

Potential environment mismatch detected.
```

It also records Dart, Gradle, Kotlin, OS, device, build flavor, environment variables, pinned dependencies, git branch, and commit SHA. Pass `--baseline-env` or describe the other machine in `--context`.

**Production Incident Investigator** turns Crashlytics / Sentry / logs / metrics into an automatic investigation:

```
                 PRODUCTION INCIDENT
                         │
                         ↓
                 Incident Detection
                         │
          ┌──────────────┼──────────────┐
          ↓              ↓              ↓
       Logs           Crashes          Metrics
          │              │              │
          └──────────────┼──────────────┘
                         ↓
                 Correlation Engine
                         ↓
                  Root Cause Analysis
                         ↓
                  Blast-Radius Analysis
                         ↓
                  Regression Detection
                         ↓
                 Fix / Rollback Plan
                         ↓
                    Validation
                         ↓
                  Incident Report
```

`debug-copilot incident --source crashlytics --version 1.0.181 --affected-users 327 --first-seen "14:32 UTC" --metrics '{"errorRate":"4.2%","p95":1800}'` (or put those fields in `--context`).

The **Incident Correlation Engine** does not wait on a single stack trace. It connects independent signals when they line up:

```
Crash spike
   +
API latency spike
   +
Deployment 15 minutes earlier
   +
New dependency
   +
Specific app version
        ↓
Potential incident
```

That cluster is one incident: same deploy, same version, same new dependency, with crashes and latency moving together. The copilot then recommends rollback vs hotfix:

```
Production Crash

Version: 1.0.181
Affected users: 327
First seen: 14:32 UTC

Likely cause:
Recent Firebase initialization change

Confidence: 91%

Recommended action:
Rollback / hotfix
```

**Blast-radius analysis** asks **what else could this affect?** Once the root cause is known, it walks the change through the call graph, modules, features, APIs, database, and users:

```
Changed function
      ↓
Call graph
      ↓
Modules
      ↓
Features
      ↓
APIs
      ↓
Database
      ↓
Users
```

```
Blast Radius: HIGH

Direct:
- Savings screen

Indirect:
- Savings reports
- Shareout
- Member details

Potentially affected:
~32% of Savings workflows
```

**Debugging memory** turns each investigation into reusable knowledge:

```
Previous Incident
       ↓
Root cause
       ↓
Fix
       ↓
Resolution
       ↓
Store as knowledge
```

The next similar error searches `.debug-copilot/memory.json` and reports:

```
New error
   ↓
Similar historical incidents
   ↓
3 previous incidents had the same pattern
```

Root Cause Agent can rank that historical pattern, and Fix Agent is handed the previous fix as a starting point.

**Debugging knowledge graph** turns those stored incidents into organizational knowledge. Each investigation is a chain a later crash can reuse:

```
Incident
   ↓
Root Cause
   ↓
Commit
   ↓
Fix
   ↓
Affected Components
   ↓
Resolution
```

When a new error matches stored incidents, the graph reports:

```
This looks similar to 3 previous incidents.
```

The chain grows more valuable over time: the next similar crash already knows the introducing commit, the last fix, and which components were affected.

**Evals:** before calling the copilot autonomous, `debug-copilot evals` measures it on 100 labeled bugs:

| Metric | Target |
|---|---|
| Root-cause accuracy | >90% |
| Reproduction success | >85% |
| Fix success | >80% |
| Regression-test success | >90% |
| False root causes | <10% |
| Mean investigation time | ↓ |
| Human intervention | ↓ |

Each case is scored for those dimensions, then printed as:

```
DEBUGGING COPILOT EVALS

Metric                      Measured    Target
Root-cause accuracy         91%         >90%
Reproduction success        86%         >85%
Fix success                 82%         >80%
Regression-test success     93%         >90%
False root causes           7%          <10%
Mean investigation time     4m 21s      ↓
Human intervention          18%         ↓

Autonomy bar: met
```

Live `debug-copilot evals` prints measured rates from those 100 labeled bugs (not hardcoded). Mean investigation time and human intervention are trend metrics: they should fall as the copilot handles more of the loop without a person. The snapshot above is what a longer investigator-backed run can look like. The autonomy bar fails the command if a percentage target is missed.

Root-cause and fix prompts consume those briefings instead of re-reading raw logs and files from scratch.

## Autonomous debugging

`--autonomous` gives the agent a **controlled workspace** (a git worktree, or a clone/copy if worktrees are unavailable). Production code is never modified unless you also pass `--apply`, which promotes a validated patch.

```
Agent
 │
 ├── inspect repository
 ├── search code
 ├── inspect git history
 ├── run tests
 ├── reproduce error
 ├── modify code
 ├── run tests again
 ├── inspect diff
 └── revert if validation fails
```

Example (Flutter-style crash):

```bash
npx tsx src/cli.ts \
  --autonomous \
  --repo . \
  --error "Null check operator used on a null value" \
  --stack "SavingsMemberMediaBloc.dart:217" \
  --investigator heuristic
```

The CLI prints a boxed result:

```
╔══════════════════════════════════════╗
║ DEBUGGING RESULT                     ║
╚══════════════════════════════════════╝

Severity: HIGH
Confidence: 96%

Root Cause:
getSavingsMedia() can return null, but
SavingsMemberMediaBloc assumes the
response always exists.

Introduced:
Commit 8f31a2c Developer PR #421
SavingsRepository.dart 89%

Attempts:
Attempt 1 → Tests failed
Attempt 2 → Tests passed

Reproduction:
✓ Reproduced locally

Recommended Fix:
Handle null response before accessing
media.

Validation:
✓ Existing tests
✓ New regression test
✓ Full test suite

Risk:
LOW
```

`--apply` with `--autonomous` means **promote** the sandbox patch after validation. Without `--apply`, the origin working tree stays untouched even if the sandbox fix is confirmed.

## Setup

```bash
npm install
cp .env.example .env   # then fill in a key if you want generated patches
```

| Investigator | When it runs | What you need |
|---|---|---|
| `heuristic` | No API key, or `--investigator heuristic` | nothing |
| `openai` | `OPENAI_API_KEY` | OpenAI-compatible Chat Completions (`OPENAI_BASE_URL` for Azure, Groq, Ollama, …) |
| `anthropic` | `ANTHROPIC_API_KEY` | Anthropic Messages API |
| `cursor` | `CURSOR_API_KEY` | [`@cursor/sdk`](https://cursor.com/docs/sdk/typescript) (`npm install @cursor/sdk`) — the agent investigates inside the repo |

`auto` picks Cursor → OpenAI → Anthropic → heuristic, in that order.

## CLI

```bash
# Heuristic investigation of the bundled crashing cart
npx tsx src/cli.ts \
  --repo examples/failing-cart \
  --log examples/failing-cart/crash.log \
  --investigator heuristic

# LLM-generated patch, applied and verified
npx tsx src/cli.ts \
  --repo . \
  --error "TypeError: Cannot read properties of undefined (reading 'id')" \
  --log ./crash.log \
  --apply \
  --report ./debug-report.md \
  --json ./debug-report.json

# Pipe a stack trace on stdin
cat crash.log | npx tsx src/cli.ts --repo . --apply

# Investigate inside an isolated sandbox (does not write to the repo)
npx tsx src/cli.ts \
  --autonomous \
  --repo examples/failing-cart \
  --log examples/failing-cart/crash.log \
  --investigator heuristic

# Investigate and open the board
npm run board:example
# or reopen a saved report
npx tsx src/cli.ts board --json examples/failing-cart/debug-report.json

# Webpage: paste a repo path and stack/ANR dump (no trace file required)
npx tsx src/cli.ts board
# then open http://127.0.0.1:8787/new

# Run debugging evals
npx tsx src/cli.ts evals
```

```
debug-copilot [options]
debug-copilot incident [options]
debug-copilot evals

  --repo <path>           Repository to investigate (default: cwd)
  --error <text>          Error message
  --stack <text>          Stack trace (or pass via stdin)
  --log <path>            Path to a log file
  --test <path>           Failing test file or name
  --context <text>        Extra runtime context / env baseline
  --version <id>          Production app version
  --affected-users <n>    Production crash user count
  --first-seen <text>     First occurrence timestamp
  --source <name>         crashlytics | sentry | logs
  --metrics <json>        Production metrics (errorRate, p95, crash-free)
  --baseline-env <path>   JSON toolchain snapshot
  --autonomous            Investigate in an isolated sandbox
  --keep-sandbox          Leave the sandbox directory on disk
  --apply                 Apply the patch (promote from sandbox in --autonomous)
  --no-run-tests          Skip reproduction / verification
  --max-iterations <n>    Patch/test/verify loops (default: 3)
  --investigator <name>   auto | heuristic | openai | anthropic | cursor
  --model <id>            Override model id
  --report <path>         Markdown report (default: ./debug-report.md)
  --json <path>           JSON report
  --board                 Open the investigation board after the run
  --port <n>              Board port (default: 8787)
  --stdout                Print the markdown report
```

After `npm run build`, the binary is `debug-copilot`.

`debug-copilot board` starts the investigation webpage. Paste a local repo path (clone private GitHub repos first) and the Crashlytics / stack / ANR dump — you do not need `--log` or a trace file. The CLI flags still work for the same investigation.

The board opens with a **findings** strip: crash site (`file:line`), introducing commit, root cause, and the next action. Native/external frames (for example `MessageQueue.nativePollOnce`) are folded away from project frames so the dump is usable.

## Library

```ts
import { debugAutonomously, debugBug, renderDebugResult } from "debugging-copilot";

const result = await debugAutonomously(
  {
    repoPath: process.cwd(),
    message: "Null check operator used on a null value",
    stackTrace: "SavingsMemberMediaBloc.dart:217",
  },
  {
    repoPath: process.cwd(),
    apply: false,
    runTests: true,
  },
);

console.log(renderDebugResult(result.report));
console.log(result.promoted, result.reverted);
```

## CI

On a failing GitHub Actions job:

```yaml
- name: Investigate failure
  if: failure()
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
  run: |
    npx tsx src/cli.ts \
      --repo . \
      --error "${{ job.status }}" \
      --context "GitHub Actions ${{ github.workflow }} / ${{ github.job }}" \
      --report ./debug-report.md \
      --no-run-tests
```

Use `--apply` only in a throwaway job or bot branch — the default is report-only. Prefer `--autonomous` so investigation happens in a worktree; add `--apply` only when you intend to promote a validated patch.

## Project layout

```
src/
  cli.ts                 CLI entry
  pipeline.ts            Orchestrator
  autonomous/            Sandboxed inspect → patch → validate loop
  sandbox/               Isolated git worktree / clone / copy
  agents/                Specialist agents (Log Analyzer → Incident Agent)
  collectors/            Evidence: source, git, PRs, tests, deps, runtime
  analysis/              Reproduce, patch, verify
  llm/                   heuristic | openai | anthropic | cursor
  report/                Debugging report + boxed result
  board/                 Investigation board (HTML + local server)
examples/failing-cart/   Known-bad cart used as a demo
```

## Development

```bash
npm test
npm run typecheck
npm run build
```
