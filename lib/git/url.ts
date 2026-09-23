/**
 * GitHub URL validation/normalization (Phase 3).
 *
 * v1 scope: only `https://github.com/<owner>/<repo>` (plus `.git` suffix,
 * trailing slash, and `www.` host) is accepted — every other host is a
 * documented limitation. Pure functions; no network, no fs.
 */

/** A validated GitHub repo identity, normalized. */
export interface GitHubRepo {
  /** Repo owner (org or user), case-preserved. */
  owner: string;
  /** Repo name without the `.git` suffix, case-preserved. */
  repo: string;
  /** Canonical "owner/repo" display key — used for clone cache paths and repo keys. */
  name: string;
  /** The https clone URL we pass to git. */
  httpsUrl: string;
}

/** Two path segments are required: /<owner>/<repo> (no more). */
const GITHUB_URL_RE = /^https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

/**
 * Validate and normalize a GitHub repo URL.
 * Returns null for anything that is not an https github.com repo URL —
 * callers turn null into a user-facing validation error.
 */
export function parseGitHubUrl(input: string): GitHubRepo | null {
  const trimmed = input.trim();
  const match = GITHUB_URL_RE.exec(trimmed);
  if (match === null) {
    return null;
  }
  const owner = match[1];
  const repoFull = match[2];
  // ".git" alone is ".git" optional-matched on an empty repo name — impossible
  // here because the regex requires at least one char before ".git", but a
  // bare ".git" name would still slip through; reject it defensively.
  const repo = repoFull === "" || repoFull === ".git" ? null : repoFull;
  if (repo === null) {
    return null;
  }
  return {
    owner,
    repo,
    name: `${owner}/${repo}`,
    httpsUrl: `https://github.com/${owner}/${repo}`,
  };
}
