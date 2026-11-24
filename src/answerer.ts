// Answerers and grading for probes.
//
// The scripted answerer is not a model. It answers a probe correctly if and
// only if the needed fact is present in the assembled context, so the probe
// score measures the memory strategy and nothing else. If the stale value of
// a changed fact appears after the current one in the context, it answers
// with the stale value, the way a model reading top to bottom tends to.
import { normalizeMessages } from "./manager.ts";
import type { ChatClient } from "./providers/types.ts";
import type { AssembledPrompt, Probe } from "./types.ts";

export const NOT_STATED = "not stated";

export type Answer = { text: string; inputTokens: number; outputTokens: number };
export type Answerer = (probe: Probe, prompt: AssembledPrompt) => Promise<Answer>;

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ");
}

function lastIndexOfAny(haystack: string, needles: string[] | undefined): number {
  let best = -1;
  for (const n of needles ?? []) best = Math.max(best, haystack.lastIndexOf(norm(n)));
  return best;
}

export const scriptedAnswerer: Answerer = async (probe, prompt) => {
  const ctx = norm(prompt.contextText);
  if (probe.kind === "distractor") {
    const trapAt = lastIndexOfAny(ctx, probe.trap);
    const trap = probe.trap?.find((t) => ctx.lastIndexOf(norm(t)) === trapAt);
    return { text: trapAt >= 0 && trap ? trap : NOT_STATED, inputTokens: 0, outputTokens: 0 };
  }
  const at = lastIndexOfAny(ctx, probe.evidence);
  if (at < 0) return { text: NOT_STATED, inputTokens: 0, outputTokens: 0 };
  const staleAt = lastIndexOfAny(ctx, probe.staleEvidence);
  if (staleAt > at) return { text: probe.staleEvidence![0]!, inputTokens: 0, outputTokens: 0 };
  return { text: probe.answer, inputTokens: 0, outputTokens: 0 };
};

export function llmAnswerer(client: ChatClient, model: string): Answerer {
  return async (probe, prompt) => {
    const messages = normalizeMessages(prompt.messages);
    const last = messages[messages.length - 1]!;
    last.content += `\n\nAnswer in one short line using only the conversation above. If the answer was never stated, reply exactly "${NOT_STATED}".`;
    const res = await client({ model, system: prompt.system, messages, maxTokens: 100, temperature: 0 });
    void probe;
    return { text: res.text.trim(), inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens };
  };
}

export type Grade = { correct: boolean; falseRecall: boolean };

export function grade(probe: Probe, answer: string): Grade {
  const a = norm(answer);
  if (probe.kind === "distractor") {
    const admitted = a.includes(NOT_STATED);
    return { correct: admitted, falseRecall: !admitted };
  }
  const hasEvidence = probe.evidence.some((e) => a.includes(norm(e))) || a.includes(norm(probe.answer));
  const hasStale = (probe.staleEvidence ?? []).some((e) => a.includes(norm(e)));
  return { correct: hasEvidence && !hasStale, falseRecall: false };
}
