import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractiveSummarizer, llmSummarizer, scoreSentence } from "./summarize.ts";
import { countTokens } from "./tokens.ts";
import type { ChatClient } from "./providers/types.ts";
import type { Turn } from "./types.ts";

const turns: Turn[] = [
  { index: 1, role: "user", text: "Hi there. The database is PostgreSQL 16. I hope that is fine with you and everyone else." },
  { index: 2, role: "assistant", text: "Great choice, it is a solid database with many features that I could list here at length." },
  { index: 3, role: "user", text: "The launch date is October 14. Where should I start?" },
];

describe("extractiveSummarizer", () => {
  it("keeps fact sentences with turn citations and stays under the cap", async () => {
    const summary = await extractiveSummarizer(countTokens)("", turns, 40);
    assert.ok(countTokens(summary) <= 40);
    assert.ok(summary.includes("(t1) The database is PostgreSQL 16."));
    assert.ok(summary.includes("(t3) The launch date is October 14."));
    assert.ok(!summary.includes("Great choice"), "assistant text is not summarized");
  });

  it("rolls the prior summary forward and drops the weakest lines when full", async () => {
    const prior = "(t1) The database is PostgreSQL 16.";
    const summary = await extractiveSummarizer(countTokens)(prior, [turns[2]!], 14);
    assert.ok(summary.includes("PostgreSQL 16") || summary.includes("October 14"));
    assert.ok(countTokens(summary) <= 14);
  });

  it("scores numbers and decision words above questions", () => {
    assert.ok(scoreSentence("The budget is $4,500.") > scoreSentence("Where should I start?"));
  });
});

describe("llmSummarizer", () => {
  it("sends prior summary and turns to the client", async () => {
    let seen = "";
    const client: ChatClient = async (req) => {
      seen = req.messages[0]!.content;
      return { text: " new summary ", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, model: req.model, stopReason: "end_turn" };
    };
    const out = await llmSummarizer(client, "fake")("old summary", turns, 200);
    assert.equal(out, "new summary");
    assert.ok(seen.includes("old summary") && seen.includes("[turn 3, user]"));
  });
});
