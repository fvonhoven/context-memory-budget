// Runs one conversation through one strategy at one budget and scores the
// probes. Cost is modeled as one model call per user turn (input = the
// assembled prompt, output = the assistant turn that actually followed in the
// fixture) plus whatever the strategy spent on compaction calls.
import { grade } from "./answerer.ts";
import type { Answerer } from "./answerer.ts";
import { ConversationManager } from "./manager.ts";
import { costUsd } from "./pricing.ts";
import { countTokens } from "./tokens.ts";
import type { Conversation, LogEvent, Probe, StrategyFactory, Tokenizer } from "./types.ts";

export type ProbeResult = { probe: Probe; answer: string; correct: boolean; falseRecall: boolean; promptTokens: number };

export type RunResult = {
  conversation: string;
  strategy: string;
  budget: number;
  probes: ProbeResult[];
  userTurns: number;
  promptTokens: number[];
  costUsd: number;
  // Every token a live run of this conversation would send and receive:
  // per-turn prompts and replies, compaction calls, and probe answers.
  inputTokens: number;
  outputTokens: number;
  compactionCalls: number;
  compactionInputTokens: number;
  compactionOutputTokens: number;
  log: LogEvent[];
};

// Output allowance for one probe answer in the cost model.
const PROBE_ANSWER_TOKENS = 30;

export type RunOptions = {
  strategy: StrategyFactory;
  budget: number;
  answerer: Answerer;
  model: string;
  tokens?: Tokenizer;
};

export async function runConversation(conv: Conversation, probes: Probe[], opts: RunOptions): Promise<RunResult> {
  const tokens = opts.tokens ?? countTokens;
  const manager = new ConversationManager({ system: conv.system, pinned: conv.pinned, budget: opts.budget, strategy: opts.strategy(), tokens });
  const byTurn = new Map<number, Probe[]>();
  for (const p of probes.filter((p) => p.conversation === conv.id)) byTurn.set(p.atTurn, [...(byTurn.get(p.atTurn) ?? []), p]);

  const promptTokens: number[] = [];
  const results: ProbeResult[] = [];
  let cost = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (let i = 0; i < conv.turns.length; i++) {
    const turn = conv.turns[i]!;
    if (turn.role === "user") {
      const prompt = await manager.prompt(turn.text);
      promptTokens.push(prompt.tokens);
      const reply = conv.turns[i + 1];
      const replyTokens = reply && reply.role === "assistant" ? tokens(reply.text) : 0;
      cost += costUsd(opts.model, prompt.tokens, replyTokens);
      inputTokens += prompt.tokens;
      outputTokens += replyTokens;
    }
    await manager.addTurn(turn.role, turn.text);
    for (const probe of byTurn.get(turn.index) ?? []) {
      const prompt = await manager.prompt(probe.question);
      const answer = await opts.answerer(probe, prompt);
      const g = grade(probe, answer.text);
      inputTokens += prompt.tokens;
      outputTokens += PROBE_ANSWER_TOKENS;
      results.push({ probe, answer: answer.text, correct: g.correct, falseRecall: g.falseRecall, promptTokens: prompt.tokens });
    }
  }
  const stats = manager.strategy.stats();
  cost += costUsd(opts.model, stats.compactionInputTokens, stats.compactionOutputTokens);
  inputTokens += stats.compactionInputTokens;
  outputTokens += stats.compactionOutputTokens;
  return {
    conversation: conv.id,
    strategy: manager.strategy.name,
    budget: opts.budget,
    probes: results,
    userTurns: promptTokens.length,
    promptTokens,
    costUsd: cost,
    inputTokens,
    outputTokens,
    compactionCalls: stats.compactionCalls,
    compactionInputTokens: stats.compactionInputTokens,
    compactionOutputTokens: stats.compactionOutputTokens,
    log: manager.log,
  };
}

export type Summary = {
  strategy: string;
  budget: number;
  probeAccuracy: number;
  changedAccuracy: number;
  falseRecallRate: number;
  avgPromptTokens: number;
  costUsd: number;
  compactionCalls: number;
  counts: { probes: number; changed: number; distractors: number; userTurns: number };
};

// Aggregates several conversation runs of the same strategy and budget.
export function summarize(runs: RunResult[]): Summary {
  const all = runs.flatMap((r) => r.probes);
  const factual = all.filter((p) => p.probe.kind !== "distractor");
  const changed = all.filter((p) => p.probe.kind === "changed");
  const distractors = all.filter((p) => p.probe.kind === "distractor");
  const promptTokens = runs.flatMap((r) => r.promptTokens);
  const ratio = (xs: ProbeResult[], f: (p: ProbeResult) => boolean) => (xs.length === 0 ? 0 : xs.filter(f).length / xs.length);
  return {
    strategy: runs[0]?.strategy ?? "",
    budget: runs[0]?.budget ?? 0,
    probeAccuracy: ratio(factual, (p) => p.correct),
    changedAccuracy: ratio(changed, (p) => p.correct),
    falseRecallRate: ratio(distractors, (p) => p.falseRecall),
    avgPromptTokens: promptTokens.length === 0 ? 0 : promptTokens.reduce((a, b) => a + b, 0) / promptTokens.length,
    costUsd: runs.reduce((n, r) => n + r.costUsd, 0),
    compactionCalls: runs.reduce((n, r) => n + r.compactionCalls, 0),
    counts: { probes: factual.length, changed: changed.length, distractors: distractors.length, userTurns: promptTokens.length },
  };
}
