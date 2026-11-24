// Loads the fixture conversations and probes and checks they agree with each
// other: every probe's evidence must appear in the turns it cites, and every
// distractor's traps must appear nowhere in its conversation.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Conversation, Probe, Role } from "./types.ts";

type ConversationFile = { id: string; title: string; system: string; pinned: string[]; turns: { role: Role; text: string }[] };

export function loadConversations(dir: string): Conversation[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as ConversationFile;
      return { ...raw, turns: raw.turns.map((t, i) => ({ index: i + 1, role: t.role, text: t.text })) };
    });
}

export function loadProbes(path: string): Probe[] {
  return JSON.parse(readFileSync(path, "utf8")) as Probe[];
}

export function validateProbes(conversations: Conversation[], probes: Probe[]): string[] {
  const errors: string[] = [];
  const byId = new Map(conversations.map((c) => [c.id, c]));
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
  for (const p of probes) {
    const conv = byId.get(p.conversation);
    if (!conv) {
      errors.push(`${p.id}: unknown conversation ${p.conversation}`);
      continue;
    }
    if (p.atTurn < 1 || p.atTurn > conv.turns.length) errors.push(`${p.id}: atTurn ${p.atTurn} outside 1..${conv.turns.length}`);
    const whole = norm(`${conv.pinned.join("\n")}\n${conv.turns.map((t) => t.text).join("\n")}`);
    if (p.kind === "distractor") {
      for (const t of p.trap ?? []) if (whole.includes(norm(t))) errors.push(`${p.id}: trap "${t}" appears in the conversation`);
      continue;
    }
    for (const idx of p.sourceTurns) {
      const turn = conv.turns[idx - 1];
      if (!turn) {
        errors.push(`${p.id}: source turn ${idx} missing`);
        continue;
      }
      if (idx > p.atTurn) errors.push(`${p.id}: source turn ${idx} is after atTurn ${p.atTurn}`);
    }
    const cited = norm(p.sourceTurns.map((i) => conv.turns[i - 1]?.text ?? "").join("\n") + "\n" + conv.pinned.join("\n"));
    if (!p.evidence.some((e) => cited.includes(norm(e)))) errors.push(`${p.id}: no evidence found in source turns ${p.sourceTurns.join(",")}`);
    if (p.kind === "changed" && !(p.staleEvidence && p.staleEvidence.length > 0)) errors.push(`${p.id}: changed probe needs staleEvidence`);
  }
  return errors;
}
