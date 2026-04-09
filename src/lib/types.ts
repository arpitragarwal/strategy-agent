import type { QuantResult } from "./quant/types";

export type { QuantResult } from "./quant/types";

export type OutlineNode = {
  id: string;
  title: string;
  question?: string;
  children?: OutlineNode[];
};

export type NodeStatus = "pending" | "running" | "done" | "blocked" | "skipped";

export type NodeState = {
  id: string;
  status: NodeStatus;
  summary?: string;
  analysis?: string;
  quant?: QuantResult;
};

export type ProgressEntry = {
  at: string;
  stage: string;
  message: string;
};

export type ReviewCheckpoint =
  | "after_discovery"
  | "after_structure"
  | "after_analysis";

export type StreamEvent =
  | { type: "progress"; entry: ProgressEntry }
  | { type: "discovery"; text: string }
  | { type: "outline"; roots: OutlineNode[] }
  | { type: "tree_review"; notes: string }
  | { type: "node"; state: NodeState }
  | { type: "manager"; notes: string }
  | { type: "synthesis"; text: string; partial?: boolean }
  | { type: "redirect_ack"; note: string }
  | { type: "awaiting_review"; checkpoint: ReviewCheckpoint }
  | { type: "complete"; runId: string }
  | { type: "error"; message: string };
