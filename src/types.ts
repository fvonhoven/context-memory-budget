// Shared types for the conversation manager, its strategies, and the probes.
import type { ChatMessage } from "./providers/types.ts";

export type Role = "user" | "assistant";

// One message in the history. index is 1-based and stable for the whole run,
// so summaries and memory entries can cite where a fact came from.
export type Turn = { index: number; role: Role; text: string };

export type Conversation = {
  id: string;
  title: string;
  system: string;
  // Facts the application chose to pin. Strategies that support pinning put
  // these in the system section on every turn, regardless of history size.
  pinned: string[];
  turns: Turn[];
};

// Approximate tokenizer. Swap in a real one by passing a different function.
export type Tokenizer = (text: string) => number;

// Token split of one prompt. output is reserved for the model's reply.
export type Allocation = {
  total: number;
  output: number;
  system: number;
  memory: number;
  retrieved: number;
  recent: number;
};

// Fraction of the post-system budget a strategy wants for its blocks.
// Whatever a block does not use flows to the recent-turns section.
export type Shares = { memory: number; retrieved: number };

export type LogEvent = { type: string; turn?: number; detail?: string };

// A strategy returns blocks (rendered into the system section, each capped by
// the allocation) and a candidate history (fitted newest-first into recent).
export type Block = { kind: "memory" | "summary" | "retrieved"; title: string; text: string };

export type StrategyContext = {
  tokens: Tokenizer;
  allocation: Allocation;
  pinned: string[];
  log: (e: LogEvent) => void;
};

export type StrategyStats = { compactionCalls: number; compactionInputTokens: number; compactionOutputTokens: number };

export type Strategy = {
  name: string;
  shares: Shares;
  usesPinned: boolean;
  ingest(turn: Turn, ctx: StrategyContext): Promise<void>;
  assemble(query: string, ctx: StrategyContext): Promise<{ blocks: Block[]; history: Turn[] }>;
  stats(): StrategyStats;
};

export type StrategyFactory = () => Strategy;

export type PromptSection = { name: string; tokens: number };

export type AssembledPrompt = {
  system: string;
  messages: ChatMessage[];
  // Text a grader can search for facts. Excludes the query itself.
  contextText: string;
  tokens: number;
  budget: number;
  allocation: Allocation;
  sections: PromptSection[];
};

export type ProbeKind = "stable" | "changed" | "distractor";

export type Probe = {
  id: string;
  conversation: string;
  // Asked after this turn index has been ingested.
  atTurn: number;
  kind: ProbeKind;
  question: string;
  answer: string;
  // Any one of these strings present in the context means the fact is there.
  evidence: string[];
  // For changed facts: the superseded value. Present after the new value means
  // the answerer picks the stale one.
  staleEvidence?: string[];
  // For distractors: plausible wrong answers. Any of them in the context or in
  // a model reply counts as false recall.
  trap?: string[];
  sourceTurns: number[];
};
