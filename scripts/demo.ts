// Runs one strategy over the first part of the support conversation at a
// small budget and prints what the manager actually did: the allocation, the
// compaction log, the memory block, and the assembled prompt for one probe.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedAnswerer } from "../src/answerer.ts";
import { loadConversations, loadProbes } from "../src/data.ts";
import { ConversationManager } from "../src/manager.ts";
import { strategyFactories } from "../src/strategies/index.ts";
import type { StrategyName } from "../src/strategies/index.ts";
import { countTokens } from "../src/tokens.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const conv = loadConversations(join(root, "data", "conversations")).find((c) => c.id === "support")!;
const probes = loadProbes(join(root, "data", "probes.json")).filter((p) => p.conversation === "support");
const budget = Number(process.env.BUDGET ?? 2048);
const name = (process.env.STRATEGY ?? "structured-memory") as StrategyName;
const turnsToRun = 44;

console.log(`demo: ${name} on "${conv.title}", first ${turnsToRun} turns, budget ${budget} tokens (offline fallbacks)\n`);
const factory = strategyFactories()[name];
if (!factory) throw new Error(`unknown strategy ${name}`);
const manager = new ConversationManager({ system: conv.system, pinned: conv.pinned, budget, strategy: factory(), tokens: countTokens });

for (const turn of conv.turns.slice(0, turnsToRun)) await manager.addTurn(turn.role, turn.text);
const totalTokens = conv.turns.slice(0, turnsToRun).reduce((n, t) => n + countTokens(t.text), 0);
console.log(`history: ${turnsToRun} turns, ${totalTokens} tokens of text, against a ${budget} token window\n`);

console.log("log:");
for (const e of manager.log.filter((e) => e.type !== "history_dropped")) console.log(`  turn ${e.turn ?? "-"}: ${e.type}  ${e.detail ?? ""}`);

const asked = [
  probes.find((p) => p.id === "supp-01")!,
  probes.find((p) => p.id === "supp-02")!,
  probes.find((p) => p.id === "supp-20")!,
];
for (const probe of asked) {
  const prompt = await manager.prompt(probe.question);
  const answer = await scriptedAnswerer(probe, prompt);
  console.log(`\nprobe ${probe.id} (${probe.kind}): ${probe.question}`);
  console.log(`  allocation: ${JSON.stringify(prompt.allocation)}`);
  console.log(`  sections: ${prompt.sections.map((s) => `${s.name}=${s.tokens}`).join(" ")}  total=${prompt.tokens} (limit ${prompt.budget - prompt.allocation.output})`);
  console.log(`  answer: ${answer.text}   expected: ${probe.answer}`);
}

const last = await manager.prompt(asked[1]!.question);
console.log("\nassembled system section for the last probe:\n");
console.log(last.system.split("\n").map((l) => `  | ${l}`).join("\n"));
console.log(`\nrecent turns kept in messages: ${last.messages.length - 1} (of ${turnsToRun}), plus the query`);
