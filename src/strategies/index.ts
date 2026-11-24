// Registry of the five strategies with their offline and live wiring.
import { llmExtractor, ruleBasedExtractor } from "../facts.ts";
import type { ChatClient } from "../providers/types.ts";
import { extractiveSummarizer, llmSummarizer } from "../summarize.ts";
import { countTokens } from "../tokens.ts";
import type { StrategyFactory, Tokenizer } from "../types.ts";
import { structuredMemory } from "./memory.ts";
import { retrieval } from "./retrieval.ts";
import { rollingSummary } from "./summary.ts";
import { truncateOldest } from "./truncate.ts";
import { slidingWindow } from "./window.ts";

export const STRATEGY_NAMES = ["truncate-oldest", "sliding-window", "rolling-summary", "structured-memory", "retrieval"] as const;
export type StrategyName = (typeof STRATEGY_NAMES)[number];

export type Wiring = { client?: ChatClient; model?: string; tokens?: Tokenizer };

// With a client, summarization and extraction go to the model. Without one,
// the extractive summarizer and rule-based extractor run instead.
export function strategyFactories(wiring: Wiring = {}): Record<StrategyName, StrategyFactory> {
  const tokens = wiring.tokens ?? countTokens;
  const model = wiring.model ?? "claude-haiku-4-5";
  const summarize = wiring.client ? llmSummarizer(wiring.client, model) : extractiveSummarizer(tokens);
  const extract = wiring.client ? llmExtractor(wiring.client, model) : ruleBasedExtractor;
  return {
    "truncate-oldest": () => truncateOldest(),
    "sliding-window": () => slidingWindow(),
    "rolling-summary": () => rollingSummary({ summarize }),
    "structured-memory": () => structuredMemory({ extract }),
    retrieval: () => retrieval(),
  };
}
