// Rolling summary: compact a prior summary plus a batch of turns into a new
// summary that fits a token cap. Two implementations: a model call, and an
// extractive fallback that only ever reuses sentences from the input.
import { splitSentences } from "./facts.ts";
import type { ChatClient } from "./providers/types.ts";
import type { Tokenizer, Turn } from "./types.ts";

export type Summarizer = (prior: string, turns: Turn[], maxTokens: number) => Promise<string>;

type Scored = { line: string; score: number; order: number };

const SIGNAL = /\b(is|are|will|decided|use|using|chose|changed|now|instead|budget|deadline|prefer|date|number|price|cost|name|book|hotel|flight|address|version)\b/i;

// Sentences are scored for the kind of content that questions come back to:
// numbers, proper nouns, decision words. Sentences carried over from the
// prior summary get a small bonus so older facts do not vanish at once, but
// with a fixed cap they do age out eventually. That is the tradeoff of a
// rolling summary and the measurement shows it.
export function extractiveSummarizer(tokens: Tokenizer): Summarizer {
  return async (prior, turns, maxTokens) => {
    const candidates: Scored[] = [];
    let order = 0;
    for (const line of prior.split("\n").filter((l) => l.trim().length > 0)) {
      candidates.push({ line, score: scoreSentence(line) + 1, order: order++ });
    }
    for (const t of turns) {
      if (t.role !== "user") continue;
      for (const s of splitSentences(t.text)) {
        if (s.startsWith("```") || s.length < 12) continue;
        const line = s.startsWith("(t") ? s : `(t${t.index}) ${s}`;
        candidates.push({ line, score: scoreSentence(s), order: order++ });
      }
    }
    const ranked = [...candidates].sort((a, b) => b.score - a.score || a.order - b.order);
    const chosen: Scored[] = [];
    let used = 0;
    for (const c of ranked) {
      const cost = tokens(c.line) + 1;
      if (used + cost > maxTokens) continue;
      chosen.push(c);
      used += cost;
    }
    chosen.sort((a, b) => a.order - b.order);
    return chosen.map((c) => c.line).join("\n");
  };
}

export function scoreSentence(s: string): number {
  let score = 0;
  if (/\d/.test(s)) score += 2;
  const words = s.replace(/^\(t\d+\)\s*/, "").split(/\s+/);
  score += Math.min(3, words.slice(1).filter((w) => /^[A-Z][a-zA-Z]/.test(w)).length);
  if (SIGNAL.test(s)) score += 2;
  if (s.length > 200) score -= 1;
  if (/\?$/.test(s)) score -= 2;
  return score;
}

export function llmSummarizer(client: ChatClient, model: string): Summarizer {
  return async (prior, turns, maxTokens) => {
    const transcript = turns.map((t) => `[turn ${t.index}, ${t.role}] ${t.text}`).join("\n");
    const res = await client({
      model,
      maxTokens: Math.max(64, Math.min(maxTokens, 1024)),
      temperature: 0,
      system:
        "You maintain a running summary of a conversation. Merge the prior summary and the new turns into an updated summary. " +
        "Keep every concrete fact, decision, name, date and amount, one per line, citing the turn like (t12). " +
        "If a later turn changes a fact, keep only the new value. Do not add anything not stated. " +
        `Stay under ${maxTokens} tokens.`,
      messages: [{ role: "user", content: `Prior summary:\n${prior || "(none)"}\n\nNew turns:\n${transcript}` }],
    });
    return res.text.trim();
  };
}
