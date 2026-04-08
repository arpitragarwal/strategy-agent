import type { OutlineNode } from "./types";

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
