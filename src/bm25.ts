// BM25 by hand over short documents (conversation turns).
// Okapi BM25 with k1 = 1.2 and b = 0.75 and a crude suffix stemmer.

const STOPWORDS = new Set(
  "a an the and or but if then so of to in on at for with by from as is are was were be been being it its this that these those i you we they he she me my our your their what which who whom when where why how do does did done have has had can could should would will just also not no yes about into over up down out than too very".split(" "),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9$.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

// Strips the most common English suffixes so "traveling", "traveled" and
// "travels" share a stem. Not Porter; good enough for turn retrieval.
export function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return undouble(w.slice(0, -3));
  if (w.length > 4 && w.endsWith("ed")) return undouble(w.slice(0, -2));
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

// "preferr" -> "prefer", "plann" -> "plan".
function undouble(w: string): string {
  const n = w.length;
  return n > 3 && w[n - 1] === w[n - 2] && !/[aeiou]/.test(w[n - 1]!) ? w.slice(0, -1) : w;
}

export type Hit = { id: number; score: number };

export class BM25Index {
  private readonly docs = new Map<number, string[]>();
  private readonly df = new Map<string, number>();
  private totalLen = 0;
  readonly k1: number;
  readonly b: number;

  constructor(k1 = 1.2, b = 0.75) {
    this.k1 = k1;
    this.b = b;
  }

  get size(): number {
    return this.docs.size;
  }

  add(id: number, text: string): void {
    if (this.docs.has(id)) throw new Error(`document ${id} already indexed`);
    const terms = tokenize(text);
    this.docs.set(id, terms);
    this.totalLen += terms.length;
    for (const t of new Set(terms)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
  }

  search(query: string, k: number, exclude?: Set<number>): Hit[] {
    const q = new Set(tokenize(query));
    if (q.size === 0 || this.docs.size === 0) return [];
    const n = this.docs.size;
    const avgLen = this.totalLen / n;
    const hits: Hit[] = [];
    for (const [id, terms] of this.docs) {
      if (exclude?.has(id)) continue;
      let score = 0;
      const tf = new Map<string, number>();
      for (const t of terms) if (q.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [t, f] of tf) {
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * terms.length) / avgLen)));
      }
      if (score > 0) hits.push({ id, score });
    }
    hits.sort((a, b) => b.score - a.score || a.id - b.id);
    return hits.slice(0, k);
  }
}
