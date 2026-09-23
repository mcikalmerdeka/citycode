import { afterEach, describe, expect, it } from "vitest";
import { buildGraph } from "../lib/parser/buildGraph";
import { cleanup, makeTempDir, writeFiles } from "./helpers/fixtures";

/**
 * Python exercise — one fixture with flat + packaged modules, classes/methods,
 * relative imports, third-party packages and unresolvable names.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    cleanup(dir);
  }
  dirs.length = 0;
});

describe("buildGraph (Python)", () => {
  it("builds a full graph from a mixed flat/package layout with import edges", async () => {
    const root = makeTempDir("citycode-py-");
    dirs.push(root);
    writeFiles(root, [
      // Flat root modules — absolute `import mod_a` anchors at the repo root
      {
        path: "mod_a.py",
        contents:
          "import pandas as pd\n" +
          "def helper():\n" +
          "    return pd.DataFrame()\n" +
          "class Engine:\n" +
          "    def start(self):\n" +
          "        return 1\n",
      },
      {
        path: "mod_b.py",
        contents: "from mod_a import helper\n\ndef run():\n    return helper()\n",
      },
      // Packages with sub-modules
      { path: "mypkg/sub/__init__.py", contents: "def sub_init():\n    return 0\n" },
      { path: "mypkg/util.py", contents: "def util_fn():\n    return 42\n" },
      {
        path: "app.py",
        contents: "import mypkg.sub\nfrom mypkg.util import util_fn\n\ndef main():\n    return util_fn()\n",
      },
      // Relative imports inside a package
      { path: "inner/base.py", contents: "def base_fn():\n    return \"b\"\n" },
      { path: "inner/sibling.py", contents: "def sib():\n    return 1\n" },
      {
        path: "inner/leaf.py",
        contents:
          "from .base import base_fn\n" +        // module attr via dots — resolves inner/base.py
          "from . import sibling\n" +            // sibling module
          "from ..unknownpkg import thing\n" +   // escapes/unknown → unresolved
          "def leaf():\n    return base_fn()\n",
      },
      { path: "notes.md", contents: "not code\n" },
    ]);

    const { graph } = await buildGraph(root);
    expect(graph.source).toBe("local");

    const byId = new Map(graph.files.map((f) => [f.id, f]));

    // All .py files are nodes; .md is not
    expect([...byId.keys()].sort()).toEqual([
      "app.py",
      "inner/base.py",
      "inner/leaf.py",
      "inner/sibling.py",
      "mod_a.py",
      "mod_b.py",
      "mypkg/sub/__init__.py",
      "mypkg/util.py",
    ]);

    // Language + symbols: flat function + class method, sorted by line
    const modA = byId.get("mod_a.py");
    if (!modA) throw new Error("mod_a.py missing");
    expect(modA.language).toBe("python");
    expect(modA.functions.map((f) => f.name)).toEqual(["helper", "start"]);

    // Absolute import resolution from the repo root
    const edges = (from: string, to: string) =>
      graph.edges.filter((e) => e.fromId === from && e.toId === to);

    const edgeSymbols = edges("mod_b.py", "mod_a.py").map((e) => e.symbol);
    expect(edgeSymbols.length >= 1 && edgeSymbols.filter(Boolean).includes("helper")).toBe(true);
    expect(edges("app.py", "mypkg/sub/__init__.py").length).toBe(1); // bare import
    expect(edges("app.py", "mypkg/util.py").map((e) => e.symbol)).toEqual(["util_fn"]);

    // Relative imports: from .base import base_fn → sibling module in package
    expect(edges("inner/leaf.py", "inner/base.py").map((e) => e.symbol)).toEqual(["base_fn"]);
    expect(edges("inner/leaf.py", "inner/sibling.py").length).toBe(1);

    // Third-party → external (never an edge)
    expect(modA.externalImports).toContain("pandas");

    // Unknown relative name reported as unresolved
    const leaf = byId.get("inner/leaf.py");
    if (!leaf) throw new Error("inner/leaf.py missing");
    expect(leaf.unresolvedImports.join(" ")).toContain("unknownpkg");
    expect(graph.edges.filter((e) => e.toId.includes("unknownpkg")).length).toBe(0);
  });

  it("stays deterministic on Python sources (same folder twice → identical JSON)", async () => {
    const root = makeTempDir("citycode-py-det-");
    dirs.push(root);
    writeFiles(root, [
      { path: "zeta.py", contents: "def z():\n    return 1\n" },
      { path: "alpha.py", contents: "from zeta import z\n\ndef a():\n    return z()\n" },
    ]);

    const first = JSON.stringify(await buildGraph(root));
    const second = JSON.stringify(await buildGraph(root));
    expect(first).toBe(second);
  });
});
