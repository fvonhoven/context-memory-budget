// Strategy 2: sliding window plus pinned facts. Only the last N turns are
// candidates for the prompt; the pinned facts ride in the system section on
// every turn. Cheap and predictable, and blind to anything older than N.
import type { Strategy, Turn } from "../types.ts";

export const DEFAULT_WINDOW_TURNS = 16;

export function slidingWindow(windowTurns = DEFAULT_WINDOW_TURNS): Strategy {
  const history: Turn[] = [];
  return {
    name: "sliding-window",
    shares: { memory: 0, retrieved: 0 },
    usesPinned: true,
    async ingest(turn) {
      history.push(turn);
      if (history.length > windowTurns) history.shift();
    },
    async assemble() {
      return { blocks: [], history };
    },
    stats: () => ({ compactionCalls: 0, compactionInputTokens: 0, compactionOutputTokens: 0 }),
  };
}
