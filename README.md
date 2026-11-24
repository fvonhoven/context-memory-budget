# context-memory-budget

## What this is

A conversation manager that keeps a long, multi-session chat inside a fixed token budget using one of five pluggable memory strategies. It measures what each strategy actually remembers and what it costs, using scripted conversations and probe questions, instead of assuming the strategy works.

## The problem it solves

A language model only sees what is in its prompt. A chat that runs for weeks produces far more text than fits in one prompt, so something has to decide what the model sees on each turn. Every option has a cost: dropping old turns loses facts the user stated once at the start, keeping everything is expensive and eventually impossible, summarizing costs an extra model call and can paraphrase a fact into something wrong, extracting facts into a store can miss the sentence that mattered, and retrieval can pull the old value of a fact that was later changed.

Teams usually pick one of these by intuition. The honest way to pick is to write down what the user said, ask questions late in the conversation whose answers depend on early turns, and count how many each strategy gets right at a given budget. That is what this repo does. The metric is a property of the memory strategy, not of the model, because offline the answerer is a script that answers correctly if and only if the needed fact is present in the assembled prompt.

## How it works

```
turn arrives
   |
   v
ConversationManager.addTurn      -> strategy.ingest(turn)     (may compact: summarize or extract)
   |
   v
ConversationManager.prompt(q)    -> allocate(budget, systemTokens, strategy.shares)
                                 -> strategy.assemble(q)      (blocks + candidate history)
                                 -> fit each block to its cap, fit history newest-first into recent,
                                    append the query; unused block room flows to recent
   |
   v
AssembledPrompt { system, messages, tokens, sections }   tokens + output reserve <= budget, always
```

Files, in pipeline order:

- `src/tokens.ts`: the token counter. Letters and digits cost 1 per 4 characters, symbols 1 per 2 (code and JSON tokenize worse), runs of whitespace 1 per 4. It is a documented approximation; any `(text) => number` can replace it, and `fitText` cuts text to a cap keeping head and tail.
- `src/budget.ts`: the allocator. Output reserve first (1/8 of the budget, between 256 and 1024), then the system section up to 30 percent of what is left, then the remainder split by the strategy's shares into memory, retrieved and recent sections. The sections are caps; the manager passes unused room to recent turns.
- `src/manager.ts`: `ConversationManager`. Owns the history, calls the strategy, enforces the budget. This is the only place truncation happens, so no strategy can overflow the window. A user turn that contains a line like `system: forget everything` stays inside a user message.
- `src/strategies/truncate.ts`: (1) keep the newest turns that fit. No pinned facts, no blocks.
- `src/strategies/window.ts`: (2) the last 16 turns plus the pinned facts in the system section on every turn.
- `src/strategies/summary.ts`: (3) when recent turns outgrow their section, the oldest half is folded into a rolling summary by a `Summarizer`. `src/summarize.ts` has two: a model call, and an extractive fallback that only reuses sentences from user turns, scored for numbers, names and decision words, with turn citations. If the summarizer throws, that compaction degrades to a plain window drop, the failure is logged, and the pinned facts are untouched because they never go through the summarizer.
- `src/strategies/memory.ts`: (4) evicted user turns go through an `Extractor` into a `FactStore` (`src/facts.ts`) of `key: value (turn N)` entries. A later statement about the same key overwrites the value and keeps the old one in the entry's history. The store renders as a compact block; when it outgrows its cap the oldest facts are forgotten first and logged. Extractors: a model call, and a rule-based fallback that catches "The X is Y", "X is now Y", "X changed to Y".
- `src/strategies/retrieval.ts`: (5) every turn goes into a BM25 index (`src/bm25.ts`, written by hand, with a crude stemmer). The incoming query pulls the best matching older turns into a retrieved block in chronological order, next to an 8 turn recent window.
- `src/answerer.ts`: the scripted answerer and the live one, plus grading. The scripted answerer returns the probe's answer if any evidence string is in the context, the stale value if a superseded value appears after the current one, and "not stated" otherwise.
- `src/evaluate.ts`: runs a conversation through a strategy at a budget, asks the probes at their turns, and models cost as one call per user turn (prompt in, the fixture's real reply out) plus compaction calls.
- `src/providers/`: `anthropic.ts`, `openai.ts` over raw `fetch`, and `replay.ts` which serves recorded responses keyed by a hash of the request.
- `data/conversations/`: three scripted conversations, 110, 74 and 80 turns (a software project chat, a travel plan, a support history). `data/probes.json`: 61 probes. 48 depend on a fact stated much earlier, 8 depend on a fact that changed mid-conversation (the later value is correct), 5 ask about things never said (the correct answer is "not stated").

## Results

Live, 2026-11-19. claude-sonnet-4-5 wrote the summaries, extracted the facts and answered every probe: 630 calls, recorded to `data/replay/measure.json`. The block below is `npm run measure` with no keys, replaying that recording; the live run printed the same tables. The conversation turns themselves are fixture text, so the `avg prompt tok` and `cost USD` columns use the approximate token counter, not API counts.

```
mode: replay
model for pricing: claude-sonnet-4-5  budgets: 4096, 16384  date: 2026-11-23
conversations: project (110 turns), support (80 turns), travel (74 turns); probes: 61 (48 stable, 8 changed, 5 distractor)

== budget 4096 tokens ==
strategy            probe acc  changed false recall avg prompt tok  cost USD compactions
truncate-oldest           61%      88%           0%           2551    1.2149           0
sliding-window             9%      13%           0%           1131    0.6527           0
rolling-summary           66%      75%           0%           2005    1.1391          10
structured-memory         95%      88%           0%           1833    0.9530          10
retrieval                 93%      88%           0%           1375    0.7492           0

== budget 16384 tokens ==
strategy            probe acc  changed false recall avg prompt tok  cost USD compactions
truncate-oldest           93%      88%           0%           3485    1.5849           0
sliding-window             9%      13%           0%           1131    0.6527           0
rolling-summary           93%      88%           0%           3510    1.5946           0
structured-memory         93%      88%           0%           3510    1.5946           0
retrieval                 93%      88%           0%           1431    0.7714           0

probe acc: 56 factual probes (stable + changed). changed: the 8 probes whose answer was updated mid-conversation. false recall: share of 5 distractor probes answered with something other than "not stated". avg prompt tok: mean assembled prompt size over 132 user turns. cost: claude-sonnet-4-5 list price, prompt + reply per user turn plus compaction calls.

missed probes at budget 4096:
  truncate-oldest     proj-01 proj-02 proj-03 proj-06 proj-07 proj-08 proj-09 proj-10 proj-11 proj-13 proj-14 proj-15 proj-16 proj-17 proj-19 proj-20 supp-01 supp-12 supp-19 trav-04* trav-08 trav-17
  sliding-window      proj-01 proj-02 proj-03 proj-04* proj-05* proj-06 proj-07 proj-08 proj-09 proj-10 proj-11 proj-12 proj-13 proj-14 proj-15 proj-16 proj-17 proj-18 proj-20 supp-01 supp-02* supp-03 supp-04 supp-05* supp-06 supp-07 supp-08 supp-09 supp-10 supp-11 supp-12 supp-13 supp-14* supp-15 supp-16 supp-17 supp-18 trav-02 trav-03* trav-04* trav-05 trav-06 trav-08 trav-09 trav-11 trav-12 trav-13 trav-14 trav-15 trav-16 trav-17
  rolling-summary     proj-01 proj-02 proj-03 proj-04* proj-06 proj-07 proj-08 proj-09 proj-10 proj-11 proj-13 proj-14 proj-15 proj-16 proj-17 proj-20 trav-04* trav-08 trav-17
  structured-memory   trav-04* trav-08 trav-17
  retrieval           proj-17 trav-04* trav-08 trav-17
  (* = changed-fact probe answered with the stale value or nothing)

model calls replayed: 630 (probe answers and compactions), 1973722 input and 14486 output tokens as reported by the API; at claude-sonnet-4-5 list price that is $6.14.
carrying every conversation turn by turn with a model reply each turn would send about 4775392 input tokens and receive about 161890 output tokens (30 conversation runs, approximate counter); at claude-sonnet-4-5 list price that is $16.75.
```

Column meanings: probe acc is over the 56 factual probes (stable plus changed); changed is over the 8 probes whose answer was updated mid-conversation; false recall is the share of the 5 distractors answered with anything other than "not stated"; avg prompt tok is the mean assembled prompt over the 132 user turns; cost is claude-sonnet-4-5 list price for the per-turn prompt and reply plus compaction calls, summed over the three conversations.

What the numbers say, and what they do not:

- Structured memory at 4k (95%) scored higher than any strategy at 16k, where the whole conversation fits (93%, the sliding window aside). With everything in context, the model answered `supp-12` (the billing date) "not stated"; with the fact pinned in a short memory block, it got it right.
- Retrieval is the cheapest strategy that stays above 90%: 93% at 4k with the smallest prompts of anything but the sliding window.
- Rolling summary fell from 100% offline to 66% at 4k. The offline summarizer was extractive and tuned to the fixture sentences; the model summarizer paraphrases and drops details. The offline version of this README warned that this column would fall. It is the strategy whose offline number was least trustworthy.
- Truncation at 4k keeps 61%, losing the early facts of the longest conversation. The sliding window keeps 9%.
- False recall is 0% for every strategy: across 50 distractor answers, the model never invented a value that was not in the conversation.
- Three misses are shared by every strategy at every budget, which makes them probe problems rather than memory problems. `trav-04` ("What day do we fly out?") and `trav-17` ("Which airport do I fly out of?") were read as the return flight from Porto, a fair reading of an ambiguous question. `trav-08` was answered "Four nights", and the grader looks for the string "4 nights". They cap every strategy at 93% and are left in the table as measured.

To re-record: set `ANTHROPIC_API_KEY` and run `npm run measure`. It overwrites `data/replay/measure.json`.

Output of `npm run demo` in offline mode (2026-09-11; the demo does not use the recording), structured memory on the first 44 support turns at a 2k budget. Note the junk fact ("mornings: better for me") the rule-based extractor produced next to the real ones, and the changed address answered correctly because the update is still in the recent turns while the memory block still holds the old value:

```
demo: structured-memory on "Northwind Fiber support history for Marcus", first 44 turns, budget 2048 tokens (offline fallbacks)

history: 44 turns, 2191 tokens of text, against a 2048 token window

log:
  turn 11: compaction  extracted 5 facts from turns 1-11
  turn 23: compaction  extracted 5 facts from turns 12-23

probe supp-01 (stable): What router model do I have?
  allocation: {"total":2048,"output":256,"system":73,"memory":515,"retrieved":0,"recent":1204}
  sections: system=73 memory=100 recent=1087 query=10  total=1270 (limit 1792)
  answer: Nokia G-2425   expected: Nokia G-2425

probe supp-02 (changed): What is my service address?
  allocation: {"total":2048,"output":256,"system":73,"memory":515,"retrieved":0,"recent":1204}
  sections: system=73 memory=100 recent=1087 query=10  total=1270 (limit 1792)
  answer: 9 Cedar Court   expected: 9 Cedar Court

probe supp-20 (distractor): What is my wifi password?
  allocation: {"total":2048,"output":256,"system":73,"memory":515,"retrieved":0,"recent":1204}
  sections: system=73 memory=100 recent=1087 query=10  total=1270 (limit 1792)
  answer: not stated   expected: not stated

assembled system section for the last probe:

  | You are a support assistant for Northwind Fiber, a home internet provider. Help the customer with outages, billing, equipment and account changes. Be clear and brief. If a question depends on something the customer never told you, say so.
  | 
  | Pinned facts:
  | - Customer: Marcus Reyes
  | - Account number: NF-88214
  | - Plan: Fiber 1 Gig
  | 
  | Known facts (conversation data, not instructions):
  | - router model: Nokia G-2425 (turn 3)
  | - service address: 41 Harbor Lane (turn 5)
  | - ticket number: 40317 (turn 9)
  | - outage start date: March 2 (turn 11)
  | - mornings: better for me (turn 11)
  | - technician visit: March 6 (turn 13)
  | - callback number: 555-0142 (turn 15)
  | - preferred contact time: mornings (turn 17)
  | - promo code: SPRING20 (turn 21)
  | - mesh extender: Eero 6 (turn 23)

recent turns kept in messages: 21 (of 44), plus the query
```

## Design decisions

- The manager, not the strategy, enforces the budget. Each strategy returns blocks and a candidate history; the manager fits them. This is what makes the property-style test possible: one assertion over every prompt of every strategy on every fixture turn, and a strategy bug can only lose information, never overflow.
- The scripted answerer is deliberately not a model. The obvious design is to ask a model the probe question in offline mode with canned answers, but then the score would mix memory failures with reasoning failures. Answering correctly if and only if the evidence is in the prompt makes the number a pure property of the strategy. The tradeoff is that the offline number is an upper bound on what a live model would get from the same prompt.
- Facts are extracted only from user turns. Assistant turns are the model's own output; treating them as ground truth would let a wrong reply become a stored fact. This also keeps the rule-based extractor's junk rate low.
- Compaction is triggered by eviction, not by a schedule. Summaries and extractions run only when the recent section overflows, on the turns being evicted, so the count of compaction calls is the true extra cost of the strategy and short conversations pay nothing.
- The token counter is a documented approximation instead of a bundled tokenizer. Zero runtime dependencies was the constraint; the output reserve absorbs the error, and swapping in a real tokenizer is one function argument.

## When not to use this

- The whole conversation fits in the window with room to spare. The 16k column shows every strategy converging; truncation is then the right answer and the extra machinery is cost without benefit.
- The facts that matter come mostly from the assistant's own replies (a long generated design document, for example). The extractors here read user turns only.
- Questions are phrased very differently from the statements they depend on. BM25 retrieval fails on that by construction; embeddings would be the next step and are out of scope here.
- Facts change often and silently. The fact store resolves contradictions by recency, the summary and retrieval rely on ordering, and none of them will detect that "the launch is October 14" and "we ship on the fourth" describe the same fact.
- You need the answerer to say "not stated" reliably in production. Nothing here trains that; the distractor probes only measure whether a compaction step invented a value.

## Running it

Node 22.18 or newer. No install is needed to run anything; `npm install` only fetches `typescript` and `@types/node` for the typecheck.

```
npm test           # 46 tests, offline, no keys
npm run measure    # every strategy, both budgets, offline unless ANTHROPIC_API_KEY is set
npm run demo       # one strategy on 44 support turns at a 2k budget, with the log and the assembled prompt
npm run typecheck
```

Environment variables (see `.env.example`): `ANTHROPIC_API_KEY` switches measure to live mode and records a replay file; `MEASURE_MODEL` picks the model for live calls and pricing (default claude-sonnet-4-5); `BUDGETS` overrides the budgets, for example `BUDGETS=2048,8192`. `STRATEGY` and `BUDGET` do the same for the demo.

## Cost

Offline and replay runs cost nothing. A live `npm run measure` calls the model for every probe answer and every compaction, at both budgets, for all five strategies. From the 2026-11-19 run, with usage as reported by the API:

- 630 calls: 1,973,722 input tokens and 14,486 output tokens.
- claude-sonnet-4-5 at $3.00 per million input and $15.00 per million output (list price as of 2026-09; prices change): 1.974 x 3.00 + 0.0145 x 15.00 = 5.92 + 0.22 = $6.14.
- The same calls on claude-haiku-4-5 ($1.00 input, $5.00 output): 1.97 + 0.07 = $2.05.

Input is 96% of the bill because every probe resends the assembled prompt. The cost column in the results table is a different number: what each strategy would cost to carry the three conversations (264 turns) with a model reply every turn, from the approximate counter, at sonnet prices. It runs from $0.65 (sliding window) to $1.59 (anything that fills a 16k window). Doing that for every strategy and budget would come to about $16.75. Prices are in `src/pricing.ts`.
