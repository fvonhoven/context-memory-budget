import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NOT_STATED, grade, llmAnswerer, scriptedAnswerer } from "./answerer.ts";
import type { AssembledPrompt, Probe } from "./types.ts";
import type { ChatClient } from "./providers/types.ts";

const changed: Probe = {
  id: "x", conversation: "c", atTurn: 9, kind: "changed", question: "Where do we deploy?", answer: "Fly.io",
  evidence: ["Fly.io"], staleEvidence: ["deploy target is render"], sourceTurns: [5],
};
const distractor: Probe = { id: "d", conversation: "c", atTurn: 9, kind: "distractor", question: "CI?", answer: NOT_STATED, evidence: [], trap: ["GitHub Actions"], sourceTurns: [] };

function promptWith(contextText: string): AssembledPrompt {
  return { system: "", messages: [{ role: "user", content: "q" }], contextText, tokens: 0, budget: 0, allocation: { total: 0, output: 0, system: 0, memory: 0, retrieved: 0, recent: 0 }, sections: [] };
}

describe("scriptedAnswerer", () => {
  it("answers correctly only when the fact is in the context", async () => {
    assert.equal((await scriptedAnswerer(changed, promptWith("The deploy target is now Fly.io."))).text, "Fly.io");
    assert.equal((await scriptedAnswerer(changed, promptWith("nothing relevant"))).text, NOT_STATED);
  });

  it("answers with the stale value when it appears after the current one", async () => {
    const stale = await scriptedAnswerer(changed, promptWith("[user] deploy target is now Fly.io\n[user] the deploy target is render"));
    assert.equal(stale.text, "deploy target is render");
    const fresh = await scriptedAnswerer(changed, promptWith("[user] the deploy target is render\n[user] deploy target is now Fly.io"));
    assert.equal(fresh.text, "Fly.io");
  });

  it("says not stated on distractors unless a trap string is present", async () => {
    assert.equal((await scriptedAnswerer(distractor, promptWith("we use Vitest"))).text, NOT_STATED);
    assert.equal((await scriptedAnswerer(distractor, promptWith("ci: GitHub Actions"))).text, "GitHub Actions");
  });
});

describe("grade", () => {
  it("scores factual and distractor answers", () => {
    assert.deepEqual(grade(changed, "We deploy to Fly.io now."), { correct: true, falseRecall: false });
    assert.deepEqual(grade(changed, "The deploy target is Render"), { correct: false, falseRecall: false });
    assert.deepEqual(grade(distractor, "not stated"), { correct: true, falseRecall: false });
    assert.deepEqual(grade(distractor, "GitHub Actions"), { correct: false, falseRecall: true });
  });
});

describe("llmAnswerer", () => {
  it("appends the answer instruction and normalizes messages", async () => {
    let req: Parameters<ChatClient>[0] | undefined;
    const client: ChatClient = async (r) => {
      req = r;
      return { text: "Fly.io", toolCalls: [], usage: { inputTokens: 5, outputTokens: 2 }, latencyMs: 1, model: r.model, stopReason: "end_turn" };
    };
    const prompt = promptWith("");
    prompt.messages = [{ role: "assistant", content: "a" }, { role: "user", content: "q" }];
    const out = await llmAnswerer(client, "m")(changed, prompt);
    assert.equal(out.text, "Fly.io");
    assert.equal(req!.messages[0]!.role, "user");
    assert.ok(req!.messages[req!.messages.length - 1]!.content.includes(NOT_STATED));
  });
});
