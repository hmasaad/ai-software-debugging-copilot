import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { debugAutonomously } from "../autonomous/debug.js";
import { debugBug } from "../pipeline.js";
import { tryCommand } from "../exec.js";
import type { BugInput, DebuggingReport, InvestigatorKind } from "../types.js";
import { renderInvestigateForm } from "./form.js";
import { renderInvestigationBoard } from "./html.js";
import { resolveInvestigationRepo } from "./repo.js";

export interface BoardServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export interface BoardServerOptions {
  port?: number;
  host?: string;
  live?: boolean;
}

interface InvestigateRequest {
  repo?: string;
  error?: string;
  trace?: string;
  source?: string;
  version?: string;
  affectedUsers?: number;
  firstSeen?: string;
  investigator?: string;
  runTests?: boolean;
  apply?: boolean;
  autonomous?: boolean;
}

export async function startBoardServer(
  report?: DebuggingReport,
  options: BoardServerOptions = {},
): Promise<BoardServer> {
  const host = options.host ?? "127.0.0.1";
  const requested = options.port ?? 8787;
  const live = options.live !== false;
  let current = report;
  let busy = false;

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url?.split("?")[0] ?? "/";
    try {
      if (req.method === "GET" && (url === "/" || url === "/index.html" || url === "/board")) {
        if (!current) {
          html(res, 200, renderInvestigateForm());
          return;
        }
        html(res, 200, renderInvestigationBoard(current));
        return;
      }
      if (req.method === "GET" && url === "/new") {
        html(res, 200, renderInvestigateForm({ repo: current?.repoPath }));
        return;
      }
      if (req.method === "GET" && url === "/report.json") {
        if (!current) {
          json(res, 404, { error: "No investigation yet. POST /investigate or open /new." });
          return;
        }
        json(res, 200, current);
        return;
      }
      if (req.method === "POST" && url === "/investigate") {
        if (!live) {
          json(res, 405, { error: "This board is report-only. Restart with debug-copilot board to investigate from the webpage." });
          return;
        }
        if (busy) {
          json(res, 409, { error: "An investigation is already running." });
          return;
        }
        const body = parseInvestigate(await readBody(req));
        if (!body.repo?.trim()) {
          json(res, 400, { error: "Repo path or GitHub URL is required." });
          return;
        }
        if (!body.error?.trim() && !body.trace?.trim()) {
          json(res, 400, { error: "Paste an error title and/or the stack / ANR / log dump." });
          return;
        }
        busy = true;
        try {
          current = await runInvestigation(body);
          json(res, 200, { ok: true });
        } finally {
          busy = false;
        }
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(res, 500, { error: message });
    }
  }

  const port = await listen(server, host, requested);
  return {
    url: `http://${host}:${port}`,
    port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export async function serveInvestigationBoard(
  report?: DebuggingReport,
  options: { port?: number; open?: boolean; live?: boolean } = {},
): Promise<void> {
  const board = await startBoardServer(report, { port: options.port, live: options.live });
  process.stderr.write(`Investigation board: ${board.url}\n`);
  process.stderr.write(`New investigation: ${board.url}/new\n`);
  if (options.open !== false) {
    await openBrowser(report ? board.url : `${board.url}/new`);
  }
  await new Promise<void>((resolve) => {
    const stop = () => {
      void board.close().finally(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function runInvestigation(body: InvestigateRequest): Promise<DebuggingReport> {
  const resolved = await resolveInvestigationRepo(body.repo ?? "");
  const source = asSource(body.source);
  const investigator = asInvestigator(body.investigator);
  const bug: BugInput = {
    repoPath: resolved.repoPath,
    message: body.error?.trim() || undefined,
    stackTrace: body.trace?.trim() || undefined,
    logText: body.trace?.trim() || undefined,
    version: body.version?.trim() || undefined,
    affectedUsers: Number.isFinite(body.affectedUsers) ? body.affectedUsers : undefined,
    firstSeen: body.firstSeen?.trim() || undefined,
    incidentSource: source,
  };
  const pipeline = {
    repoPath: resolved.repoPath,
    apply: Boolean(body.apply),
    autonomous: Boolean(body.autonomous),
    runTests: Boolean(body.runTests),
    investigator,
    onEvent: (event: { agent?: string; stage: string; message: string }) => {
      const label = event.agent ?? event.stage;
      process.stderr.write(`[board ${label}] ${event.message}\n`);
    },
  };
  const report = body.autonomous
    ? (await debugAutonomously(bug, pipeline)).report
    : await debugBug(bug, pipeline);
  if (resolved.warning) report.notes.push(resolved.warning);
  if (resolved.source === "clone") {
    report.notes.push(`Cloned ${body.repo} into ${resolved.repoPath} for this investigation.`);
  }
  return report;
}

function parseInvestigate(raw: string): InvestigateRequest {
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as InvestigateRequest;
  return parsed && typeof parsed === "object" ? parsed : {};
}

function asSource(value?: string): BugInput["incidentSource"] {
  if (value === "crashlytics" || value === "sentry" || value === "logs") return value;
  return undefined;
}

function asInvestigator(value?: string): InvestigatorKind | undefined {
  if (value === "auto" || value === "heuristic" || value === "openai" || value === "anthropic" || value === "cursor") {
    return value;
  }
  return undefined;
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit = 2_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error("Dump is larger than 2MB. Trim the ANR file to the relevant threads."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function openBrowser(url: string): Promise<void> {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  await tryCommand(opener, args, { timeoutMs: 8_000 });
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" && port !== 0) {
        server.off("error", onError);
        server.listen(0, host);
        return;
      }
      reject(error);
    };
    server.on("error", onError);
    server.listen(port, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to bind investigation board server"));
        return;
      }
      resolve(address.port);
    });
  });
}
