// Structured memory: facts as key/value pairs with provenance, plus the two
// extractors that produce them (a model call, and a rule-based fallback).
import type { ChatClient } from "./providers/types.ts";
import type { Turn } from "./types.ts";

export type Fact = { key: string; value: string; turn: number; history: { value: string; turn: number }[] };
export type ExtractedFact = { key: string; value: string; turn?: number };
export type Extractor = (turns: Turn[]) => Promise<ExtractedFact[]>;

export class FactStore {
  private readonly facts = new Map<string, Fact>();

  // Setting an existing key overwrites the value and records the old one.
  // The newest statement wins; that is the contract for contradictions.
  set(key: string, value: string, turn: number): Fact {
    const k = normalizeKey(key);
    const prev = this.facts.get(k);
    if (prev) {
      if (prev.value !== value) prev.history.push({ value: prev.value, turn: prev.turn });
      prev.value = value;
      prev.turn = turn;
      return prev;
    }
    const fact: Fact = { key: k, value, turn, history: [] };
    this.facts.set(k, fact);
    return fact;
  }

  get(key: string): Fact | undefined {
    return this.facts.get(normalizeKey(key));
  }

  delete(key: string): boolean {
    return this.facts.delete(normalizeKey(key));
  }

  get size(): number {
    return this.facts.size;
  }

  // Most recently updated last, so a cap that trims from the front drops the
  // oldest facts first.
  list(): Fact[] {
    return [...this.facts.values()].sort((a, b) => a.turn - b.turn);
  }

  render(): string {
    return this.list()
      .map((f) => `- ${f.key}: ${f.value} (turn ${f.turn})`)
      .join("\n");
  }
}

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/^(the|our|my|your|a|an)\s+/, "").replace(/\s+/g, " ").trim();
}

// Rule-based extractor. Deliberately narrow: it catches "The X is Y",
// "X is now Y", "X changed to Y" and similar copular statements, which is
// how people state settings and decisions. It does not understand anything.
const PRONOUNS = new Set(["it", "that", "this", "there", "he", "she", "they", "what", "which", "who", "one", "thing", "problem", "question", "issue", "idea", "plan", "point", "answer", "reason", "rest", "same", "other", "only"]);
const BAD_VALUE_START = new Set(["a", "an", "to", "that", "not", "also", "going", "what", "how", "it", "there", "because", "still", "fine", "good", "ok", "okay", "why", "when", "where", "if", "as", "in", "on", "about", "just", "very", "really", "more", "less", "all", "any", "some", "no", "yes", "done", "ready", "here", "up", "out"]);

// An optional leading clause ("Runtime detail: ..." or "So, to be clear, ...")
// is skipped so the statement can sit mid-sentence.
const LEAD = "^(?:[^:,]{0,40}[:,]\\s+)?";
const SUBJECT = "(?:the|our|my|your)?\\s*([A-Za-z][A-Za-z0-9'\\-/ ]{1,40}?)";
const PATTERNS: RegExp[] = [
  new RegExp(`${LEAD}${SUBJECT}\\s+(?:is|are|will be)\\s+(?:now\\s+|going to be\\s+|set to\\s+)?(.+?)(?:\\s+instead of\\s+.+|\\s+from now on|\\s+now|\\s+rather than\\s+.+)?[.!]?$`, "i"),
  new RegExp(`${LEAD}${SUBJECT}\\s+(?:has\\s+)?(?:changed|moved|switched)\\s+to\\s+(.+?)(?:\\s+instead of\\s+.+|,.*)?[.!]?$`, "i"),
];

export function splitSentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function extractFactsRuleBased(text: string): ExtractedFact[] {
  const out: ExtractedFact[] = [];
  for (const sentence of splitSentences(text)) {
    if (sentence.startsWith("```") || sentence.includes("://")) continue;
    for (const re of PATTERNS) {
      const m = re.exec(sentence);
      if (!m) continue;
      const key = normalizeKey(m[1]!);
      // Keep the value up to the first comma: "9 Cedar Court, effective..."
      const value = m[2]!.split(",")[0]!.trim().replace(/[.!]$/, "");
      const keyWords = key.split(" ");
      const valueWords = value.split(/\s+/);
      if (keyWords.length > 4 || PRONOUNS.has(keyWords[0]!) || PRONOUNS.has(key)) break;
      if (valueWords.length > 8 || value.length > 60 || BAD_VALUE_START.has(valueWords[0]!.toLowerCase())) break;
      out.push({ key, value });
      break;
    }
  }
  return out;
}

export const ruleBasedExtractor: Extractor = async (turns) =>
  turns.flatMap((t) => extractFactsRuleBased(t.text).map((f) => ({ ...f, turn: t.index })));

// Model-backed extractor. The model returns one "key: value (t12)" per line.
export function llmExtractor(client: ChatClient, model: string): Extractor {
  return async (turns) => {
    const transcript = turns.map((t) => `[turn ${t.index}, ${t.role}] ${t.text}`).join("\n");
    const res = await client({
      model,
      maxTokens: 400,
      temperature: 0,
      system:
        "Extract durable facts the user states about their situation, choices, settings, dates, names and amounts. " +
        "Output one fact per line as 'key: value (tN)' where N is the turn it came from, short keys, exact values. Only facts the user stated. " +
        "If a fact updates an earlier one, output the new value under the same key. Output nothing else.",
      messages: [{ role: "user", content: transcript }],
    });
    return res.text
      .split("\n")
      .map((line) => line.replace(/^[-*\s]+/, "").trim())
      .filter((line) => line.includes(":"))
      .map((line) => {
        const i = line.indexOf(":");
        const m = /\s*\(t(\d+)\)\s*$/.exec(line);
        const value = line.slice(i + 1).replace(/\s*\(t\d+\)\s*$/, "").trim();
        return { key: normalizeKey(line.slice(0, i)), value, turn: m ? Number(m[1]) : undefined };
      })
      .filter((f) => f.key.length > 0 && f.value.length > 0 && f.key.length <= 60 && f.value.length <= 120);
  };
}
