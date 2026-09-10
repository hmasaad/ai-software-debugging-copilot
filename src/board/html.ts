import type {
  AgentRun,
  CauseAnalysis,
  CodeInvestigation,
  DebuggingReport,
  DependencyAnalysis,
  FixAnalysis,
  GitInvestigation,
  Hypothesis,
  IncidentReport,
  LogAnalysis,
  ReproductionAnalysis,
  StackFrame,
  TestAnalysis,
  ValidationAnalysis,
} from "../types.js";

export function renderInvestigationBoard(report: DebuggingReport): string {
  const e = report.evidence;
  const rca = report.rootCause;
  const fix = report.proposedFix;
  const repro = report.reproduction;
  const verify = report.verification;

  const stages = [
    { id: "evidence", label: "Evidence", state: "done", detail: `${e.error.frames.length} frames · ${e.sourceSnippets.length} snippets` },
    {
      id: "reproduce",
      label: "Reproduce",
      state: repro.reproduced ? "danger" : repro.attempted ? "done" : "skip",
      detail: repro.reproduced ? "Failure reproduced" : repro.attempted ? "Did not fail" : "Skipped",
    },
    {
      id: "rca",
      label: "Root cause",
      state: "done",
      detail: `${pct(rca.confidence)} · ${rca.investigator}`,
    },
    {
      id: "fix",
      label: "Fix",
      state: fix.applied ? "done" : fix.edits.length ? "pending" : "skip",
      detail: fix.applied ? "Applied" : fix.edits.length ? `${fix.edits.length} edit(s)` : "Proposal only",
    },
    {
      id: "verify",
      label: "Verify",
      state: verify.passed ? "done" : verify.testsRan ? "danger" : "skip",
      detail: verify.passed ? "Tests passed" : verify.testsRan ? "Tests failed" : "Not run",
    },
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(report.title)}</title>
  <style>${BOARD_CSS}</style>
</head>
<body>
  <header class="hero">
    <div class="kicker">Investigation board</div>
    <h1>${esc(report.error.type ?? "Error")}: ${esc(clip(report.error.message, 120))}</h1>
    <p class="sub">${esc(shortPath(report.repoPath))} · ${esc(formatTime(report.createdAt))} · ${esc(rca.investigator)}</p>
    <div class="stats">
      ${stat(pct(rca.confidence), "Confidence", rca.confidence >= 0.7 ? "ok" : "warn")}
      ${stat(repro.reproduced ? "Yes" : repro.attempted ? "No" : "—", "Reproduced", repro.reproduced ? "bad" : "ok")}
      ${stat(String(rca.hypotheses.length), "Hypotheses")}
      ${stat(fix.applied ? "Applied" : "Not applied", "Patch", fix.applied ? "ok" : "warn")}
      ${stat(verify.passed ? "Passed" : verify.testsRan ? "Failed" : "Skipped", "Verification", verify.passed ? "ok" : verify.testsRan ? "bad" : "")}
      ${stat(report.validationAnalysis.verdict, "Validation", report.validationAnalysis.resolved ? "ok" : report.validationAnalysis.verdict === "unresolved" ? "bad" : "warn")}
      ${stat(report.incidentReport.severity.toUpperCase(), "Incident", report.incidentReport.status === "resolved" ? "ok" : "warn")}
    </div>
  </header>

  <ol class="pipeline">
    ${stages
      .map(
        (stage, i) => `<li class="pipe ${stage.state}">
      <span class="idx">${i + 1}</span>
      <span>
        <strong>${esc(stage.label)}</strong>
        <em>${esc(stage.detail)}</em>
      </span>
    </li>`,
      )
      .join("")}
  </ol>

  ${report.notes.length ? `<div class="notes">${report.notes.map((n) => `<p>${esc(n)}</p>`).join("")}</div>` : ""}

  ${agentsStrip(report.agentRuns)}

  ${incidentBanner(report.incidentReport)}

  <section class="board" aria-label="Investigation columns">
    <article class="col" id="col-evidence">
      <h2>Collect evidence</h2>
      ${logAnalyzerCard(report.logAnalysis)}
      ${codeInvestigatorCard(report.codeInvestigation)}
      ${gitInvestigatorCard(report.gitInvestigation)}
      ${dependencyAnalystCard(report.dependencyAnalysis)}
      <div class="card">
        <h3>Error</h3>
        <p class="lead">${esc(report.error.type ?? "Error")}: ${esc(report.error.message)}</p>
        <p class="meta">Language ${esc(report.error.language ?? "unknown")} · logs: ${esc(e.logs.sources.join(", ") || "none")}</p>
      </div>
      ${stackCard(e.error.frames)}
      ${e.sourceSnippets
        .map(
          (s) => `<div class="card">
        <h3>${esc(s.file)}${s.focusLine ? `:${s.focusLine}` : ""}</h3>
        <pre class="code">${esc(s.content)}</pre>
      </div>`,
        )
        .join("")}
      ${
        e.tests.relatedTests.length || e.tests.runner
          ? `<div class="card">
        <h3>Tests</h3>
        <p class="meta">Runner <code>${esc(e.tests.runner ?? "unknown")}</code> · <code>${esc(e.tests.testCommand ?? "n/a")}</code></p>
        ${
          e.tests.relatedTests.length
            ? `<ul>${e.tests.relatedTests.map((t) => `<li><code>${esc(t.file)}</code> — ${esc(t.reason)}</li>`).join("")}</ul>`
            : ""
        }
      </div>`
          : ""
      }
      ${runtimeCard(e)}
      ${gitCard(e)}
      ${
        e.pullRequests.length
          ? `<div class="card"><h3>Recent PRs</h3><ul>${e.pullRequests
              .map((pr) => `<li>#${pr.number} ${esc(pr.title)} (${esc(pr.state)})</li>`)
              .join("")}</ul></div>`
          : ""
      }
      ${
        e.dependencies.hits.length
          ? `<div class="card"><h3>Dependencies</h3><ul>${e.dependencies.hits
              .map((d) => `<li>${esc(d.name)}${d.version ? ` @ ${esc(d.version)}` : ""}</li>`)
              .join("")}</ul></div>`
          : ""
      }
    </article>

    <article class="col" id="col-reproduce">
      <h2>Analyze &amp; reproduce</h2>
      ${reproductionAgentCard(report.reproductionAnalysis)}
      <div class="card ${repro.reproduced ? "tint-bad" : ""}">
        <h3>Reproduction</h3>
        <p class="lead">${esc(repro.summary)}</p>
        ${repro.command ? `<p class="meta">Command <code>${esc(repro.command)}</code>${repro.exitCode != null ? ` · exit ${repro.exitCode}` : ""}</p>` : ""}
      </div>
      ${repro.output ? `<div class="card"><h3>Test output</h3><pre class="code">${esc(repro.output)}</pre></div>` : ""}
      ${
        rca.reproSteps.length
          ? `<div class="card"><h3>Repro steps</h3><ol>${rca.reproSteps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></div>`
          : ""
      }
    </article>

    <article class="col" id="col-rca">
      <h2>Root cause analysis</h2>
      ${rootCauseAgentCard(report.causeAnalysis)}
      <div class="card tint-warn">
        <h3>Likely root cause</h3>
        <p class="lead">${esc(rca.rootCause)}</p>
        <p>${esc(rca.summary)}</p>
        ${
          rca.affectedFiles.length
            ? `<p class="meta">Affected ${rca.affectedFiles.map((f) => `<code>${esc(f)}</code>`).join(", ")}</p>`
            : ""
        }
      </div>
      ${rca.hypotheses.map((h) => hypothesisCard(h)).join("")}
    </article>

    <article class="col" id="col-fix">
      <h2>Fix &amp; verify</h2>
      ${fixAgentCard(report.fixAnalysis)}
      ${testAgentCard(report.testAnalysis)}
      ${validationAgentCard(report.validationAnalysis)}
      <div class="card">
        <h3>Proposed fix</h3>
        <p class="lead">${esc(fix.summary)}</p>
        ${fix.rationale ? `<p>${esc(fix.rationale)}</p>` : ""}
        <p class="meta">${fix.applied ? "Applied to the working tree" : "Not applied"}</p>
      </div>
      ${fix.edits
        .map(
          (edit) => `<div class="card">
        <h3>${esc(edit.path)}</h3>
        <pre class="diff"><span class="del">- ${esc(oneLine(edit.oldString))}</span>
<span class="add">+ ${esc(oneLine(edit.newString))}</span></pre>
      </div>`,
        )
        .join("")}
      ${
        fix.testPlan.length
          ? `<div class="card"><h3>Test plan</h3><ul>${fix.testPlan.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>`
          : ""
      }
      ${
        fix.risks.length
          ? `<div class="card"><h3>Risks</h3><ul>${fix.risks.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>`
          : ""
      }
      ${
        fix.applyErrors.length
          ? `<div class="card"><h3>Apply notes</h3><ul>${fix.applyErrors.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>`
          : ""
      }
      <div class="card ${verify.passed ? "tint-ok" : verify.testsRan ? "tint-bad" : ""}">
        <h3>Verification</h3>
        <p class="lead">${esc(verify.summary)}</p>
        ${verify.command ? `<p class="meta">Command <code>${esc(verify.command)}</code></p>` : ""}
        ${verify.output ? `<pre class="code">${esc(verify.output)}</pre>` : ""}
      </div>
      ${
        report.iterations.length
          ? `<div class="card"><h3>Iterations</h3><ol>${report.iterations
              .map((it) => {
                const status = it.verification.passed ? "passed" : it.verification.testsRan ? "failed" : "not run";
                return `<li>Pass ${it.index + 1}: ${esc(it.rootCause.investigator)} — tests ${status}. ${esc(it.fix.summary)}</li>`;
              })
              .join("")}</ol></div>`
          : ""
      }
    </article>
  </section>

  ${
    e.logs.excerpt
      ? `<section class="logs">
    <h2>Logs</h2>
    <pre class="code">${esc(e.logs.excerpt)}</pre>
  </section>`
      : ""
  }
</body>
</html>`;
}

function agentsStrip(runs: AgentRun[]): string {
  if (!runs.length) return "";
  return `<section class="agents" aria-label="Core agents">
    <h2>Core agents</h2>
    <ul>
      ${runs
        .map(
          (run) => `<li>
        <strong>${esc(run.name)}</strong>
        <em>${esc(run.responsibility)}</em>
        <p>${esc(run.summary)}</p>
      </li>`,
        )
        .join("")}
    </ul>
  </section>`;
}

function codeInvestigatorCard(analysis: CodeInvestigation): string {
  const steps = analysis.trace
    .map(
      (step) =>
        `<li><code>${esc(step.role)}</code> <code>${esc(step.file)}${step.line ? `:${step.line}` : ""}</code>${step.functionName ? ` ${esc(step.functionName)}` : ""} — ${esc(step.note)}</li>`,
    )
    .join("");
  const suspects = analysis.suspects.length
    ? `<p class="meta">Suspects ${analysis.suspects.map((name) => `<code>${esc(name)}</code>`).join(" ")}</p>`
    : "";
  const callers = analysis.callers.length
    ? `<ul>${analysis.callers
        .slice(0, 6)
        .map((caller) => `<li><code>${esc(caller.file)}:${caller.line}</code> ${esc(clip(caller.text, 120))}</li>`)
        .join("")}</ul>`
    : "";
  const handoff = analysis.handoff.length
    ? `<ul>${analysis.handoff.map((note) => `<li>${esc(note)}</li>`).join("")}</ul>`
    : "";

  return `<div class="card">
    <h3>Code Investigator</h3>
    <p class="meta">Trace the error through the codebase</p>
    <p class="lead">${esc(analysis.summary)}</p>
    ${steps ? `<ol class="frames">${steps}</ol>` : ""}
    ${suspects}
    ${callers}
    ${handoff}
  </div>`;
}

function validationAgentCard(analysis: ValidationAnalysis): string {
  const checks = analysis.checks
    .map(
      (check) =>
        `<li class="${check.passed ? "project" : ""}"><code>${esc(check.id)}</code> ${esc(check.detail)}<span class="scope">${check.passed ? "pass" : "fail"}</span></li>`,
    )
    .join("");
  const risks = analysis.residualRisks.length
    ? `<ul>${analysis.residualRisks.map((risk) => `<li>${esc(risk)}</li>`).join("")}</ul>`
    : "";
  const tone = analysis.resolved ? "tint-ok" : analysis.verdict === "unresolved" ? "tint-bad" : "tint-warn";

  return `<div class="card ${tone}">
    <h3>Validation Agent</h3>
    <p class="meta">Check whether the fix actually resolves the issue</p>
    <p class="lead">${esc(analysis.summary)}</p>
    ${checks ? `<ol class="frames">${checks}</ol>` : ""}
    ${risks}
  </div>`;
}

function incidentBanner(report: IncidentReport): string {
  const timeline = report.timeline
    .map((event) => `<li><strong>${esc(event.label)}</strong> ${esc(event.detail)}</li>`)
    .join("");
  const followUps = report.followUps.length
    ? `<ul>${report.followUps.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`
    : "";
  const tone = report.status === "resolved" ? "tint-ok" : report.status === "investigating" ? "tint-bad" : "tint-warn";

  return `<section class="incident ${tone === "tint-ok" ? "ok" : ""}" aria-label="Incident report">
    <div class="card ${tone}">
      <h3>Incident Agent</h3>
      <p class="meta">Produce an engineer-friendly incident report · ${esc(report.severity.toUpperCase())} · ${esc(report.status)}</p>
      <p class="lead">${esc(report.title)}</p>
      <p>${esc(report.whatHappened)}</p>
      <p class="meta">Impact ${esc(report.impact)}</p>
      <p><strong>Root cause.</strong> ${esc(report.rootCause)}</p>
      <p><strong>Fix.</strong> ${esc(report.fix)}</p>
      <p><strong>Validation.</strong> ${esc(report.validation)}</p>
      ${timeline ? `<ol class="frames">${timeline}</ol>` : ""}
      ${followUps}
    </div>
  </section>`;
}

function fixAgentCard(analysis: FixAnalysis): string {
  const edits = analysis.proposal.edits
    .map(
      (edit) =>
        `<pre class="diff"><span class="del">- ${esc(oneLine(edit.oldString))}</span>
<span class="add">+ ${esc(oneLine(edit.newString))}</span></pre>`,
    )
    .join("");
  const handoff = analysis.handoff.length
    ? `<ul>${analysis.handoff.map((note) => `<li>${esc(note)}</li>`).join("")}</ul>`
    : "";

  return `<div class="card ${analysis.proposal.applied ? "tint-ok" : analysis.proposal.edits.length ? "tint-warn" : ""}">
    <h3>Fix Agent</h3>
    <p class="meta">Generate a minimal code fix</p>
    <p class="lead">${esc(analysis.summary)}</p>
    <p class="meta">Strategy <code>${esc(analysis.strategy)}</code> · ${esc(analysis.source)}${analysis.proposal.applied ? " · applied" : ""}</p>
    ${edits}
    ${handoff}
  </div>`;
}

function testAgentCard(analysis: TestAnalysis): string {
  const proposed = analysis.proposedTest
    ? `<p class="meta">${analysis.proposedTest.created ? "Created" : "Proposed"} <code>${esc(analysis.proposedTest.path)}</code> — ${esc(analysis.proposedTest.reason)}</p>`
    : "";
  const handoff = analysis.handoff.length
    ? `<ul>${analysis.handoff.map((note) => `<li>${esc(note)}</li>`).join("")}</ul>`
    : "";
  const tone = analysis.verification.passed ? "tint-ok" : analysis.verification.testsRan ? "tint-bad" : "";

  return `<div class="card ${tone}">
    <h3>Test Agent</h3>
    <p class="meta">Create/run tests against the fix</p>
    <p class="lead">${esc(analysis.summary)}</p>
    ${proposed}
    ${handoff}
  </div>`;
}

function reproductionAgentCard(analysis: ReproductionAnalysis): string {
  const steps = analysis.steps.length
    ? `<ol>${analysis.steps.map((step) => `<li>${esc(step)}</li>`).join("")}</ol>`
    : "";
  const tests = analysis.relatedTests.length
    ? `<ul>${analysis.relatedTests
        .slice(0, 6)
        .map((test) => `<li><code>${esc(test.file)}</code> — ${esc(test.reason)}</li>`)
        .join("")}</ul>`
    : "";
  const handoff = analysis.handoff.length
    ? `<ul>${analysis.handoff.map((note) => `<li>${esc(note)}</li>`).join("")}</ul>`
    : "";
  const tone = analysis.result.reproduced ? "tint-bad" : analysis.result.attempted ? "tint-ok" : "";

  return `<div class="card ${tone}">
    <h3>Reproduction Agent</h3>
    <p class="meta">Determine how to reproduce the issue</p>
    <p class="lead">${esc(analysis.summary)}</p>
    <p class="meta">Method <code>${esc(analysis.method)}</code>${analysis.command ? ` · <code>${esc(analysis.command)}</code>` : ""}${analysis.runner ? ` · ${esc(analysis.runner)}` : ""}</p>
    ${steps}
    ${tests}
    ${handoff}
  </div>`;
}

function rootCauseAgentCard(analysis: CauseAnalysis): string {
  const causes = analysis.causes
    .map((cause) => {
      const width = Math.round(Math.min(100, Math.max(4, cause.likelihood * 100)));
      return `<li>
        <strong>${esc(cause.id)}</strong> <code>${esc(cause.kind)}</code> ${esc(cause.description)}
        <div class="meter" aria-label="Likelihood ${pct(cause.likelihood)}"><span style="width:${width}%"></span></div>
      </li>`;
    })
    .join("");
  const handoff = analysis.handoff.length
    ? `<ul>${analysis.handoff.map((note) => `<li>${esc(note)}</li>`).join("")}</ul>`
    : "";

  return `<div class="card tint-warn">
    <h3>Root Cause Agent</h3>
    <p class="meta">Build and rank possible causes</p>
    <p class="lead">${esc(analysis.summary)}</p>
    ${causes ? `<ol class="frames">${causes}</ol>` : ""}
    ${
      analysis.affectedFiles.length
        ? `<p class="meta">Affected ${analysis.affectedFiles.map((file) => `<code>${esc(file)}</code>`).join(", ")}</p>`
        : ""
    }
    ${handoff}
  </div>`;
}

function gitInvestigatorCard(analysis: GitInvestigation): string {
  const introducing = analysis.introducing
    ? `<p class="meta">Introducing <code>${esc(analysis.introducing.sha.slice(0, 8))}</code> ${esc(analysis.introducing.author)} (${esc(analysis.introducing.date)}) ${esc(analysis.introducing.subject)}</p>`
    : "";
  const suspects = analysis.suspects
    .slice(0, 6)
    .map(
      (commit) =>
        `<li><code>${esc(commit.sha.slice(0, 8))}</code> ${esc(commit.date)} ${esc(commit.author)}: ${esc(commit.subject)} — ${esc(commit.reasons.join("; "))}</li>`,
    )
    .join("");
  const prs = analysis.pullRequests
    .slice(0, 4)
    .map((pr) => `<li>#${pr.number} ${esc(pr.title)} (${esc(pr.state)})</li>`)
    .join("");
  const handoff = analysis.handoff.length
    ? `<ul>${analysis.handoff.map((note) => `<li>${esc(note)}</li>`).join("")}</ul>`
    : "";

  return `<div class="card">
    <h3>Git Investigator</h3>
    <p class="meta">Find commits/PRs that introduced the problem</p>
    <p class="lead">${esc(analysis.summary)}</p>
    ${introducing}
    ${suspects ? `<ul>${suspects}</ul>` : ""}
    ${prs ? `<ul>${prs}</ul>` : ""}
    ${handoff}
  </div>`;
}

function dependencyAnalystCard(analysis: DependencyAnalysis): string {
  const issues = analysis.issues
    .map(
      (issue) =>
        `<li><code>${esc(issue.kind)}</code>${issue.package ? ` <code>${esc(issue.package)}</code>` : ""} — ${esc(issue.detail)}</li>`,
    )
    .join("");
  const handoff = analysis.handoff.length
    ? `<ul>${analysis.handoff.map((note) => `<li>${esc(note)}</li>`).join("")}</ul>`
    : "";

  return `<div class="card ${analysis.likelyDependencyBug ? "tint-warn" : ""}">
    <h3>Dependency Analyst</h3>
    <p class="meta">Detect dependency/version-related issues</p>
    <p class="lead">${esc(analysis.summary)}</p>
    ${issues ? `<ul>${issues}</ul>` : ""}
    ${handoff}
  </div>`;
}

function logAnalyzerCard(analysis: LogAnalysis): string {
  const site = analysis.crashSite
    ? `${analysis.crashSite.file}${analysis.crashSite.line ? `:${analysis.crashSite.line}` : ""}`
    : undefined;
  const chain = analysis.exceptionChain
    .map((ex) => `<li><code>${esc(ex.role)}</code> ${esc(ex.type ?? "Error")}: ${esc(ex.message)}</li>`)
    .join("");
  const levels = analysis.logLevels;
  const ids = analysis.correlationIds.length
    ? `<p class="meta">Correlation ${analysis.correlationIds.map((id) => `<code>${esc(id)}</code>`).join(" ")}</p>`
    : "";
  const repeating = analysis.repeating.length
    ? `<ul>${analysis.repeating.map((row) => `<li>x${row.count} ${esc(clip(row.message, 160))}</li>`).join("")}</ul>`
    : "";
  const handoff = analysis.handoff.length
    ? `<ul>${analysis.handoff.map((note) => `<li>${esc(note)}</li>`).join("")}</ul>`
    : "";

  return `<div class="card tint-warn">
    <h3>Log Analyzer</h3>
    <p class="meta">Understand logs, exceptions and stack traces</p>
    <p class="lead">${esc(analysis.summary)}</p>
    ${site ? `<p class="meta">Crash site <code>${esc(site)}</code></p>` : ""}
    ${chain ? `<ul>${chain}</ul>` : ""}
    <p class="meta">Levels fatal ${levels.fatal} · error ${levels.error} · warn ${levels.warn} · info ${levels.info} · debug ${levels.debug}</p>
    ${ids}
    ${repeating}
    ${handoff}
  </div>`;
}

function stackCard(frames: StackFrame[]): string {
  if (!frames.length) return "";
  return `<div class="card">
    <h3>Stack frames</h3>
    <ol class="frames">
        ${frames
          .slice(0, 16)
          .map((f) => {
            const loc = `${f.file}${f.line ? `:${f.line}` : ""}${f.column ? `:${f.column}` : ""}`;
            const fn = f.functionName ? ` — ${esc(f.functionName)}` : "";
            return `<li class="${f.inProject ? "project" : ""}"><code>${esc(loc)}</code>${fn}<span class="scope">${f.inProject ? "project" : "external"}</span></li>`;
          })
          .join("")}
    </ol>
  </div>`;
}

function hypothesisCard(h: Hypothesis): string {
  const width = Math.round(Math.min(100, Math.max(4, h.likelihood * 100)));
  return `<div class="card">
    <h3>${esc(h.id)} · ${pct(h.likelihood)}</h3>
    <p>${esc(h.description)}</p>
    <div class="meter" aria-label="Likelihood ${pct(h.likelihood)}"><span style="width:${width}%"></span></div>
    ${h.evidence.length ? `<ul class="evidence">${h.evidence.slice(0, 4).map((item) => `<li>${esc(clip(item, 220))}</li>`).join("")}</ul>` : ""}
  </div>`;
}

function runtimeCard(e: DebuggingReport["evidence"]): string {
  const r = e.runtime;
  return `<div class="card">
    <h3>Runtime context</h3>
    <ul class="kv">
      <li><span>OS</span><span>${esc(r.os)}/${esc(r.arch)}</span></li>
      <li><span>Node</span><span>${esc(r.node ?? "n/a")}</span></li>
      <li><span>Python</span><span>${esc(r.python ?? "n/a")}</span></li>
      <li><span>CI</span><span>${r.ci ? "yes" : "no"}</span></li>
      ${r.envHints.length ? `<li><span>Env</span><span>${esc(r.envHints.join(", "))}</span></li>` : ""}
    </ul>
  </div>`;
}

function gitCard(e: DebuggingReport["evidence"]): string {
  const g = e.git;
  if (!g.available) return "";
  const commits = uniqueCommits(g.commitsTouchingSuspects.concat(g.recentCommits)).slice(0, 8);
  if (!g.branch && !g.head && !commits.length && !g.blame.length && !g.status) return "";
  return `<div class="card">
    <h3>Git</h3>
    <p class="meta">${g.branch ? `Branch <code>${esc(g.branch)}</code>` : "Detached"} ${g.head ? `@ <code>${esc(g.head)}</code>` : ""}</p>
    ${g.status ? `<pre class="code">${esc(g.status)}</pre>` : ""}
    ${
      commits.length
        ? `<ul>${commits.map((c) => `<li><code>${esc(c.sha.slice(0, 8))}</code> ${esc(c.date)} ${esc(c.author)}: ${esc(c.subject)}</li>`).join("")}</ul>`
        : ""
    }
    ${
      g.blame.length
        ? `<ul>${g.blame.map((b) => `<li><code>${esc(b.file)}:${b.line}</code> ${esc(b.sha)} ${esc(b.author)} (${esc(b.date)}) ${esc(b.summary)}</li>`).join("")}</ul>`
        : ""
    }
  </div>`;
}

function uniqueCommits(commits: DebuggingReport["evidence"]["git"]["recentCommits"]) {
  return commits.filter((c, i, arr) => arr.findIndex((x) => x.sha === c.sha) === i);
}

function stat(value: string, label: string, tone = ""): string {
  return `<div class="stat ${tone}"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function oneLine(text: string): string {
  return text.replace(/\n/g, "\\n");
}

function shortPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.slice(-3).join("/");
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const BOARD_CSS = `
  :root {
    --bg: #181818;
    --surface: #222;
    --text: #ececec;
    --muted: #9b9b9b;
    --line: #333;
    --accent: #6d9bff;
    --ok: #3d9a50;
    --bad: #e5484d;
    --warn: #c8881a;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f4f4f5;
      --surface: #fff;
      --text: #18181b;
      --muted: #71717a;
      --line: #e4e4e7;
      --accent: #2563eb;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
  }
  h1 { font-size: 24px; line-height: 1.25; font-weight: 650; margin: 6px 0 8px; }
  h2 { font-size: 13px; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); margin: 0 0 10px; }
  h3 { font-size: 13px; margin: 0 0 8px; font-weight: 600; }
  p { margin: 0 0 8px; }
  ul, ol { margin: 0; padding-left: 18px; }
  li { margin: 4px 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .hero, .pipeline, .board, .notes, .logs, .agents, .incident { max-width: 1440px; margin: 0 auto; padding: 20px 24px 0; }
  .logs { padding-bottom: 40px; }
  .kicker { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--accent); }
  .sub, .meta { color: var(--muted); font-size: 12px; }
  .lead { font-weight: 600; }
  .stats { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
  .stat {
    min-width: 110px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 10px 12px;
  }
  .stat strong { display: block; font-size: 18px; }
  .stat span { color: var(--muted); font-size: 11px; }
  .stat.ok strong { color: var(--ok); }
  .stat.bad strong { color: var(--bad); }
  .stat.warn strong { color: var(--warn); }
  .pipeline { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; list-style: none; padding-top: 16px; }
  .pipe {
    display: flex; gap: 10px; align-items: flex-start;
    background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 10px;
  }
  .pipe .idx {
    width: 22px; height: 22px; border-radius: 99px; display: grid; place-items: center;
    font-size: 11px; font-weight: 700; background: var(--line);
  }
  .pipe strong { display: block; font-size: 12px; }
  .pipe em { font-style: normal; color: var(--muted); font-size: 11px; }
  .pipe.done { border-color: var(--ok); }
  .pipe.danger { border-color: var(--bad); }
  .pipe.pending { border-color: var(--warn); }
  .notes { color: var(--muted); }
  .notes p { margin: 0 0 4px; }
  .agents ul { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px; }
  .agents li {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 12px;
  }
  .agents em { display: block; color: var(--muted); font-style: normal; font-size: 12px; margin: 4px 0 8px; }
  .board { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; padding-top: 16px; align-items: start; }
  .col { min-width: 0; display: flex; flex-direction: column; gap: 10px; }
  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 12px;
  }
  .card.tint-bad { border-color: var(--bad); }
  .card.tint-ok { border-color: var(--ok); }
  .card.tint-warn { border-color: var(--warn); }
  .code, .diff {
    margin: 0;
    overflow: auto;
    max-height: 360px;
    font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .diff .del { color: var(--bad); }
  .diff .add { color: var(--ok); }
  .frames { list-style: none; padding: 0; }
  .frames li { padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 12px; }
  .frames .scope { display: block; color: var(--muted); font-size: 11px; }
  .frames .project .scope { color: var(--accent); }
  .meter { height: 6px; background: var(--line); border-radius: 99px; overflow: hidden; margin: 8px 0; }
  .meter span { display: block; height: 100%; background: var(--accent); }
  .evidence { color: var(--muted); font-size: 12px; }
  .kv { list-style: none; padding: 0; }
  .kv li { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line); padding: 6px 0; }
  .kv span:first-child { color: var(--muted); }
  @media (max-width: 1100px) {
    .pipeline, .board { grid-template-columns: 1fr 1fr; }
  }
  @media (max-width: 720px) {
    .pipeline, .board { grid-template-columns: 1fr; }
  }
`;
