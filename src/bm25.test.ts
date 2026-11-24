import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BM25Index, stem, tokenize } from "./bm25.ts";

describe("BM25Index", () => {
  it("ranks the turn that mentions the queried fact first", () => {
    const index = new BM25Index();
    index.add(1, "The database is PostgreSQL 16 and it runs in Docker.");
    index.add(2, "The deploy target is Render with a managed database.");
    index.add(3, "Let's talk about the launch checklist and the pilot.");
    const hits = index.search("Which database version are we on?", 2);
    assert.equal(hits[0]?.id, 1);
    assert.equal(hits.length, 2);
  });

  it("excludes ids on request and returns nothing for stopword-only queries", () => {
    const index = new BM25Index();
    index.add(1, "airline is TAP Air Portugal");
    index.add(2, "the airline seats are narrow");
    assert.deepEqual(index.search("airline", 5, new Set([1])).map((h) => h.id), [2]);
    assert.deepEqual(index.search("the and of", 5), []);
  });

  it("stems so traveling matches travel", () => {
    assert.equal(stem("traveling"), "travel");
    assert.equal(stem("preferred"), "prefer");
    assert.deepEqual(tokenize("Who is traveling with me?"), ["travel"]);
  });

  it("rejects duplicate ids", () => {
    const index = new BM25Index();
    index.add(1, "a b c");
    assert.throws(() => index.add(1, "again"));
  });
});
