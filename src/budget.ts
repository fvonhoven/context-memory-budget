// Budget allocator: splits one fixed token window into sections.
//
//   total = output reserve + system + memory + retrieved + recent
//
// The output reserve is taken first so the model always has room to answer.
// The system section gets what it needs up to a cap. What is left is split
// by the strategy's shares; a strategy that has no memory block asks for a
// zero share and everything goes to recent turns. Unused room inside a block
// section is handed to recent at assembly time (see manager.ts), so the
// allocation here is a set of caps, not a set of exact sizes.
import type { Allocation, Shares } from "./types.ts";

export const OUTPUT_RESERVE = { fraction: 1 / 8, min: 256, max: 1024 } as const;
export const SYSTEM_CAP_FRACTION = 0.3;

export function allocate(total: number, systemTokens: number, shares: Shares): Allocation {
  if (!Number.isFinite(total) || total < 512) throw new Error(`budget must be at least 512 tokens, got ${total}`);
  if (shares.memory < 0 || shares.retrieved < 0 || shares.memory + shares.retrieved > 0.8) {
    throw new Error(`shares must be non-negative and sum to at most 0.8, got ${JSON.stringify(shares)}`);
  }
  const output = Math.min(OUTPUT_RESERVE.max, Math.max(OUTPUT_RESERVE.min, Math.floor(total * OUTPUT_RESERVE.fraction)));
  const afterOutput = total - output;
  const system = Math.min(systemTokens, Math.floor(afterOutput * SYSTEM_CAP_FRACTION));
  const remainder = afterOutput - system;
  const memory = Math.floor(remainder * shares.memory);
  const retrieved = Math.floor(remainder * shares.retrieved);
  const recent = remainder - memory - retrieved;
  return { total, output, system, memory, retrieved, recent };
}

export function allocationSum(a: Allocation): number {
  return a.output + a.system + a.memory + a.retrieved + a.recent;
}
