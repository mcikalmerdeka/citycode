import { afterEach, describe, expect, it } from "vitest";
import { simpleGit } from "simple-git";
import { getRepoInfo } from "../lib/git/local";
import { cleanup, initRepo, makeTempDir, writeFiles } from "./helpers/fixtures";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    cleanup(dir);
  }
  dirs.length = 0;
});

describe("getRepoInfo", () => {
  it("returns the real HEAD sha for a git repo with commits", async () => {
    const root = makeTempDir("citycode-git-repo-");
    dirs.push(root);
    writeFiles(root, [{ path: "main.ts", contents: "export const a = 1;\n" }]);
    const expectedSha = await initRepo(root);

    const info = await getRepoInfo(root);
    expect(info.isRepo).toBe(true);
    expect(info.headSha).toBe(expectedSha);
    expect(info.headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns isRepo false and headSha undefined for a non-git folder (no crash)", async () => {
    const root = makeTempDir("citycode-git-norepo-");
    dirs.push(root);
    writeFiles(root, [{ path: "main.ts", contents: "export const a = 1;\n" }]);

    const info = await getRepoInfo(root);
    expect(info.isRepo).toBe(false);
    expect(info.headSha).toBeUndefined();
  });

  it("returns headSha undefined for a repo with no commits (no crash)", async () => {
    const root = makeTempDir("citycode-git-nocommit-");
    dirs.push(root);
    writeFiles(root, [{ path: "main.ts", contents: "export const a = 1;\n" }]);
    await simpleGit(root).init();

    const info = await getRepoInfo(root);
    expect(info.isRepo).toBe(true);
    expect(info.headSha).toBeUndefined();
  });
});
