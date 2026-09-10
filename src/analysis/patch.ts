import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileEdit, FixProposal } from "../types.js";

export async function applyEdits(repoPath: string, proposal: FixProposal): Promise<FixProposal> {
  const applyErrors: string[] = [];
  let applied = true;

  for (const edit of proposal.edits) {
    const abs = path.resolve(repoPath, edit.path);
    if (!abs.startsWith(path.resolve(repoPath))) {
      applyErrors.push(`Refusing to write outside the repo: ${edit.path}`);
      applied = false;
      continue;
    }

    try {
      const original = await readFile(abs, "utf8");
      if (!original.includes(edit.oldString)) {
        applyErrors.push(`${edit.path}: old string not found`);
        applied = false;
        continue;
      }
      if (edit.oldString === edit.newString) {
        applyErrors.push(`${edit.path}: old and new strings are identical`);
        applied = false;
        continue;
      }
      const next = original.replace(edit.oldString, edit.newString);
      await writeFile(abs, next, "utf8");
    } catch (error) {
      applyErrors.push(`${edit.path}: ${error instanceof Error ? error.message : String(error)}`);
      applied = false;
    }
  }

  if (proposal.edits.length === 0) {
    applied = false;
    applyErrors.push("No edits were proposed.");
  }

  return { ...proposal, applied, applyErrors };
}

export async function snapshotFiles(repoPath: string, edits: FileEdit[]): Promise<Map<string, string>> {
  const snap = new Map<string, string>();
  for (const edit of edits) {
    const abs = path.resolve(repoPath, edit.path);
    if (snap.has(abs)) continue;
    try {
      snap.set(abs, await readFile(abs, "utf8"));
    } catch {
      /* new files are not restored from snapshot */
    }
  }
  return snap;
}

export async function restoreFiles(snapshot: Map<string, string>): Promise<void> {
  for (const [abs, content] of snapshot) {
    await writeFile(abs, content, "utf8");
  }
}
