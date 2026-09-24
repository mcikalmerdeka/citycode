import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { simpleGit } from "simple-git";
import { workdirDiff } from "../lib/git/workdir";
import { applyCommitDiff, applyWorkdirDiff } from "../lib/diff/apply";
import { diffCommits } from "../lib/git/diff";
import { buildGraph } from "../lib/parser/buildGraph";
import { cleanup, initRepo, makeTempDir, writeFiles } from "./helpers/fixtures";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    cleanup(dir);
  }
  dirs.length = 0;
});

/** Base committed fixture: A ← B (B imports A). */
async function makeBaseFixture(root: string): Promise<void> {
  writeFiles(root, [
    { path: "A.ts", contents: 'export function a(n: number): number {\n  return n + 1;\n}\n' },
    { path: "B.ts", contents: 'import { a } from "./A";\nexport function b(): number {\n  return a(2);\n}\n' },
  ]);
  await initRepo(root);
}

describe("workdirDiff", () => {
  it("clean workdir: empty change set + stable hash", async () => {
    const root = makeTempDir("citycode-wd-clean-");
    dirs.push(root);
    await makeBaseFixture(root);

    const first = await workdirDiff(root);
    expect(first.files).toHaveLength(0);
    expect(first.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(first.workdirHash).toMatch(/^[0-9a-f]{64}$/);

    // Deterministic: nothing changed between the two calls.
    const second = await workdirDiff(root);
    expect(second.workdirHash).toBe(first.workdirHash);

    // Any change flips the hash.
    fs.writeFileSync(path.join(root, "A.ts"), 'export function a(n: number): number {\n  return n + 2;\n}\n');
    const changed = await workdirDiff(root);
    expect(changed.workdirHash).not.toBe(first.workdirHash);
  });

  it("untracked-only: a new file lands as an untracked change with no patch", async () => {
    const root = makeTempDir("citycode-wd-untracked-");
    dirs.push(root);
    await makeBaseFixture(root);
    writeFiles(root, [{ path: "src/untouched/New.ts", contents: "export const fresh = true;\n" }]);

    const diff = await workdirDiff(root);
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0].path).toBe("src/untouched/New.ts");
    expect(diff.files[0].kind).toBe("untracked");
    expect(diff.files[0].insertions).toBe(0);
    expect(diff.files[0].deletions).toBe(0);
  });

  it("staged-only vs unstaged-only: both read as modified", async () => {
    const root = makeTempDir("citycode-wd-staged-");
    dirs.push(root);
    await makeBaseFixture(root);
    const git = simpleGit(root);

    fs.writeFileSync(path.join(root, "A.ts"), 'export const swapped = 1;\n');
    await git.add("A.ts");

    const staged = await workdirDiff(root);
    const byPath = new Map(staged.files.map((f) => [f.path, f]));
    expect(byPath.get("A.ts")?.kind).toBe("modified");

    // Now stage everything and let ANOTHER file go unstaged-only.
    fs.writeFileSync(path.join(root, "B.ts"), 'import { a } from "./A";\nexport function b(): number {\n  return a(3);\n}\n');
    const unstaged = await workdirDiff(root);
    const byPath2 = new Map(unstaged.files.map((f) => [f.path, f]));
    expect(byPath2.get("B.ts")?.kind).toBe("modified");
  });

  it("staged rename: kind renamed with oldPath", async () => {
    const root = makeTempDir("citycode-wd-rename-");
    dirs.push(root);
    await makeBaseFixture(root);
    const git = simpleGit(root);

    await git.mv("A.ts", "A-Moved.ts");
    const diff = await workdirDiff(root);
    const renamed = diff.files.find((f) => f.path === "A-Moved.ts");
    expect(renamed?.kind).toBe("renamed");
    expect(renamed?.oldPath).toBe("A.ts");
    expect(diff.files).toHaveLength(1); // no separate delete row for the old path
  });

  it("deleted file: kind deleted", async () => {
    const root = makeTempDir("citycode-wd-delete-");
    dirs.push(root);
    await makeBaseFixture(root);
    fs.rmSync(path.join(root, "B.ts"));

    const diff = await workdirDiff(root);
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0].path).toBe("B.ts");
    expect(diff.files[0].kind).toBe("deleted");
    expect(diff.files[0].deletions).toBeGreaterThan(0);
  });

  it("mixed workdir (the acceptance trio): untracked + modified + deleted in one pass", async () => {
    const root = makeTempDir("citycode-wd-mixed-");
    dirs.push(root);
    await makeBaseFixture(root);
    fs.writeFileSync(path.join(root, "A.ts"), 'export function two(): number {\n  return 2;\n}\n');
    fs.rmSync(path.join(root, "B.ts"));
    writeFiles(root, [{ path: "C.ts", contents: "export function c(): number {\n  return 1;\n}\n" }]);

    const diff = await workdirDiff(root);
    const byKind = new Map(diff.files.map((f) => [f.kind, f]));
    expect(byKind.get("modified")?.path).toBe("A.ts");
    expect(byKind.get("deleted")?.path).toBe("B.ts");
    expect(byKind.get("untracked")?.path).toBe("C.ts");
    // Patch details attach to the modified tracked file only.
    expect(byKind.get("modified")!.hunkHeaders.length).toBeGreaterThan(0);
    expect(byKind.get("untracked")!.hunkHeaders).toHaveLength(0);
  });

  it("ignored files never appear in the change set", async () => {
    const root = makeTempDir("citycode-wd-ignored-");
    dirs.push(root);
    fs.writeFileSync(path.join(root, ".gitignore"), "log.txt\n");
    await initRepo(root);
    writeFiles(root, [{ path: "log.txt", contents: "noise\n" }]);

    // First: with log.txt ignored and everything committed, the workdir is clean.
    const clean = await workdirDiff(root);
    expect(clean.files).toHaveLength(0);

    fs.writeFileSync(path.join(root, ".gitignore"), "log.txt\n# edited\n");
    const diff = await workdirDiff(root);
    expect(diff.files).toHaveLength(1); // the .gitignore modification only
    expect(diff.files[0].path).toBe(".gitignore");
    expect(diff.files.some((file) => file.path === "log.txt")).toBe(false);
  });

  it("throws a readable error on a non-git folder", async () => {
    const root = makeTempDir("citycode-wd-norepo-");
    dirs.push(root);
    await expect(workdirDiff(root)).rejects.toThrow(/not a git repository/);
  });

  it("throws a readable error on a repo with no commits", async () => {
    const root = makeTempDir("citycode-wd-nocommits-");
    dirs.push(root);
    writeFiles(root, [{ path: "S.ts", contents: "export const s = 1;\n" }]);
    const git = simpleGit(root);
    await git.init();
    await expect(workdirDiff(root)).rejects.toThrow(/no commits yet/);
  });
});

describe("applyWorkdirDiff", () => {
  it("classifies foundation/construction/rubble and closes the blast radius", async () => {
    const root = makeTempDir("citycode-wd-apply-");
    dirs.push(root);
    await makeBaseFixture(root);
    fs.writeFileSync(path.join(root, "A.ts"), 'export const plusTwo = 2;\n'); // modified
    fs.rmSync(path.join(root, "B.ts")); // deleted
    writeFiles(root, [{ path: "New.ts", contents: "export const n = 1;\n" }]); // untracked

    // The graph comes from the folder AS IS on disk (New.ts included).
    const { graph } = await buildGraph(root);
    const diff = await workdirDiff(root);
    const changeSet = applyWorkdirDiff(graph, diff);

    const byId = new Map(changeSet.changes.map((change) => [change.fileId, change]));
    expect(byId.get("A.ts")?.status).toBe("construction");
    expect(byId.get("New.ts")?.status).toBe("foundation");
    expect(byId.get("B.ts")?.status).toBe("rubble");
    expect(changeSet.changes).toHaveLength(3);
    expect(changeSet.counts).toEqual({ modified: 1, added: 0, deleted: 1, renamed: 0, untracked: 1 });
    expect(changeSet.workdirHash).toMatch(/^[0-9a-f]{64}$/);
    expect(changeSet.headSha).toBe(diff.headSha);
    expect(changeSet.baseSha).toBe("");
  });

  it("is deterministic: same workdir state → byte-identical ChangeSet JSON", async () => {
    const root = makeTempDir("citycode-wd-apply-det-");
    dirs.push(root);
    await makeBaseFixture(root);
    fs.writeFileSync(path.join(root, "A.ts"), 'export const x = 3;\n');
    writeFiles(root, [{ path: "New.ts", contents: "export const n = 1;\n" }]);

    const { graph } = await buildGraph(root);
    const first = applyWorkdirDiff(graph, await workdirDiff(root));
    const second = applyWorkdirDiff(graph, await workdirDiff(root));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("commit compare and workdir compare classify the same modification differently only for new files", async () => {
    const root = makeTempDir("citycode-wd-vs-commit-");
    dirs.push(root);
    await makeBaseFixture(root);
    // diffCommits needs >= 2 commits; an empty second commit adds no changes.
    await simpleGit(root).raw([
      "-c", "user.name=CityCode Test", "-c", "user.email=citycode@test.local",
      "commit", "--allow-empty", "-m", "second",
    ]);
    writeFiles(root, [{ path: "New.ts", contents: "export const n = 1;\n" }]);

    const { graph } = await buildGraph(root);
    const wd = await workdirDiff(root);
    const wdSet = applyWorkdirDiff(graph, wd);
    expect(wdSet.changes.find((c) => c.fileId === "New.ts")?.status).toBe("foundation");
    expect(wdSet.changes).toHaveLength(1);

    // The commit diff sees none of it (New.ts is untracked, never committed).
    const commitDiff = await diffCommits(root);
    expect(commitDiff.files).toHaveLength(0);
    const commitSet = applyCommitDiff(graph, commitDiff);
    expect(commitSet.changes).toHaveLength(0);
    expect(commitSet.workdirHash).toBeUndefined();
  });
});
