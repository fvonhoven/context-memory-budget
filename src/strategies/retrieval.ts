// Strategy 5: retrieval over past turns. Every turn goes into a BM25 index.
// At prompt time the incoming query pulls the best matching older turns into
// a retrieved block (chronological order, so a later correction reads after
// the value it replaced), next to a small recent window. No compaction calls.
import { BM25Index } from "../bm25.ts";
import type { Block, Strategy, Turn } from "../types.ts";

export type RetrievalOptions = { windowTurns?: number; topK?: number; retrievedShare?: number };

export function retrieval(opts: RetrievalOptions = {}): Strategy {
  const windowTurns = opts.windowTurns ?? 8;
  const topK = opts.topK ?? 12;
  const index = new BM25Index();
  const all: Turn[] = [];
  return {
    name: "retrieval",
    shares: { memory: 0, retrieved: opts.retrievedShare ?? 0.35 },
    usesPinned: true,
    async ingest(turn) {
      all.push(turn);
      index.add(turn.index, turn.text);
    },
    async assemble(query, ctx) {
      const recent = all.slice(-windowTurns);
      const exclude = new Set(recent.map((t) => t.index));
      const hits = index.search(query, topK, exclude).sort((a, b) => a.id - b.id);
      const lines: string[] = [];
      let used = 0;
      for (const h of hits) {
        const t = all[h.id - 1]!;
        const line = `[turn ${t.index}, ${t.role}] ${t.text}`;
        const cost = ctx.tokens(line) + 1;
        if (used + cost > ctx.allocation.retrieved) continue;
        lines.push(line);
        used += cost;
      }
      const blocks: Block[] = lines.length > 0 ? [{ kind: "retrieved", title: "Relevant earlier turns", text: lines.join("\n") }] : [];
      return { blocks, history: recent };
    },
    stats: () => ({ compactionCalls: 0, compactionInputTokens: 0, compactionOutputTokens: 0 }),
  };
}
