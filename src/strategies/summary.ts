// Strategy 3: rolling summary. When the recent turns outgrow their section,
// the oldest half is folded into a running summary. The summary lives in a
// block capped by the memory allocation. If the summarizer fails, this
// compaction degrades to a plain window drop, the failure is logged, and the
// pinned facts are untouched because they never pass through the summarizer.
import type { Summarizer } from "../summarize.ts";
import type { Block, Strategy, StrategyContext, Turn } from "../types.ts";

export type SummaryOptions = { summarize: Summarizer; memoryShare?: number };

export function rollingSummary(opts: SummaryOptions): Strategy {
  let history: Turn[] = [];
  let summary = "";
  const stats = { compactionCalls: 0, compactionInputTokens: 0, compactionOutputTokens: 0 };

  async function compact(ctx: StrategyContext): Promise<void> {
    const tokensOf = (turns: Turn[]) => turns.reduce((n, t) => n + ctx.tokens(t.text) + 4, 0);
    if (tokensOf(history) <= ctx.allocation.recent) return;
    const cut = Math.max(1, Math.floor(history.length / 2));
    const evicted = history.slice(0, cut);
    history = history.slice(cut);
    const cap = ctx.allocation.memory;
    stats.compactionCalls++;
    stats.compactionInputTokens += ctx.tokens(summary) + tokensOf(evicted);
    try {
      summary = await opts.summarize(summary, evicted, cap);
      stats.compactionOutputTokens += ctx.tokens(summary);
      ctx.log({ type: "compaction", turn: evicted[evicted.length - 1]!.index, detail: `summarized turns ${evicted[0]!.index}-${evicted[evicted.length - 1]!.index}` });
    } catch (err) {
      ctx.log({
        type: "compaction_failed",
        turn: evicted[evicted.length - 1]!.index,
        detail: `summarizer failed (${String(err)}); dropped turns ${evicted[0]!.index}-${evicted[evicted.length - 1]!.index} like a sliding window, prior summary kept`,
      });
    }
  }

  return {
    name: "rolling-summary",
    shares: { memory: opts.memoryShare ?? 0.3, retrieved: 0 },
    usesPinned: true,
    async ingest(turn, ctx) {
      history.push(turn);
      await compact(ctx);
    },
    async assemble() {
      const blocks: Block[] = summary ? [{ kind: "summary", title: "Summary of earlier turns", text: summary }] : [];
      return { blocks, history };
    },
    stats: () => ({ ...stats }),
  };
}
