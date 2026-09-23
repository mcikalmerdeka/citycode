import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { walkSourceFiles } from "../lib/git/local";
import { cleanup, makeTempDir, writeFiles } from "./helpers/fixtures";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    cleanup(dir);
  }
  dirs.length = 0;
});

describe("walkSourceFiles", () => {
  it("skips node_modules, .git, .next, dist, build and .citycode-cache", () => {
    const root = makeTempDir("citycode-walker-skip-");
    dirs.push(root);
    writeFiles(root, [
      { path: "src/main.ts", contents: "export const a = 1;\n" },
      { path: "node_modules/pkg/index.ts", contents: "export const b = 2;\n" },
      { path: ".git/config.ts", contents: "export const c = 3;\n" },
      { path: ".next/cache.ts", contents: "export const d = 4;\n" },
      { path: "dist/out.ts", contents: "export const e = 5;\n" },
      { path: "build/out.ts", contents: "export const f = 6;\n" },
      { path: ".citycode-cache/snap.ts", contents: "export const g = 7;\n" },
    ]);

    const { files } = walkSourceFiles(root);
    expect(files.map((f) => f.id)).toEqual(["src/main.ts"]);
  });

  it("now INCLUDES .py files next to .ts/.tsx, but keeps a hard allowlist (JS/.md never sneak in)", () => {
    const root = makeTempDir("citycode-walker-ext-");
    dirs.push(root);
    writeFiles(root, [
      { path: "src/main.ts", contents: "export const a = 1;\n" },
      { path: "src/App.tsx", contents: "export const b = 2;\n" },
      { path: "src/util.js", contents: "export const c = 3;\n" },
      { path: "src/script.py", contents: "x = 1\n" }, // first-party Python now parses
      { path: "src/notes.md", contents: "notes\n" },
      { path: "src/data.json", contents: "{}\n" },
    ]);

    const { files, otherCodeFiles } = walkSourceFiles(root);
    expect(
      files.map((f) => f.id).sort(),
    ).toEqual(["src/App.tsx", "src/main.ts", "src/script.py"]);
    expect(otherCodeFiles).toEqual({ ".js": 1 }); // true external-code marker only
  });

  it("returns repo-relative POSIX ids with forward slashes and correct languages", () => {
    const root = makeTempDir("citycode-walker-posix-");
    dirs.push(root);
    writeFiles(root, [
      { path: "src/nested/deep/mod.ts", contents: "export const a = 1;\n" },
      { path: "src/App.tsx", contents: "export const b = 2;\n" },
    ]);

    const { files } = walkSourceFiles(root);
    expect(files.map((f) => f.id)).toEqual(["src/App.tsx", "src/nested/deep/mod.ts"]);

    const mod = files.find((f) => f.id === "src/nested/deep/mod.ts");
    expect(mod?.language).toBe("typescript");
    const app = files.find((f) => f.id === "src/App.tsx");
    expect(app?.language).toBe("tsx");
    expect(fs.existsSync(mod?.absolutePath ?? "")).toBe(true);
  });

  it("survives folder names with spaces (Windows path safety)", () => {
    const root = makeTempDir("citycode-walker-space-");
    dirs.push(root);
    writeFiles(root, [
      { path: "my project/spacey.ts", contents: "export const a = 1;\n" },
      { path: "my project/deeper/nested file.ts", contents: "export const b = 2;\n" },
    ]);

    const { files } = walkSourceFiles(root);
    expect(files.map((f) => f.id).sort()).toEqual([
      "my project/deeper/nested file.ts",
      "my project/spacey.ts",
    ]);
  });

  it("counts known non-TS code files for diagnostics (no extension sneaks into files)", () => {
    const root = makeTempDir("citycode-walker-othercode-");
    dirs.push(root);
    writeFiles(root, [
      { path: "main.ts", contents: "export const a = 1;\n" },
      { path: "src/app.py", contents: "x = 1\n" },
      { path: "src/util.js", contents: "var a = 1;\n" },
      { path: "src/util2.js", contents: "var b = 2;\n" },
    ]);

    const { files, otherCodeFiles } = walkSourceFiles(root);
    expect(files.map((f) => f.id).sort()).toEqual(["main.ts", "src/app.py"]); // .py is now parsed, not skipped
    expect(otherCodeFiles).toEqual({ ".js": 2 }); // .js stays the diagnostics-only leftover
  });

  it("is deterministic — same folder walked twice gives byte-identical output, ids sorted", () => {
    const root = makeTempDir("citycode-walker-det-");
    dirs.push(root);
    writeFiles(root, [
      { path: "z.ts", contents: "export const a = 1;\n" },
      { path: "a/b.ts", contents: "export const b = 2;\n" },
      { path: "a/c.tsx", contents: "export const c = 3;\n" },
    ]);

    const { files: first } = walkSourceFiles(root);
    const { files: second } = walkSourceFiles(root);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.map((f) => f.id)).toEqual(["a/b.ts", "a/c.tsx", "z.ts"]);
  });
});
