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

Dependency Analyst classifies missing modules, lockfile drift, peer-dep failures, and ESM/CJS mismatches so later stages do not patch application code for an install problem.

Reproduction Agent asks “can I reproduce this bug?”: it names the symptoms, builds a scenario, runs the app/tests (or generates a Flutter/JS regression test), captures the live failure, and compares it to the report. A match raises diagnosis confidence.

Root Cause Agent builds an **evidence graph** from crash → source → data → commit/PR, then ranks competing causes. Every conclusion lists supporting checks (stack, source, API/null, git, reproduction) and contradicting evidence, instead of a free-form explanation.

Fix Agent turns the leading cause into the smallest search/replace edit (optional chaining, nullish defaults, or an LLM patch). It will not patch application code when Dependency Analyst says the failure is an install/version issue.

Test Agent proposes a regression test around the crashing function and, with `--apply`, runs the suite against the patch.

Validation Agent judges whether the original issue is actually gone: patch applied, crash-site source updated, tests passing, original error absent from output, and a failing-then-passing flip.

Incident Agent writes a SEV-style report (what happened, impact, root cause, fix, validation, timeline, follow-ups) that an engineer can paste into Slack or a postmortem.

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

**Production incident mode** connects Crashlytics / Sentry / logs to the same investigation:

```
Crashlytics / Sentry / Logs
             ↓
       Incident Agent
             ↓
     Group similar crashes
             ↓
       Find affected version
             ↓
       Find first occurrence
             ↓
       Git regression
             ↓
       Root cause
             ↓
       Suggested fix
```

Pass `--source crashlytics|sentry|logs`, `--version`, `--affected-users`, and `--first-seen` (or put those fields in `--context`). Incident Agent groups similar crashes from debugging memory, ties the blast to a git introducing commit, and recommends rollback vs hotfix:

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

**Blast-radius analysis** asks **what else could this change break?** After the crash origin is known, it lists consumers (blocs, screens) and ranks product surfaces HIGH vs LOW:

```
Bug
 ↓
SavingsRepository
 ↓
Used by
 ├── SavingsBloc
 ├── SavingsDetailsBloc
 ├── ReportsBloc
 └── ShareoutBloc

Potential blast radius:

HIGH
├── Savings screen
├── Savings reports
└── Shareout calculation

LOW
└── Media screen
```

**Debugging memory** stores resolved incidents in `.debug-copilot/memory.json` and, on the next similar error, reports how many previous incidents matched the same pattern.

**Evals:** `debug-copilot evals` runs a debugging benchmark (classification, environment mismatch, blast radius, memory, patch-loop) and prints:

```
DEBUGGING COPILOT EVALS

Root Cause Accuracy       91%
Reproduction Rate         84%
Fix Success Rate          78%
Regression Test Rate      93%
False Positive Rate        7%
Avg. Debug Time           4m 21s
```

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

# Run debugging evals
npx tsx src/cli.ts evals
```

```
debug-copilot [options]
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
