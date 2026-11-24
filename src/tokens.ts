// Token counting without a tokenizer.
//
// The approximation: English prose tokenizes at roughly 4 characters per
// token. Code, JSON and URLs tokenize worse because punctuation and symbols
// tend to become their own tokens, and runs of whitespace (indentation) cost
// tokens too. So:
//
//   letters and digits      1 token per 4 characters
//   symbols and punctuation 1 token per 2 characters
//   whitespace              free inside prose (a single space rides along
//                           with the next word) but 1 token per 4 characters
//                           for runs of two or more (indentation, blank lines)
//
// Measured against real tokenizers this lands within about 10 to 15 percent
// on prose and within about 20 percent on code, which is good enough for
// budgeting as long as the reserve for output absorbs the error. To use a
// real tokenizer, pass any (text) => number as the Tokenizer wherever this
// module's countTokens is accepted (ConversationManager, allocate, fitText).
import type { Tokenizer } from "./types.ts";

// Fixed overhead per chat message for role framing tokens.
export const MESSAGE_OVERHEAD = 4;

export const countTokens: Tokenizer = (text: string): number => {
  if (text.length === 0) return 0;
  let alnum = 0;
  let symbols = 0;
  let wsRun = 0;
  let wsRunChars = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const isWs = c === 32 || c === 10 || c === 9 || c === 13;
    if (isWs) {
      wsRun++;
      continue;
    }
    if (wsRun >= 2) wsRunChars += wsRun;
    wsRun = 0;
    const isAlnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c > 127;
    if (isAlnum) alnum++;
    else symbols++;
  }
  if (wsRun >= 2) wsRunChars += wsRun;
  return Math.ceil(alnum / 4 + symbols / 2 + wsRunChars / 4);
};

// Cut text so it fits in maxTokens, keeping the head and the tail with a
// marker in between. Returns the text unchanged if it already fits.
export function fitText(text: string, maxTokens: number, tokens: Tokenizer): string {
  if (maxTokens <= 0) return "";
  if (tokens(text) <= maxTokens) return text;
  const marker = (n: number) => `\n[... ${n} characters cut to fit the budget ...]\n`;
  let lo = 0;
  let hi = text.length;
  let best = "";
  while (lo < hi) {
    const keep = Math.floor((lo + hi + 1) / 2);
    const head = Math.ceil(keep * 0.6);
    const tail = keep - head;
    const candidate = text.slice(0, head) + marker(text.length - keep) + (tail > 0 ? text.slice(text.length - tail) : "");
    if (tokens(candidate) <= maxTokens) {
      best = candidate;
      lo = keep;
    } else {
      hi = keep - 1;
    }
  }
  return best;
}
