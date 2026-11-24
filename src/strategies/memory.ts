// Strategy 4: structured memory. Turns evicted from the recent window are run
// through a fact extractor; facts land in a key/value store with the turn
// they came from. The store renders as a compact block. A later statement
// about the same key overwrites the value and keeps the old one in history.
import { FactStore } from "../facts.ts";
import type { Extractor } from "../facts.ts";
import type { Block, Strategy, StrategyContext, Turn } from "../types.ts";

export type MemoryOptions = { extract: Extractor; memoryShare?: number };

export function structuredMemory(opts: MemoryOptions): Strategy {
  let history: Turn[] = [];
  const store = new FactStore();
  const stats = { compactionCalls: 0, compactionInputTokens: 0, compactionOutputTokens: 0 };

  async function compact(ctx: StrategyContext): Promise<void> {
    const tokensOf = (turns: Turn[]) => turns.reduce((n, t) => n + ctx.tokens(t.text) + 4, 0);
    if (tokensOf(history) <= ctx.allocation.recent) return;
    const cut = Math.max(1, Math.floor(history.length / 2));
    const evicted = history.slice(0, cut);
    history = history.slice(cut);
    // Only user turns are treated as a source of truth about the user.
    const source = evicted.filter((t) => t.role === "user");
    stats.compactionCalls++;
    stats.compactionInputTokens += tokensOf(source);
    try {
      let added = 0;
      const fallbackTurn = evicted[evicted.length - 1]!.index;
      for (const f of source.length > 0 ? await opts.extract(source) : []) {
        store.set(f.key, f.value, f.turn ?? fallbackTurn);
        added++;
        stats.compactionOutputTokens += ctx.tokens(`${f.key}: ${f.value}`);
      }
      ctx.log({ type: "compaction", turn: evicted[evicted.length - 1]!.index, detail: `extracted ${added} facts from turns ${evicted[0]!.index}-${evicted[evicted.length - 1]!.index}` });
    } catch (err) {
      ctx.log({ type: "compaction_failed", turn: evicted[evicted.length - 1]!.index, detail: `extractor failed (${String(err)}); turns dropped without extraction` });
    }
    // Keep the block inside its cap by forgetting the oldest facts first.
    while (store.size > 0 && ctx.tokens(store.render()) > ctx.allocation.memory) {
      const oldest = store.list()[0]!;
      store.delete(oldest.key);
      ctx.log({ type: "memory_evicted", turn: oldest.turn, detail: `forgot "${oldest.key}" (turn ${oldest.turn}) to stay under the memory cap` });
    }
  }

  return {
    name: "structured-memory",
    shares: { memory: opts.memoryShare ?? 0.3, retrieved: 0 },
    usesPinned: true,
    async ingest(turn, ctx) {
      history.push(turn);
      await compact(ctx);
    },
    async assemble() {
      const blocks: Block[] = store.size > 0 ? [{ kind: "memory", title: "Known facts", text: store.render() }] : [];
      return { blocks, history };
    },
    stats: () => ({ ...stats }),
    store,
  } as Strategy & { store: FactStore };
}
