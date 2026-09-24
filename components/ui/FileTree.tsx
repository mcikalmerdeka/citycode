"use client";

/**
 * FileTree — the IDE-style working directory for the repo being visualized,
 * rendered as the right sidebar next to the 3D city.
 *
 * Shape: derived purely from the graph's file ids (repo-relative POSIX paths)
 * into a nested, deterministically-sorted tree — folders first, then files,
 * alphabetical. No layout data leaks in here beyond the graph itself.
 *
 * Behavior:
 * - Folders start COLLAPSED (an IDE opening fresh); toggling opens/closes.
 * - Clicking a folder shows a chevron flip animation and vice versa.
 * - Clicking a file selects it (`select`) AND flies the camera to its
 *   building (`requestFocus`) — every selection-driven consumer (inspect
 *   panel, selection glow, compare overlays) reacts through the same store.
 * - When the selection changes (e.g. a building click in the city), ancestor
 *   folders of that file auto-expand so the tree reveals the selection —
 *   derived, not effect-driven: `open(dir) = manualClose ? false :
 *   manualOpen ∨ selectionAncestors.has(dir)`. User-closed folders win over
 *   the auto-reveal, exactly like a real IDE tree.
 * - In compare modes, each file row carries a small status dot built from the
 *   current {@link ChangeSet}.
 *
 * Visual contract note: folder/file colors are neutral zinc — the only hue
 * in the tree is the compare-status dot, mirroring the scene's
 * STATUS_COLORS palette exactly.
 */

import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import type { CodeGraph, FileNode } from "@/lib/types";
import type { ChangeSet, NodeStatus } from "@/lib/diff/apply";
import { useCityStore } from "@/lib/store";

/**
 * Mirror of STATUS_COLORS (components/city/Buildings.tsx) — keep in sync.
 * Duplicated deliberately: importing the Buildings component here would pull
 * the entire three.js chunk into this always-mounted sidebar chunk.
 */
const STATUS_COLORS: Record<NodeStatus, string> = {
  construction: "#f59e0b",
  fresh: "#a3e635",
  foundation: "#e2e8f0",
  rubble: "#57534e",
  moved: "#22d3ee",
  blast: "#ef4444",
};

/** One node of the IDE tree: a folder or a leaf file. */
interface TreeNode {
  name: string;
  /** Full repo-relative path — the stable key for collapse state. */
  path: string;
  kind: "dir" | "file";
  file?: FileNode;
  children: TreeNode[];
}

/**
 * Build the nested tree from file ids. Deterministic: folders sort before
 * files, each level alphabetically by name (plain `<`, never localeCompare).
 */
function buildTree(files: readonly FileNode[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", kind: "dir", children: [] };
  for (const file of files) {
    const parts = file.id.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const isFile = i === parts.length - 1;
      const name = parts[i];
      const path = isFile ? file.id : parts.slice(0, i + 1).join("/");
      let child = node.children.find(
        (candidate) => candidate.name === name && candidate.kind === (isFile ? "file" : "dir"),
      );
      if (child === undefined) {
        child = {
          name,
          path,
          kind: isFile ? "file" : "dir",
          ...(isFile ? { file } : {}),
          children: [],
        };
        node.children.push(child);
      }
      node = child;
    }
  }
  const sort = (nodes: TreeNode[]): TreeNode[] => {
    for (const n of nodes) sort(n.children);
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return nodes;
  };
  return sort(root.children);
}

export function FileTree({
  graph,
  changeSet,
}: {
  graph: CodeGraph;
  changeSet: ChangeSet | null;
}) {
  const selectedId = useCityStore((state) => state.selectedId);
  const select = useCityStore((state) => state.select);
  const requestFocus = useCityStore((state) => state.requestFocus);

  const tree = useMemo(() => buildTree(graph.files), [graph.files]);

  const statuses = useMemo(
    () =>
      changeSet === null
        ? null
        : new Map(changeSet.changes.map((change) => [change.fileId, change.status])),
    [changeSet],
  );

  // Ancestor folders of the selected file — they auto-open so a selection
  // made in the city reveals its file row.
  const autoOpen = useMemo(() => {
    const open = new Set<string>();
    if (selectedId !== null) {
      const parts = selectedId.split("/");
      for (let i = 1; i < parts.length; i++) {
        open.add(parts.slice(0, i).join("/"));
      }
    }
    return open;
  }, [selectedId]);

  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [openedManual, setOpenedManual] = useState<Set<string>>(new Set());

  const isFolderOpen = (path: string): boolean =>
    closed.has(path) ? false : openedManual.has(path) || autoOpen.has(path);

  const toggleFolder = (path: string): void => {
    if (isFolderOpen(path)) {
      setClosed((previous) => new Set(previous).add(path));
      setOpenedManual((previous) => {
        const next = new Set(previous);
        next.delete(path);
        return next;
      });
    } else {
      setClosed((previous) => {
        const next = new Set(previous);
        next.delete(path);
        return next;
      });
      setOpenedManual((previous) => new Set(previous).add(path));
    }
  };

  const renderRows = (nodes: TreeNode[], depth: number): ReactNode[] =>
    nodes.map((node) => {
      if (node.kind === "dir") {
        const open = isFolderOpen(node.path);
        return (
          <li key={node.path}>
            <button
              type="button"
              onClick={() => toggleFolder(node.path)}
              aria-expanded={open}
              className="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left transition-colors hover:bg-zinc-800/70"
              style={{ paddingLeft: depth * 12 + 8 }}
            >
              <svg
                viewBox="0 0 8 8"
                className={`h-2 w-2 shrink-0 text-zinc-500 transition-transform ${open ? "rotate-90" : ""}`}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                aria-hidden="true"
              >
                <path d="M2.5 1.5 5 4 2.5 6.5" />
              </svg>
              <span className="truncate font-mono text-[11px] text-zinc-400">{node.name}/</span>
            </button>
            {open && <ul className="list-none">{renderRows(node.children, depth + 1)}</ul>}
          </li>
        );
      }

      const status = statuses?.get(node.path);
      const active = selectedId === node.path;
      return (
        <li key={node.path}>
          <button
            type="button"
            title={node.path}
            onClick={() => {
              select(node.path);
              requestFocus(node.path);
            }}
            className={`flex w-full min-w-0 items-center gap-2 rounded py-0.5 pr-1.5 text-left transition-colors ${
              active ? "bg-zinc-800/90 ring-1 ring-zinc-600" : "hover:bg-zinc-800/70"
            }`}
            style={{ paddingLeft: depth * 12 + 8 }}
          >
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: status === undefined ? "#5b5f6a" : STATUS_COLORS[status] }}
            />
            <span
              className={`min-w-0 truncate font-mono text-[11px] ${
                active ? "text-zinc-100" : "text-zinc-300"
              }`}
            >
              {node.name}
            </span>
            {/* Right-aligned trivial metadata — never the color channel */}
            <span className="ml-auto shrink-0 font-mono text-[9px] text-zinc-600">
              {node.file?.loc}
            </span>
          </button>
        </li>
      );
    });

  return (
    <>
      {/* Panel header: what repo this tree belongs to */}
      <div className="border-b border-zinc-800/70 p-3">
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-mono text-[9px] uppercase tracking-[0.22em] text-zinc-500">
            Workspace
          </p>
          <span className="font-mono text-[9px] text-zinc-500">{graph.files.length} files</span>
        </div>
        <p className="mt-1 truncate font-mono text-[10px] text-zinc-400" title={graph.repoPath}>
          {graph.repoPath}
        </p>
      </div>
      {/* The tree itself */}
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-2">
        {graph.files.length === 0 ? (
          <p className="px-2 text-[11px] leading-relaxed text-zinc-600">no files parsed</p>
        ) : (
          <ul className="list-none">{renderRows(tree, 0)}</ul>
        )}
      </div>
    </>
  );
}
