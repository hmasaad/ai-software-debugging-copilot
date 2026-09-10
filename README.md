# Debugging Copilot

An AI system that doesn't just explain errors — it **investigates a bug like an engineer**: gathers evidence, identifies the likely root cause, proposes a fix, and validates that fix.

```
Bug / Error / Crash
        ↓
┌─────────────────────────┐
│ Debugging Copilot       │
│  (optional sandbox)     │
└─────────────────────────┘
        ↓
  Collect Evidence
   ├── Error logs
   ├── Stack trace
   ├── Source code
   ├── Git history
   ├── Recent PRs
   ├── Tests
   ├── Dependencies
   └── Runtime context
        ↓
  Analyze & Reproduce
        ↓
  Root Cause Analysis
        ↓
  Generate Fix
        ↓
  Run Tests
        ↓
  Verify Fix
        ↓
  ┌──────────────────┐
  │ Debugging Report │
  └──────────────────┘
```

## What it does

1. **Collect evidence** from the repo and the crash: parsed stack frames, source around those lines, `git log` / `git blame`, merged PRs (via `gh`), related tests, overlapping dependencies, and runtime/CI context.
2. **Analyze and reproduce** by running the project's test runner when one is detected.
3. **Root-cause analysis** — ranked hypotheses with evidence, not a single guess.
4. **Generate a fix** as exact search/replace edits.
5. **Apply, test, verify** — if tests fail, restore the files and iterate.
6. **Write a debugging report** (Markdown + JSON) and open an **investigation board** (`--board`) with every stage, hypothesis, snippet, and test result.

Without an LLM key it still collects evidence and produces a heuristic report. With OpenAI, Anthropic, or a Cursor API key it generates and (optionally) applies a patch.

## Core agents

The copilot is an **orchestrator**, not one giant debugging prompt. Specialists run in sequence and hand off structured findings.

| Agent | Responsibility |
|---|---|
| **Log Analyzer** | Understand logs, exceptions and stack traces |
| **Code Investigator** | Trace the error through the codebase |
| **Git Investigator** | Find commits/PRs that introduced the problem |
| **Dependency Analyst** | Detect dependency/version-related issues |
| **Reproduction Agent** | Determine how to reproduce the issue |
| **Root Cause Agent** | Build and rank possible causes |
| **Fix Agent** | Generate a minimal code fix |
| **Test Agent** | Create/run tests against the fix |
| **Validation Agent** | Check whether the fix actually resolves the issue |
| **Incident Agent** | Produce an engineer-friendly incident report |

Log Analyzer runs first. It parses exception chains (`Caused by`, nested errors), finds the crash site (top project frame), counts log levels, extracts timestamps and correlation IDs, and writes a handoff for later stages.

Code Investigator consumes that crash site and walks the source: enclosing function, inbound callers, callees, and the crashing expression.

Git Investigator ranks introducing commits with blame on the crash line, pickaxe (`git log -S`) on Code Investigator suspects, and overlapping merged PRs.

Dependency Analyst classifies missing modules, lockfile drift, peer-dep failures, and ESM/CJS mismatches so later stages do not patch application code for an install problem.

Reproduction Agent picks a command (failing test, related test, or the suite), writes replay steps from the crash site, and optionally runs it.

Root Cause Agent ranks competing causes from those briefings — crash site, null deref, introducing commit, dependency, environment — before a patch is written.

Fix Agent turns the leading cause into the smallest search/replace edit (optional chaining, nullish defaults, or an LLM patch). It will not patch application code when Dependency Analyst says the failure is an install/version issue.

Test Agent proposes a regression test around the crashing function and, with `--apply`, runs the suite against the patch.

Validation Agent judges whether the original issue is actually gone: patch applied, crash-site source updated, tests passing, original error absent from output, and a failing-then-passing flip.

Incident Agent writes a SEV-style report (what happened, impact, root cause, fix, validation, timeline, follow-ups) that an engineer can paste into Slack or a postmortem.

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
Commit 8f31a2c
PR #421

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
```

```
debug-copilot [options]

  --repo <path>           Repository to investigate (default: cwd)
  --error <text>          Error message
  --stack <text>          Stack trace (or pass via stdin)
  --log <path>            Path to a log file
  --test <path>           Failing test file or name
  --context <text>        Extra runtime context
  --autonomous            Investigate in an isolated sandbox
  --keep-sandbox          Leave the sandbox directory on disk
  --apply                 Apply the patch (promote from sandbox in --autonomous)
  --no-run-tests          Skip reproduction / verification
  --max-iterations <n>    Fix/verify loops (default: 2)
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
