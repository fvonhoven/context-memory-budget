// Replay client: serves recorded responses keyed by a hash of the request.
// A live run wraps the real client in recordingClient and writes the entries
// to data/replay/, so the next offline run replays the exact same responses.
import { createHash } from "node:crypto";
import type { ChatClient, ChatRequest, ChatResponse } from "./types.ts";

export type ReplayEntry = {
  requestHash: string;
  response?: { text: string; inputTokens: number; outputTokens: number; stopReason: string };
  error?: string;
};

export type ReplayFile = { recordedAt: string; note: string; entries: ReplayEntry[] };

export function hashRequest(req: ChatRequest): string {
  const canonical = JSON.stringify({ m: req.model, s: req.system ?? "", msgs: req.messages, t: req.maxTokens ?? null });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

// The same request can recur (identical prompts). Entries are served in
// recorded order per hash; when a queue is exhausted the last entry repeats.
export function replayClient(file: ReplayFile): ChatClient {
  const queues = new Map<string, ReplayEntry[]>();
  for (const e of file.entries) {
    const q = queues.get(e.requestHash) ?? [];
    q.push(e);
    queues.set(e.requestHash, q);
  }
  return async (req: ChatRequest): Promise<ChatResponse> => {
    const key = hashRequest(req);
    const q = queues.get(key);
    if (!q || q.length === 0) throw new Error(`replay: no recording for request ${key} (model ${req.model})`);
    const entry = q.length > 1 ? (q.shift() as ReplayEntry) : q[0]!;
    if (entry.error !== undefined) throw new Error(entry.error);
    const r = entry.response!;
    return {
      text: r.text,
      toolCalls: [],
      usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens },
      latencyMs: 0,
      model: req.model,
      stopReason: r.stopReason,
    };
  };
}

// Wraps a live client so every call (and every failure) is captured.
export function recordingClient(inner: ChatClient, entries: ReplayEntry[]): ChatClient {
  return async (req) => {
    const requestHash = hashRequest(req);
    try {
      const res = await inner(req);
      entries.push({
        requestHash,
        response: {
          text: res.text,
          inputTokens: res.usage.inputTokens,
          outputTokens: res.usage.outputTokens,
          stopReason: res.stopReason,
        },
      });
      return res;
    } catch (err) {
      entries.push({ requestHash, error: String(err) });
      throw err;
    }
  };
}
