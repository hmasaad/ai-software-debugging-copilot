# Debugging Copilot

An AI system that doesn't just explain errors — it **investigates a bug like an engineer**: gathers evidence, identifies the likely root cause, proposes a fix, and validates that fix.

```
Bug / Error / Crash
        ↓
┌─────────────────────┐
│ Debugging Copilot   │
└─────────────────────┘
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

Log Analyzer runs first. It parses exception chains (`Caused by`, nested errors), finds the crash site (top project frame), counts log levels, extracts timestamps and correlation IDs, and writes a handoff for later stages. Root-cause and fix prompts consume that briefing instead of re-reading raw logs from scratch.

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
  --apply                 Apply the generated patch
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
import { debugBug } from "debugging-copilot";

const report = await debugBug(
  {
    repoPath: process.cwd(),
    message: "TypeError: Cannot read properties of undefined (reading 'id')",
    logPath: "./crash.log",
  },
  {
    repoPath: process.cwd(),
    apply: true,
    runTests: true,
    reportPath: "./debug-report.md",
  },
);

console.log(report.rootCause.rootCause);
console.log(report.verification.passed);
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

Use `--apply` only in a throwaway job or bot branch — the default is report-only.

## Project layout

```
src/
  cli.ts                 CLI entry
  pipeline.ts            Orchestrator
  agents/                Specialist agents (Log Analyzer first)
  collectors/            Evidence: source, git, PRs, tests, deps, runtime
  analysis/              Reproduce, patch, verify
  llm/                   heuristic | openai | anthropic | cursor
  report/                Debugging report
  board/                 Investigation board (HTML + local server)
examples/failing-cart/   Known-bad cart used as a demo
```

## Development

```bash
npm test
npm run typecheck
npm run build
```
