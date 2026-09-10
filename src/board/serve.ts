import { createServer, type Server } from "node:http";
import { renderInvestigationBoard } from "./html.js";
import { tryCommand } from "../exec.js";
import type { DebuggingReport } from "../types.js";

export interface BoardServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startBoardServer(
  report: DebuggingReport,
  options: { port?: number; host?: string } = {},
): Promise<BoardServer> {
  const host = options.host ?? "127.0.0.1";
  const requested = options.port ?? 8787;
  const html = renderInvestigationBoard(report);
  const json = JSON.stringify(report);

  const server: Server = createServer((req, res) => {
    const url = req.url?.split("?")[0] ?? "/";
    if (url === "/" || url === "/index.html" || url === "/board") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }
    if (url === "/report.json") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(json);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });

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
  report: DebuggingReport,
  options: { port?: number; open?: boolean } = {},
): Promise<void> {
  const board = await startBoardServer(report, { port: options.port });
  process.stderr.write(`Investigation board: ${board.url}\n`);
  if (options.open !== false) {
    await openBrowser(board.url);
  }
  await new Promise<void>((resolve) => {
    const stop = () => {
      void board.close().finally(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
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
