import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countTokens, fitText } from "./tokens.ts";

describe("countTokens", () => {
  it("returns 0 for empty text and grows with length", () => {
    assert.equal(countTokens(""), 0);
    const short = countTokens("The database is PostgreSQL 16.");
    const long = countTokens("The database is PostgreSQL 16. ".repeat(10));
    assert.ok(short > 0);
    assert.ok(long > short * 8);
  });

  it("charges more per character for code than for prose", () => {
    const prose = "the quick brown fox jumps over the lazy dog and keeps running";
    const code = "fn({a:[1,2,3],b:{c:'d'}});x=y||z;" + "  ".repeat(10);
    assert.ok(countTokens(code) / code.length > countTokens(prose) / prose.length);
  });

  it("lands near chars/4 on plain prose", () => {
    const prose = "Store them, but derive them in one place. Compute the total from the line items in the domain layer.";
    const ratio = countTokens(prose) / (prose.length / 4);
    assert.ok(ratio > 0.8 && ratio < 1.3, `ratio ${ratio}`);
  });
});

describe("fitText", () => {
  it("returns text unchanged when it fits", () => {
    assert.equal(fitText("hello world", 100, countTokens), "hello world");
  });

  it("cuts to the cap keeping head and tail", () => {
    const text = "HEAD " + "word ".repeat(400) + " TAIL";
    const cut = fitText(text, 50, countTokens);
    assert.ok(countTokens(cut) <= 50);
    assert.ok(cut.startsWith("HEAD"));
    assert.ok(cut.endsWith("TAIL"));
    assert.ok(cut.includes("cut to fit the budget"));
  });

  it("returns empty for a zero cap", () => {
    assert.equal(fitText("anything", 0, countTokens), "");
  });
});
