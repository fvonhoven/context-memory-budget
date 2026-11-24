import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allocate, allocationSum } from "./budget.ts";
import { loadConversations, loadProbes, validateProbes } from "./data.ts";
import { ConversationManager } from "./manager.ts";
import { STRATEGY_NAMES, strategyFactories } from "./strategies/index.ts";
import { countTokens } from "./tokens.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("allocate", () => {
  it("sections sum to the total and output is reserved first", () => {
    for (const total of [512, 1024, 4096, 16384, 200000]) {
      const a = allocate(total, 100, { memory: 0.3, retrieved: 0.2 });
      assert.equal(allocationSum(a), total);
      assert.ok(a.output >= 256 && a.output <= 1024);
      assert.ok(a.recent > 0);
    }
  });

  it("caps the system section and hands the rest to recent when shares are zero", () => {
    const a = allocate(1024, 5000, { memory: 0, retrieved: 0 });
    assert.ok(a.system < 5000);
    assert.equal(a.memory, 0);
    assert.equal(a.retrieved, 0);
    assert.equal(a.recent, 1024 - a.output - a.system);
  });

  it("rejects budgets that cannot hold a reply and bad shares", () => {
    assert.throws(() => allocate(100, 10, { memory: 0, retrieved: 0 }));
    assert.throws(() => allocate(4096, 10, { memory: 0.5, retrieved: 0.5 }));
  });
});

describe("fixtures", () => {
  it("probes agree with the conversations they cite", () => {
    const conversations = loadConversations(join(root, "data", "conversations"));
    const probes = loadProbes(join(root, "data", "probes.json"));
    assert.equal(conversations.length, 3);
    for (const c of conversations) assert.ok(c.turns.length >= 60 && c.turns.length <= 120, `${c.id} has ${c.turns.length} turns`);
    assert.deepEqual(validateProbes(conversations, probes), []);
    assert.equal(probes.filter((p) => p.kind === "changed").length, 8);
    assert.equal(probes.filter((p) => p.kind === "distractor").length, 5);
    assert.ok(probes.filter((p) => p.kind === "stable").length >= 40);
  });
});

describe("budget invariant (property-style over every fixture turn)", () => {
  it("the assembled prompt plus the output reserve never exceeds the budget for any strategy, budget or turn", async () => {
    const conversations = loadConversations(join(root, "data", "conversations"));
    const factories = strategyFactories();
    let prompts = 0;
    for (const budget of [600, 1024, 4096, 16384]) {
      for (const name of STRATEGY_NAMES) {
        for (const conv of conversations) {
          const m = new ConversationManager({ system: conv.system, pinned: conv.pinned, budget, strategy: factories[name](), tokens: countTokens });
          for (const turn of conv.turns) {
            if (turn.role === "user") {
              const p = await m.prompt(turn.text);
              prompts++;
              assert.ok(p.tokens + p.allocation.output <= budget, `${name} budget ${budget} ${conv.id} turn ${turn.index}: ${p.tokens} + ${p.allocation.output}`);
              assert.equal(p.tokens, p.sections.reduce((n, s) => n + s.tokens, 0));
              assert.equal(p.messages[p.messages.length - 1]!.role, "user");
            }
            await m.addTurn(turn.role, turn.text);
          }
        }
      }
    }
    assert.ok(prompts > 2000, `checked ${prompts} prompts`);
  });
});
