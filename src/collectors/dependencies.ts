import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DependencyEvidence, DependencyHit, ParsedError, StackFrame } from "../types.js";

export async function collectDependencies(
  repoPath: string,
  error: ParsedError,
  frames: StackFrame[],
): Promise<DependencyEvidence> {
  const pkgPath = path.join(repoPath, "package.json");
  if (existsSync(pkgPath)) {
    return collectNodeDeps(repoPath, pkgPath, error, frames);
  }

  const requirements = path.join(repoPath, "requirements.txt");
  const pyproject = path.join(repoPath, "pyproject.toml");
  if (existsSync(requirements) || existsSync(pyproject)) {
    return collectPythonDeps(repoPath, error);
  }

  const gomod = path.join(repoPath, "go.mod");
  if (existsSync(gomod)) {
    const text = await readFile(gomod, "utf8");
    return { ecosystem: "go", manifest: "go.mod", hits: extractGoModules(text, error.message) };
  }

  return { hits: [] };
}

async function collectNodeDeps(
  repoPath: string,
  pkgPath: string,
  error: ParsedError,
  frames: StackFrame[],
): Promise<DependencyEvidence> {
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  const names = Object.keys(all);
  const haystack = `${error.message}\n${error.stackTrace ?? ""}\n${frames.map((f) => f.file).join("\n")}`;

  const hits: DependencyHit[] = [];
  for (const name of names) {
    if (haystack.includes(name) || frames.some((frame) => frame.file.includes(`node_modules/${name}`))) {
      hits.push({ name, version: all[name], source: "package.json" });
    }
  }

  const lock = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]
    .map((file) => path.join(repoPath, file))
    .find((file) => existsSync(file));

  return {
    ecosystem: "node",
    manifest: lock ? path.basename(lock) : "package.json",
    hits: hits.slice(0, 20),
  };
}

async function collectPythonDeps(repoPath: string, error: ParsedError): Promise<DependencyEvidence> {
  const hits: DependencyHit[] = [];
  const req = path.join(repoPath, "requirements.txt");
  if (existsSync(req)) {
    const text = await readFile(req, "utf8");
    for (const line of text.split("\n")) {
      const name = line.split(/[=<>~[]/)[0]?.trim();
      if (name && error.message.toLowerCase().includes(name.toLowerCase())) {
        hits.push({ name, version: line.trim(), source: "requirements.txt" });
      }
    }
  }
  return { ecosystem: "python", manifest: existsSync(req) ? "requirements.txt" : "pyproject.toml", hits };
}

function extractGoModules(text: string, message: string): DependencyHit[] {
  const hits: DependencyHit[] = [];
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^(\S+)\s+v\S+/);
    if (match?.[1] && message.includes(match[1])) {
      hits.push({ name: match[1], version: line.trim(), source: "go.mod" });
    }
  }
  return hits;
}
