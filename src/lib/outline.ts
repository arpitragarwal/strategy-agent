import type { OutlineNode } from "./types";

/** Stored JSON shape for the MECE tree. */
export type OutlineDoc = { roots: OutlineNode[] };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Assign ids where missing so downstream state keys are stable. */
export function ensureOutlineIds(roots: OutlineNode[]): OutlineNode[] {
  let seq = 0;
  function walk(n: OutlineNode): OutlineNode {
    const id = typeof n.id === "string" && n.id.trim() ? n.id.trim() : `auto_${++seq}`;
    const title = typeof n.title === "string" && n.title.trim() ? n.title.trim() : "Untitled";
    const rawChildren = Array.isArray(n.children) ? n.children : [];
    const children = rawChildren.map((c) =>
      walk(c as OutlineNode),
    );
    return {
      ...n,
      id,
      title,
      question: typeof n.question === "string" ? n.question : undefined,
      children,
    };
  }
  return roots.map(walk);
}

/**
 * Models often return alternate shapes: `root` vs `roots`, wrong casing, or a bare array.
 * Returns null if nothing usable.
 */
export function normalizeOutlineDoc(raw: unknown): OutlineDoc | null {
  if (raw === null || raw === undefined) return null;

  if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    if (isRecord(raw[0])) return { roots: raw as OutlineNode[] };
    return null;
  }

  if (!isRecord(raw)) return null;

  const pickArray = (o: Record<string, unknown>): unknown[] | null => {
    const direct = o.roots ?? o.Roots ?? o.ROOTS;
    if (Array.isArray(direct) && direct.length > 0) return direct;
    const key = Object.keys(o).find((k) => k.toLowerCase() === "roots");
    if (key && Array.isArray(o[key]) && (o[key] as unknown[]).length > 0) {
      return o[key] as unknown[];
    }
    for (const alt of ["issue_tree", "pillars", "nodes", "tree", "children"]) {
      const v = o[alt];
      if (Array.isArray(v) && v.length > 0) return v;
    }
    const root = o.root ?? o.Root;
    if (Array.isArray(root) && root.length > 0) return root;
    if (isRecord(root)) return [root];
    return null;
  };

  const arr = pickArray(raw);
  if (!arr || arr.length === 0) return null;

  const roots = arr.filter(isRecord) as OutlineNode[];
  if (roots.length === 0) return null;

  return { roots: ensureOutlineIds(roots) };
}

export function flattenLeaves(roots: OutlineNode[]): OutlineNode[] {
  const out: OutlineNode[] = [];
  function walk(n: OutlineNode) {
    if (n.children?.length) n.children.forEach(walk);
    else out.push(n);
  }
  roots.forEach(walk);
  return out;
}

export function pathToNode(roots: OutlineNode[], leafId: string): string[] {
  const path: string[] = [];
  function find(nodes: OutlineNode[], stack: string[]): boolean {
    for (const n of nodes) {
      const next = [...stack, n.title];
      if (n.id === leafId) {
        path.push(...next);
        return true;
      }
      if (n.children?.length && find(n.children, next)) return true;
    }
    return false;
  }
  find(roots, []);
  return path;
}

export function initNodeStates(roots: OutlineNode[]): Record<string, NodeStateInit> {
  const states: Record<string, NodeStateInit> = {};
  function walk(n: OutlineNode) {
    if (n.children?.length) n.children.forEach(walk);
    else states[n.id] = { id: n.id, status: "pending" };
  }
  roots.forEach(walk);
  return states;
}

type NodeStateInit = { id: string; status: "pending" };
