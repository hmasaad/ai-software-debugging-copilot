import { BOARD_CSS, boardNav } from "./html.js";

export function renderInvestigateForm(defaults: { repo?: string } = {}): string {
  const repo = esc(defaults.repo ?? "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>New investigation</title>
  <style>${BOARD_CSS}</style>
</head>
<body>
  ${boardNav("new")}
  <header class="hero">
    <div class="kicker">Webpage · also available from the CLI</div>
    <h1>Investigate a bug</h1>
    <p class="sub">Paste a local repo path (required for private GitHub) and the Crashlytics / log / stack dump. No trace file is required.</p>
  </header>
  <div class="form-wrap">
    <form class="form-card" id="investigate" action="/investigate" method="post">
      <div class="form-grid">
        <div class="wide">
          <label for="repo">Repo path or GitHub URL</label>
          <input id="repo" name="repo" type="text" required placeholder="/path/to/salt_flutter_app or https://github.com/org/app" value="${repo}" />
        </div>
        <div>
          <label for="error">Error / issue title</label>
          <input id="error" name="error" type="text" placeholder="ANR: Native method android.os.MessageQueue.nativePollOnce" />
        </div>
        <div>
          <label for="source">Source</label>
          <select id="source" name="source">
            <option value="">local / unknown</option>
            <option value="crashlytics">crashlytics</option>
            <option value="sentry">sentry</option>
            <option value="logs">logs</option>
          </select>
        </div>
        <div class="wide">
          <label for="trace">Stack trace / ANR dump / log text</label>
          <textarea id="trace" name="trace" placeholder="Paste the full Crashlytics thread dump here. For ANRs include Dart, binder, and plugin threads — not only nativePollOnce."></textarea>
        </div>
        <div>
          <label for="version">App version</label>
          <input id="version" name="version" type="text" placeholder="1.0.181" />
        </div>
        <div>
          <label for="affectedUsers">Affected users</label>
          <input id="affectedUsers" name="affectedUsers" type="number" min="0" placeholder="327" />
        </div>
        <div>
          <label for="firstSeen">First seen</label>
          <input id="firstSeen" name="firstSeen" type="text" placeholder="14:32 UTC" />
        </div>
        <div>
          <label for="investigator">Investigator</label>
          <select id="investigator" name="investigator">
            <option value="auto">auto</option>
            <option value="heuristic">heuristic</option>
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
            <option value="cursor">cursor</option>
          </select>
        </div>
        <div class="wide checks-row">
          <label><input type="checkbox" name="runTests" /> Run tests (off by default for Crashlytics dumps)</label>
          <label><input type="checkbox" name="apply" /> Apply patch to the repo</label>
          <label><input type="checkbox" name="autonomous" /> Isolated sandbox</label>
        </div>
      </div>
      <p class="meta">CLI equivalent: <code>debug-copilot --repo … --error … --stack …</code> or <code>debug-copilot incident --source crashlytics</code>.</p>
      <button type="submit">Investigate</button>
      <p class="status" id="status" role="status"></p>
    </form>
  </div>
  <script>
    const form = document.getElementById("investigate");
    const status = document.getElementById("status");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const payload = {
        repo: String(data.get("repo") || ""),
        error: String(data.get("error") || ""),
        trace: String(data.get("trace") || ""),
        source: String(data.get("source") || ""),
        version: String(data.get("version") || ""),
        affectedUsers: data.get("affectedUsers") ? Number(data.get("affectedUsers")) : undefined,
        firstSeen: String(data.get("firstSeen") || ""),
        investigator: String(data.get("investigator") || "auto"),
        runTests: data.has("runTests"),
        apply: data.has("apply"),
        autonomous: data.has("autonomous"),
      };
      status.className = "status";
      status.textContent = "Investigating… this can take a minute. Keep this tab open.";
      form.querySelector("button[type=submit]").disabled = true;
      try {
        const res = await fetch("/investigate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          status.className = "status bad";
          status.textContent = body.error || res.statusText || "Investigation failed.";
          return;
        }
        window.location.href = "/";
      } catch (error) {
        status.className = "status bad";
        status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        form.querySelector("button[type=submit]").disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
