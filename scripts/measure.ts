// Runs every strategy over every fixture conversation at each budget and
// prints the numbers. Offline (no key): extractive summarizer, rule-based
// extractor, scripted answerer, or a replay file if one was recorded. Live
// (ANTHROPIC_API_KEY set): the model summarizes, extracts and answers, and
// the calls are recorded to data/replay/measure.json for later replay.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { llmAnswerer, scriptedAnswerer } from "../src/answerer.ts";
import type { Answerer } from "../src/answerer.ts";
import { loadConversations, loadProbes, validateProbes } from "../src/data.ts";
import { runConversation, summarize } from "../src/evaluate.ts";
import type { RunResult, Summary } from "../src/evaluate.ts";
import { PRICES, costUsd } from "../src/pricing.ts";
import { anthropicClient } from "../src/providers/anthropic.ts";
import { recordingClient, replayClient } from "../src/providers/replay.ts";
import type { ReplayEntry, ReplayFile } from "../src/providers/replay.ts";
import type { ChatClient } from "../src/providers/types.ts";
import { STRATEGY_NAMES, strategyFactories } from "../src/strategies/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const replayPath = join(root, "data", "replay", "measure.json");
const model = process.env.MEASURE_MODEL ?? "claude-sonnet-4-5";
const budgets = (process.env.BUDGETS ?? "4096,16384").split(",").map((b) => Number(b.trim()));
if (!PRICES[model]) throw new Error(`no price for ${model} in src/pricing.ts`);

const conversations = loadConversations(join(root, "data", "conversations"));
const probes = loadProbes(join(root, "data", "probes.json"));
const errors = validateProbes(conversations, probes);
if (errors.length > 0) {
  console.error("probe fixture problems:\n" + errors.join("\n"));
  process.exit(1);
}

type Mode = "live" | "replay" | "offline";
let mode: Mode = "offline";
let client: ChatClient | undefined;
const recorded: ReplayEntry[] = [];
const apiKey = process.env.ANTHROPIC_API_KEY;
if (apiKey) {
  mode = "live";
  client = recordingClient(anthropicClient(apiKey), recorded);
} else if (existsSync(replayPath)) {
  const file = JSON.parse(readFileSync(replayPath, "utf8")) as ReplayFile;
  if (file.entries.length > 0) {
    mode = "replay";
    client = replayClient(file);
  }
}
// Counts the model calls this run actually made (live) or replayed, with the
// token usage the API reported for them.
const apiUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
if (client) {
  const inner = client;
  client = async (req) => {
    const res = await inner(req);
    apiUsage.calls++;
    apiUsage.inputTokens += res.usage.inputTokens;
    apiUsage.outputTokens += res.usage.outputTokens;
    return res;
  };
}
const answerer: Answerer = client ? llmAnswerer(client, model) : scriptedAnswerer;
const factories = strategyFactories(client ? { client, model } : {});

console.log(`mode: ${mode}${mode === "offline" ? " (extractive summarizer, rule-based extractor, scripted answerer)" : ""}`);
console.log(`model for pricing: ${model}  budgets: ${budgets.join(", ")}  date: ${new Date().toISOString().slice(0, 10)}`);
console.log(
  `conversations: ${conversations.map((c) => `${c.id} (${c.turns.length} turns)`).join(", ")}; probes: ${probes.length} ` +
    `(${probes.filter((p) => p.kind === "stable").length} stable, ${probes.filter((p) => p.kind === "changed").length} changed, ${probes.filter((p) => p.kind === "distractor").length} distractor)`,
);

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const pad = (s: string, n: number) => s.padEnd(n);
const rpad = (s: string, n: number) => s.padStart(n);

const allRuns: RunResult[] = [];
const summaries: Summary[] = [];
for (const budget of budgets) {
  console.log(`\n== budget ${budget} tokens ==`);
  console.log(
    pad("strategy", 19) + rpad("probe acc", 10) + rpad("changed", 9) + rpad("false recall", 13) + rpad("avg prompt tok", 15) + rpad("cost USD", 10) + rpad("compactions", 12),
  );
  for (const name of STRATEGY_NAMES) {
    const runs: RunResult[] = [];
    for (const conv of conversations) {
      runs.push(await runConversation(conv, probes, { strategy: factories[name], budget, answerer, model }));
    }
    allRuns.push(...runs);
    const s = summarize(runs);
    summaries.push(s);
    console.log(
      pad(s.strategy, 19) +
        rpad(pct(s.probeAccuracy), 10) +
        rpad(pct(s.changedAccuracy), 9) +
        rpad(pct(s.falseRecallRate), 13) +
        rpad(s.avgPromptTokens.toFixed(0), 15) +
        rpad(s.costUsd.toFixed(4), 10) +
        rpad(String(s.compactionCalls), 12),
    );
  }
}

const first = summaries[0]!;
console.log(
  `\nprobe acc: ${first.counts.probes} factual probes (stable + changed). changed: the ${first.counts.changed} probes whose answer was updated mid-conversation. ` +
    `false recall: share of ${first.counts.distractors} distractor probes answered with something other than "not stated". ` +
    `avg prompt tok: mean assembled prompt size over ${first.counts.userTurns} user turns. cost: ${model} list price, prompt + reply per user turn plus compaction calls.`,
);

// Where each strategy lost probes, by conversation, at the smallest budget.
console.log(`\nmissed probes at budget ${budgets[0]}:`);
for (const name of STRATEGY_NAMES) {
  const missed = allRuns
    .filter((r) => r.strategy === name && r.budget === budgets[0])
    .flatMap((r) => r.probes.filter((p) => !p.correct).map((p) => `${p.probe.id}${p.probe.kind === "changed" ? "*" : ""}`));
  console.log(`  ${pad(name, 19)} ${missed.length === 0 ? "none" : missed.join(" ")}`);
}
console.log("  (* = changed-fact probe answered with the stale value or nothing)");

const totalIn = allRuns.reduce((n, r) => n + r.inputTokens, 0);
const totalOut = allRuns.reduce((n, r) => n + r.outputTokens, 0);
if (mode !== "offline") {
  console.log(
    `\nmodel calls ${mode === "live" ? "made" : "replayed"}: ${apiUsage.calls} (probe answers and compactions), ` +
      `${apiUsage.inputTokens} input and ${apiUsage.outputTokens} output tokens as reported by the API; ` +
      `at ${model} list price that is $${costUsd(model, apiUsage.inputTokens, apiUsage.outputTokens).toFixed(2)}.`,
  );
}
console.log(
  `${mode === "offline" ? "\n" : ""}carrying every conversation turn by turn with a model reply each turn would send about ${totalIn} input tokens ` +
    `and receive about ${totalOut} output tokens (${allRuns.length} conversation runs, approximate counter); at ${model} list price that is $${costUsd(model, totalIn, totalOut).toFixed(2)}.`,
);

mkdirSync(join(root, "runs"), { recursive: true });
const outPath = join(root, "runs", `measure-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(outPath, JSON.stringify({ mode, model, budgets, summaries, runs: allRuns.map((r) => ({ ...r, log: r.log.length })) }, null, 2));
console.log(`\nwrote runs/${outPath.split("/").pop()}`);

if (mode === "live") {
  mkdirSync(dirname(replayPath), { recursive: true });
  const file: ReplayFile = { recordedAt: new Date().toISOString(), note: `live run with ${model}`, entries: recorded };
  writeFileSync(replayPath, JSON.stringify(file, null, 2));
  console.log(`recorded ${recorded.length} model calls to data/replay/measure.json`);
}
