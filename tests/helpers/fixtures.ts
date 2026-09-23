import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";

/**
 * Programmatic fixture builders — every fixture lives in a temp dir under
 * os.tmpdir(), created at test time and removed afterwards. Fixture repos are
 * NEVER committed into the project tree (per tech-stack §8).
 */

export interface FixtureFile {
  /** Repo-relative POSIX path (forward slashes), e.g. "src/utils/helpers.ts". */
  path: string;
  contents: string;
}

export function makeTempDir(prefix = "citycode-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFiles(root: string, files: readonly FixtureFile[]): void {
  for (const file of files) {
    const absolute = path.join(root, ...file.path.split("/"));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, file.contents);
  }
}

/**
 * `git init` + add + commit everything in `root`, returning the created HEAD sha.
 * Identity is passed per-command via `-c` flags — a fresh temp repo has no
 * user.name/user.email, and `git commit` fails without them.
 */
export async function initRepo(root: string): Promise<string> {
  const git = simpleGit(root);
  await git.init();
  await git.add(".");
  await git.raw([
    "-c",
    "user.name=CityCode Test",
    "-c",
    "user.email=citycode@test.local",
    "commit",
    "-m",
    "fixture-commit",
  ]);
  const sha = await git.revparse("HEAD");
  return sha.trim();
}

export function cleanup(root: string): void {
  if (!fs.existsSync(root)) {
    return;
  }
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows: git object files are read-only, which blocks rmSync — clear
    // the read-only attributes and retry once.
    makeWritable(root);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function makeWritable(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      makeWritable(absolute);
    } else {
      fs.chmodSync(absolute, 0o666);
    }
  }
}
