import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashRequest, recordingClient, replayClient } from "./replay.ts";
import type { ChatClient, ChatRequest } from "./types.ts";

const req: ChatRequest = { model: "m", system: "s", messages: [{ role: "user", content: "hi" }] };

describe("replay provider", () => {
  it("records a live call and replays it by request hash", async () => {
    const entries: Parameters<typeof recordingClient>[1] = [];
    const live: ChatClient = async () => ({ text: "hello", toolCalls: [], usage: { inputTokens: 3, outputTokens: 1 }, latencyMs: 9, model: "m", stopReason: "end_turn" });
    await recordingClient(live, entries)(req);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.requestHash, hashRequest(req));
    const replay = replayClient({ recordedAt: "", note: "", entries });
    const res = await replay(req);
    assert.equal(res.text, "hello");
    assert.equal(res.usage.inputTokens, 3);
  });

  it("throws on a request that was never recorded and re-throws recorded errors", async () => {
    const replay = replayClient({ recordedAt: "", note: "", entries: [{ requestHash: hashRequest(req), error: "boom" }] });
    await assert.rejects(replay(req), /boom/);
    await assert.rejects(replay({ ...req, model: "other" }), /no recording/);
  });
});
