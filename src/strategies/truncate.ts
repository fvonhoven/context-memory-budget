// Strategy 1: truncate oldest. Keep the system prompt and as many of the
// newest turns as fit. No pinned facts, no blocks, no compaction calls.
// This is what happens by default when a chat app hits the context limit.
import type { Strategy, Turn } from "../types.ts";

export function truncateOldest(): Strategy {
  const history: Turn[] = [];
  return {
    name: "truncate-oldest",
    shares: { memory: 0, retrieved: 0 },
    usesPinned: false,
    async ingest(turn) {
      history.push(turn);
    },
    async assemble() {
      return { blocks: [], history };
    },
    stats: () => ({ compactionCalls: 0, compactionInputTokens: 0, compactionOutputTokens: 0 }),
  };
}
