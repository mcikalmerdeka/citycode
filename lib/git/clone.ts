/**
 * GitHub shallow clone (Phase 3) — the `lib/git/clone.ts` wrapper from the
 * plan. Clones a validated GitHub repo into the gitignored cache folder
 * `.citycode-cache/clones/<owner>/<repo>`, always to a fresh HEAD, and turns
 * every clone failure into a clean user-facing Error.
 */

import fs from "node:fs";
import path from "node:path";
import { simpleGit } from "simple-git";
import type { GitHubRepo } from "./url";

/** Clone timeout in milliseconds — a hung clone must not spin forever. */
const CLONE_TIMEOUT_MS = 120_000;

/** Clone dirs older than this (other than the one being cloned) are swept. */
const STALE_MS = 24 * 60 * 60 * 1000;

/** Absolute path of the clone cache root (`<projectRoot>/.citycode-cache/clones`). */
export function clonesRoot(): string {
  // process.cwd() is the project root under both `next dev` and `next start`.
  return path.join(process.cwd(), ".citycode-cache", "clones");
}

/** Cache directory for one repo. */
export function clonePathFor(parsed: GitHubRepo): string {
  return path.join(clonesRoot(), parsed.owner, parsed.repo);
}

function complain(cause: string): never {
  throw new Error(`CityCode: GitHub clone failed — ${cause}`);
}

/**
 * Delete sibling clones not touched for {@link STALE_MS}. Best-effort: any
 * failure is swallowed, since old clones are harmless (bigger gap between
 * sweeps, no incorrectness).
 */
function sweepStaleClones(): void {
  try {
    const ownersRoot = clonesRoot();
    if (!fs.existsSync(ownersRoot)) {
      return;
    }
    const now = Date.now();
    for (const dir of listClonedRepos()) {
      if (now - fs.statSync(dir).mtimeMs <= STALE_MS) {
        continue;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // stale-clone cleanup is optional; never fail a clone because of it
  }
}

/** Every clone directory currently on disk (absolute, native separators). */
export function listClonedRepos(): string[] {
  const root = clonesRoot();
  const result: string[] = [];
  let owners: string[];
  try {
    owners = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return result;
  }
  for (const owner of owners) {
    try {
      const ownerDir = path.join(root, owner);
      result.push(
        ...fs
          .readdirSync(ownerDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => path.join(ownerDir, e.name)),
      );
    } catch {
      // skip unreadable owner dir
    }
  }
  return result;
}

/**
 * How much history a GitHub clone carries: HEAD plus HEAD~1 — exactly the
 * two states CityCode's commit compare (Phase 4) ever diffes (PRD §4
 * non-goal: no history browser, ever). Depth 1 broke `diff HEAD~1..HEAD`
 * on clones with `this repository has only one commit`; depth 2 fixes that
 * for the minimal download cost still short of a full clone.
 */
const CLONE_DEPTH = "2";

/**
 * Shallow-clone `parsed` (last 2 commits, single branch) into
 * `.citycode-cache/clones/<owner>/<repo>` and return the clone's absolute
 * POSIX-style path.
 *
 * The destination is always removed and re-cloned first, so repeated imports
 * of the same URL refresh to the latest HEAD. GIT_TERMINAL_PROMPT=0 makes
 * prod of credential prompts fail fast instead of hanging the server.
 */
export async function cloneRepo(parsed: GitHubRepo): Promise<string> {
  sweepStaleClones();

  const destination = clonePathFor(parsed);
  if (fs.existsSync(destination)) {
    try {
      fs.rmSync(destination, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      complain(`existing cache directory could not be cleared: ${destination}`);
    }
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const git = simpleGit({ timeout: { block: CLONE_TIMEOUT_MS } });
  try {
    // simple-git's clone() accepts (url, destination, options) only; credential
    // prompts are disabled for the duration of the call via the process env
    // (no await happens between set/restore, so concurrent imports can't see
    // or disturb the restored state).
    const previous = process.env.GIT_TERMINAL_PROMPT;
    process.env.GIT_TERMINAL_PROMPT = "0";
    try {
      await git.clone(parsed.httpsUrl, destination, ["--depth", CLONE_DEPTH, "--single-branch"]);
    } finally {
      if (previous === undefined) {
        delete process.env.GIT_TERMINAL_PROMPT;
      } else {
        process.env.GIT_TERMINAL_PROMPT = previous;
      }
    }
  } catch {
    // simple-git error blobs include internal git stderr — replace with a
    // fixed, readable message. Nonexistent + private repos are
    // indistinguishable from the server side (both auth-fail anonymously).
    // git CLI missing also reads like a plain command failure.
    complain(`"${parsed.httpsUrl}" could not be cloned. It may not exist, or it may be private.`);
  }

  return destination.split(path.sep).join("/");
}
