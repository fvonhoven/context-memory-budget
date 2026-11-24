# Why it is built this way

The question this repo answers is not "which memory strategy is best" but "how would you know". Most write-ups of context management describe the strategies and stop. I wanted the measurement to be the centerpiece, so the fixtures, the probes and the scripted answerer took as much design effort as the strategies.

## Tradeoffs I accepted

The scripted answerer makes the offline score a clean property of the strategy, but it is generous. It matches evidence strings, so a fact that is present but buried in an unrelated retrieved turn counts as recalled, where a real model might miss it. The offline numbers are an upper bound. I preferred a clean upper bound to a noisy number that mixed in model behavior I could not control offline.

The extractive summarizer is tuned to keep exactly the kind of sentence the fixtures contain, which is why rolling summary scored 100 percent at 4k offline. I left it that way rather than weaken the summarizer to make the table look more dramatic, and said in the README that a model summarizer would do worse. The live run confirmed it: 66 percent. Offline numbers for a strategy that depends on generated text are the least trustworthy ones in the table.

The rule-based extractor is deliberately narrow. Extracting only "X is Y" shapes from user turns keeps junk low, and the one probe it misses shows the failure mode honestly. A model extractor would catch that probe and would introduce the false-recall risk the distractor probes are there to catch.

The 16k column is flat because all three conversations fit. I could have written longer fixtures so 16k also forced compaction; the cost of hand-writing another 30k tokens of realistic dialogue was not worth it for one more column. `BUDGETS=2048,8192` gives the intermediate points.

## What I would do differently

Add an embedding retriever next to BM25, because the offline retrieval miss was a vocabulary mismatch and that is exactly what embeddings fix. Combine strategies: structured memory for settled facts plus retrieval for everything else is the configuration I would ship, and the pluggable interface makes it a small file. Give the fact store a notion of supersession that the retrieval strategy can consult, so a retrieved turn carrying a stale value is flagged. Replace the approximate token counter with a real tokenizer behind the same function type; the approximation is fine for budgeting but the cost numbers would then be exact rather than within 15 percent.

The implementation is larger than the portfolio target, about 1100 lines of source without tests, providers and scripts. Five strategies, two fallbacks, a BM25 index and an evaluator each earn their space; I did not find a way to cut it that kept every file readable on its own.
