import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { simpleGit } from "simple-git";
import { diffCommits } from "../lib/git/diff";
import { applyCommitDiff, parentDistrict } from "../lib/diff/apply";
import { buildGraph } from "../lib/parser/buildGraph";
import { cleanup, initRepo, makeTempDir, writeFiles } from "./helpers/fixtures";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    cleanup(dir);
  }
  dirs.length = 0;
});

/** Identity for `git commit` in temp repos without a configured user. */
function commitArgs(message: string): string[] {
  return ["-c", "user.name=CityCode Test", "-c", "user.email=citycode@test.local", "commit", "-m", message];
}

/**
 * The plan's crafted commit chain: original commit with A/B/C/D (C imports
 * B, B imports A), second commit modifies A, deletes D and adds E — so
 * closure over reverse edges from A must reach B (direct importer) and C
 * (transitive importer) with blast tint, while D turns to rubble and E to
 * fresh construction.
 */
async function makeChainFixture(root: string): Promise<string> {
  writeFiles(root, [
    {
      path: "A.ts",
      contents: 'export function a(n: number): number {\n  return n + 1;\n}\n',
    },
    {
      path: "B.ts",
      contents: 'import { a } from "./A";\nexport function b(): number {\n  return a(2);\n}\n',
    },
    {
      path: "C.ts",
      contents: 'import { b } from "./B";\nexport function c(): number {\n  return b();\n}\n',
    },
    {
      path: "D.ts",
      contents: 'export function d(): string {\n  return "d";\n}\n',
    },
  ]);
  await initRepo(root);

  fs.writeFileSync(path.join(root, "A.ts"), 'import { strict } from "node:assert";\nexport function a(n: number): number {\n  strict.ok(n > 0);\n  return n * 2;\n}\n');
  fs.rmSync(path.join(root, "D.ts"));
  writeFiles(root, [
    { path: "E.ts", contents: 'export function e(): number {\n  return 5;\n}\n' },
  ]);
  const git = simpleGit(root);
  await git.add("-A");
  await git.raw(commitArgs("modify A, delete D, add E"));
  return (await git.revparse("HEAD")).trim();
}

describe("diffCommits", () => {
  it("returns name-status classification + hunk headers for the crafted chain", async () => {
    const root = makeTempDir("citycode-diff-chain-");
    dirs.push(root);
    const headSha = await makeChainFixture(root);

    const diff = await diffCommits(root);
    expect(diff.headSha).toBe(headSha);
    expect(diff.baseSha).toMatch(/^[0-9a-f]{40}$/);

    const byPath = new Map(diff.files.map((file) => [file.path, file]));
    const a = byPath.get("A.ts");
    const d = byPath.get("D.ts");
    const e = byPath.get("E.ts");

    expect(a?.kind).toBe("modified");
    expect(d?.kind).toBe("deleted");
    expect(e?.kind).toBe("added");
    // Modified patch carries real hunk headers.
    expect(a?.hunkHeaders.length).toBeGreaterThan(0);
    expect(a?.hunkHeaders[0]).toMatch(/^@@ -\d+/);
    expect(a!.insertions + a!.deletions).toBeGreaterThan(0);
    // The deletion's patch has only `-` lines.
    expect(d!.insertions).toBe(0);
    expect(d!.deletions).toBeGreaterThan(0);
  });

  it("detects renames with -M (oldPath recorded)", async () => {
    const root = makeTempDir("citycode-diff-rename-");
    dirs.push(root);
    writeFiles(root, [
      { path: "X.ts", contents: 'export function x(): number {\n  return 1;\n}\n' },
    ]);
    await initRepo(root);

    const git = simpleGit(root);
    await git.mv("X.ts", "X2.ts");
    await git.raw(commitArgs("rename X to X2"));

    const diff = await diffCommits(root);
    const renamed = diff.files.find((file) => file.path === "X2.ts");
    expect(renamed?.kind).toBe("renamed");
    expect(renamed?.oldPath).toBe("X.ts");
  });

  it("throws a readable error on a single-commit repo", async () => {
    const root = makeTempDir("citycode-diff-single-");
    dirs.push(root);
    writeFiles(root, [{ path: "main.ts", contents: "export const one = 1;\n" }]);
    await initRepo(root);

    await expect(diffCommits(root)).rejects.toThrow(
      /only one commit — there is no previous commit to compare/,
    );
  });

  it("throws a readable error on a non-git folder", async () => {
    const root = makeTempDir("citycode-diff-norepo-");
    dirs.push(root);

    await expect(diffCommits(root)).rejects.toThrow(/not a git repository/);
  });
});

describe("applyCommitDiff", () => {
  it("classifies construction/fresh/rubble and closes the blast radius transitively", async () => {
    const root = makeTempDir("citycode-apply-chain-");
    dirs.push(root);
    await makeChainFixture(root);

    const { graph } = await buildGraph(root);
    const diff = await diffCommits(root);
    const changeSet = applyCommitDiff(graph, diff);

    const byId = new Map(changeSet.changes.map((change) => [change.fileId, change]));
    expect(byId.get("A.ts")?.status).toBe("construction");
    expect(byId.get("E.ts")?.status).toBe("fresh");
    expect(byId.get("D.ts")?.status).toBe("rubble");
    // Direct importer of A, and the transitive importer of B: blast tint.
    expect(byId.get("B.ts")?.status).toBe("blast");
    expect(byId.get("C.ts")?.status).toBe("blast");
    // No innocent bystanders, no duplicate statuses.
    expect(changeSet.changes).toHaveLength(5);
    expect(changeSet.changes).toEqual(
      [...changeSet.changes].sort((x, y) =>
        x.fileId < y.fileId ? -1 : x.fileId > y.fileId ? 1 : 0,
      ),
    );

    expect(changeSet.counts).toEqual({ modified: 1, added: 1, deleted: 1, renamed: 0 });
    expect(changeSet.headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("is deterministic: same diff + same graph → byte-identical JSON", async () => {
    const root = makeTempDir("citycode-apply-determinism-");
    dirs.push(root);
    await makeChainFixture(root);

    const { graph } = await buildGraph(root);
    const first = applyCommitDiff(graph, await diffCommits(root));
    const second = applyCommitDiff(graph, await diffCommits(root));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("clean commits between unchanged graphs yield no changes", async () => {
    const root = makeTempDir("citycode-apply-clean-");
    dirs.push(root);
    writeFiles(root, [{ path: "S.ts", contents: 'export const s = "s";\n' }]);
    await initRepo(root);

    const { graph } = await buildGraph(root);
    // The diff compared HEAD~1→HEAD on a repo with no new commit is
    // exhausted above; assert an empty name-status diff leaves no changes.
    const diff = { headSha: graph.headSha, baseSha: graph.headSha, files: [] };
    const result = applyCommitDiff(graph, diff);
    expect(result.changes).toHaveLength(0);
  });
});

describe("parentDistrict", () => {
  const districts = [
    { path: "lib" },
    { path: "lib/deep" },
    { path: "src" },
  ];

  it("matches the exact folder of a deleted file", () => {
    expect(parentDistrict(districts, "lib/deep/file.ts")?.path).toBe("lib/deep");
  });

  it("falls back to the longest surviving ancestor when the folder vanished with the repo restructure", () => {
    expect(parentDistrict(districts, "lib/gone/file.ts")?.path).toBe("lib");
  });

  it("falls back to the shallowest district for file paths outside every folder", () => {
    expect(parentDistrict(districts, "top-level.ts")?.path).toBe("lib");
  });

  it("returns null on a layout with no districts at all", () => {
    expect(parentDistrict([], "x.ts")).toBeNull();
  });
});
