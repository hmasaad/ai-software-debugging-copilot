import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { RelatedTest, StackFrame, TestEvidence } from "../types.js";

export async function collectTests(repoPath: string, frames: StackFrame[]): Promise<TestEvidence> {
  const runner = await detectRunner(repoPath);
  const relatedTests = await findRelatedTests(repoPath, frames);

  return {
    runner: runner?.name,
    testCommand: runner?.command,
    relatedTests,
  };
}

async function detectRunner(repoPath: string): Promise<{ name: string; command: string } | undefined> {
  const pkgPath = path.join(repoPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
        devDependencies?: Record<string, string>;
        dependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (pkg.scripts?.test) return { name: inferJsRunner(pkg.scripts.test, deps), command: "npm test --silent" };
      if (deps.vitest) return { name: "vitest", command: "npx vitest run" };
      if (deps.jest) return { name: "jest", command: "npx jest" };
    } catch {
      /* ignore malformed package.json */
    }
  }

  if (existsSync(path.join(repoPath, "pyproject.toml")) || existsSync(path.join(repoPath, "pytest.ini"))) {
    return { name: "pytest", command: "pytest -q" };
  }
  if (existsSync(path.join(repoPath, "go.mod"))) {
    return { name: "go-test", command: "go test ./..." };
  }
  if (existsSync(path.join(repoPath, "Cargo.toml"))) {
    return { name: "cargo-test", command: "cargo test" };
  }
  if (existsSync(path.join(repoPath, "pom.xml"))) {
    return { name: "maven", command: "mvn -q test" };
  }
  if (existsSync(path.join(repoPath, "pubspec.yaml"))) {
    return { name: "flutter-test", command: "flutter test" };
  }

  return undefined;
}

function inferJsRunner(script: string, deps: Record<string, string | undefined>): string {
  if (script.includes("vitest") || deps.vitest) return "vitest";
  if (script.includes("jest") || deps.jest) return "jest";
  if (script.includes("mocha") || deps.mocha) return "mocha";
  return "npm-test";
}

async function findRelatedTests(repoPath: string, frames: StackFrame[]): Promise<RelatedTest[]> {
  const related: RelatedTest[] = [];
  const seen = new Set<string>();

  for (const frame of frames.filter((item) => item.inProject).slice(0, 6)) {
    const rel = path.isAbsolute(frame.file) ? path.relative(repoPath, frame.file) : frame.file;
    const parsed = path.parse(rel);
    const stem = parsed.name.replace(/\.test$|\.spec$/, "");
    const dir = path.join(repoPath, parsed.dir);

    const candidates = [
      path.join(parsed.dir, `${stem}.test${parsed.ext}`),
      path.join(parsed.dir, `${stem}.spec${parsed.ext}`),
      path.join(parsed.dir, "__tests__", `${stem}.test${parsed.ext}`),
      path.join("tests", `${stem}.test${parsed.ext}`),
      path.join("test", `${stem}_test${parsed.ext}`),
      path.join(parsed.dir, `test_${stem}${parsed.ext}`),
      path.join("test", `${stem}_test.dart`),
      path.join(parsed.dir, `${stem}_test.dart`),
    ];

    for (const candidate of candidates) {
      const abs = path.join(repoPath, candidate);
      if (!existsSync(abs) || seen.has(candidate)) continue;
      seen.add(candidate);
      related.push({ file: candidate, reason: `name-match for ${rel}` });
    }

    if (existsSync(dir)) {
      try {
        const entries = await readdir(dir);
        for (const entry of entries) {
          if (!/\.(test|spec)\./.test(entry) && !entry.startsWith("test_") && !entry.endsWith("_test.dart")) continue;
          const relFile = path.join(parsed.dir, entry);
          if (seen.has(relFile)) continue;
          seen.add(relFile);
          related.push({ file: relFile, reason: `colocated test near ${rel}` });
        }
      } catch {
        /* ignore */
      }
    }
  }

  return related.slice(0, 12);
}
