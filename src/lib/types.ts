import type { QuantResult } from "./quant/types";

export type { QuantResult } from "./quant/types";

export type OutlineNode = {
  id: string;
  title: string;
  question?: string;
  children?: OutlineNode[];
};

export type NodeStatus = "pending" | "running" | "done" | "blocked" | "skipped";

/** How leaf analysis relates to the hypothesis (leaf question). */
export type HypothesisVerdict =
  | "confirmed"
  | "refuted"
  | "inconclusive"
  | "partially_supported";

export type NodeState = {
  id: string;
  status: NodeStatus;
  summary?: string;
  analysis?: string;
  quant?: QuantResult;
  /** Refined testable statement from the model (may echo or sharpen the leaf question). */
  hypothesisStatement?: string;
  verdict?: HypothesisVerdict;
  confidence?: "low" | "medium" | "high";
  /** Concrete gaps — data, context, stakeholders, or follow-up quant. */
  evidenceNeeded?: string[];
  /** Per-leaf manager pressure-test notes (markdown); only on leaves after review pass. */
  leafManagerReview?: string;
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
  | { type: "keepalive" }
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
