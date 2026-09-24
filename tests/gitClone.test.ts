import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { simpleGit } from "simple-git";
import { cloneRepo, clonePathFor, listClonedRepos } from "../lib/git/clone";
import type { GitHubRepo } from "../lib/git/url";
import { parseGitHubUrl } from "../lib/git/url";
import { cleanup, initRepo, makeTempDir, writeFiles } from "./helpers/fixtures";

/**
 * clone.ts is tested against a LOCAL fixture repo: the URL parser is the
 * github.com gate (so network access stays out of tests), while cloneRepo
 * accepts a GitHubRepo handed to it directly with a local httpsUrl. This
 * exercises the real clone logic (depth 2, fresh re-clone, error mapping,
 * cache layout) without touching that gate or the network.
 */

const dirs: string[] = [];
const cloneDirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    cleanup(dir);
  }
  dirs.length = 0;
  // Clones live under .citycode-cache/clones (gitignored) — remove whatever
  // the test created there so the suite stays hermetic even though the path
  // is process.cwd()-relative.
  for (const dir of cloneDirs) {
    cleanup(dir);
  }
  cloneDirs.length = 0;
});

/** Local-fixture GitHubRepo: same shape, URL points at a local git repo. */
function localRepoFixture(sourceDir: string): { parsed: GitHubRepo; destination: string } {
  const basename = path.basename(sourceDir);
  const parsed: GitHubRepo = {
    owner: basename,
    repo: "fixture-repo",
    name: `${basename}/fixture-repo`,
    httpsUrl: sourceDir.replace(/\\/g, "/"),
  };
  const destination = path.join(".citycode-cache", "clones", parsed.owner, parsed.repo);
  return { parsed, destination: path.join(process.cwd(), ...destination.split("/")) };
}

describe("cloneRepo", () => {
  it("shallow-clones a git repo into the clone cache and returns its path", async () => {
    const source = makeTempDir("citycode-clone-src-");
    dirs.push(source);
    writeFiles(source, [{ path: "src/main.ts", contents: "export const x = 1;\n" }]);
    await initRepo(source);

    const { parsed, destination } = localRepoFixture(source);
    cloneDirs.push(destination);

    const clonePath = await cloneRepo(parsed);
    expect(path.resolve(clonePath)).toBe(path.resolve(destination));
    expect(fs.existsSync(path.join(clonePath, "src", "main.ts"))).toBe(true);
  }, 30_000);

  it("fails a nonexistent source with a clean, readable error (no internal git stderr)", async () => {
    const source = makeTempDir("citycode-clone-missing-");
    dirs.push(source);
    const { parsed, destination } = localRepoFixture(source);
    cloneDirs.push(destination);

    const bogus = { ...parsed, httpsUrl: `${parsed.httpsUrl}/does-not-exist` };
    await expect(cloneRepo(bogus)).rejects.toThrow(/could not be cloned/);
  }, 30_000);

  it("re-clones over an existing cache directory (fresh HEAD next time)", async () => {
    const source = makeTempDir("citycode-clone-src2-");
    dirs.push(source);
    writeFiles(source, [{ path: "src/main.ts", contents: "export const x = 1;\n" }]);
    await initRepo(source);

    const { parsed, destination } = localRepoFixture(source);
    cloneDirs.push(destination);

    const first = await cloneRepo(parsed);
    fs.writeFileSync(path.join(first, "stale-artifact.txt"), "old");
    const second = await cloneRepo(parsed);
    expect(second.replace(/\\/g, "/")).toBe(first.replace(/\\/g, "/"));
    expect(fs.existsSync(path.join(second, "stale-artifact.txt"))).toBe(false);
  }, 30_000);

  it("clones depth 2 so the commit compare has a HEAD~1 to diff against (Phase 4 regression)", async () => {
    const source = makeTempDir("citycode-clone-src3-");
    dirs.push(source);
    writeFiles(source, [{ path: "src/main.ts", contents: "export const x = 1;\n" }]);
    await initRepo(source); // commit 1

    // Second commit: the clone must carry BOTH commits (HEAD + HEAD~1).
    fs.writeFileSync(
      path.join(source, "src", "second.ts"),
      'export const y = 2;\n',
    );
    const git = simpleGit(source);
    await git.add("-A");
    await git.raw([
      "-c",
      "user.name=CityCode Test",
      "-c",
      "user.email=citycode@test.local",
      "commit",
      "-m",
      "second commit",
    ]);
    const headSha = (await git.revparse("HEAD")).trim();
    const base = (await git.revparse("HEAD~1")).trim();

    const { parsed, destination } = localRepoFixture(source);
    cloneDirs.push(destination);

    const clonePath = await cloneRepo(parsed);

    // The exact failure mode Phase 4 hit on depth-1 clones must be gone:
    // diffCommits resolves baseSha + name-status instead of throwing.
    const { diffCommits } = await import("../lib/git/diff");
    const diff = await diffCommits(clonePath);
    expect(diff.headSha).toBe(headSha);
    expect(diff.baseSha).toBe(base);
    expect(diff.files.map((file) => file.path)).toContain("src/second.ts");
  }, 30_000);
});

describe("clonePathFor + listClonedRepos", () => {
  it("builds `<owner>/<repo>` paths under the clones root", () => {
    const parsed = parseGitHubUrl("https://github.com/Owner/Repo");
    if (parsed === null) throw new Error("fixture URL rejected by parser");
    const clonePath = clonePathFor(parsed);
    expect(path.basename(path.dirname(clonePath))).toBe("Owner");
    expect(path.basename(clonePath)).toBe("Repo");
    expect(clonePath).toContain(".citycode-cache");
  });

  it("lists existing clone directories without crashing on a missing root", () => {
    expect(Array.isArray(listClonedRepos())).toBe(true);
  });
});
