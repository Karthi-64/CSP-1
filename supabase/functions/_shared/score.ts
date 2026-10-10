// Pure, dependency-free scoring logic. No npm imports here on purpose so the
// exact functions the pipeline runs can be exercised headlessly (see
// tests/score.test.ts). Everything is deterministic arithmetic — no AI.
import { shingleHash64 as hashOf } from "./hash.ts";

// --- per-format confidence floors -------------------------------------------
export const CHARS_PER_PAGE = 1500; // prose (.docx / .pdf)
export const CHARS_PER_SLIDE = 150; // .pptx
export const CHARS_PER_CELL = 4; // .xlsx (per non-empty cell)
export const CONFIDENCE_RATIO = 0.2; // actual chars must reach 20% of expected

export type Format = "docx" | "pptx" | "xlsx" | "pdf" | "plain" | "unsupported";

export function formatOf(ext: string): Format {
  switch (ext.toLowerCase()) {
    case "docx":
      return "docx";
    case "pptx":
      return "pptx";
    case "xlsx":
      return "xlsx";
    case "pdf":
      return "pdf";
    case "txt":
    case "md":
    case "csv":
      return "plain";
    default:
      return "unsupported";
  }
}

export interface FloorContext {
  pageCount?: number | null;
  slideCount?: number;
  nonEmptyCells?: number;
}

/** The spec's per-format floor: 1500/page, 150/slide, chars-per-cell. */
export function expectedCharsFor(format: Format, ctx: FloorContext = {}): number {
  switch (format) {
    case "docx":
      return CHARS_PER_PAGE;
    case "pptx":
      return Math.max(ctx.slideCount ?? 1, 1) * CHARS_PER_SLIDE;
    case "xlsx":
      return Math.max(ctx.nonEmptyCells ?? 1, 1) * CHARS_PER_CELL;
    case "pdf":
      return Math.max(ctx.pageCount ?? 1, 1) * CHARS_PER_PAGE;
    case "plain":
    case "unsupported":
      return 0;
  }
}

export function passesConfidence(actualChars: number, expectedMinChars: number): boolean {
  return actualChars >= expectedMinChars * CONFIDENCE_RATIO;
}

// --- filename helpers --------------------------------------------------------
export function extensionOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : "";
}

export function stemOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(0, i) : base;
}

// --- shingling ---------------------------------------------------------------
export type Shingle = { hash: string; startOffset: number };

/**
 * Overlapping 5-word shingles. start_offset is the character index where the
 * window begins, so the UI can slice ~100 chars of matched-sentence evidence.
 */
export function shingle(text: string, window = 5): Shingle[] {
  if (!text) return [];
  const words: { word: string; start: number }[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    words.push({ word: m[0], start: m.index });
  }
  const out: Shingle[] = [];
  if (words.length < window) return out;
  for (let i = 0; i + window <= words.length; i++) {
    const slice = words.slice(i, i + window).map((w) => w.word).join(" ");
    out.push({ hash: hashOf(slice), startOffset: words[i].start });
  }
  return out;
}

// --- scoring -----------------------------------------------------------------
/** Normalised similarity in [0,1]: 1 − Levenshtein / max length. */
export function filenameSimilarity(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return 1;
  const maxLen = Math.max(x.length, y.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(x, y) / maxLen;
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

export type ContentScore = { score: number; provisional: boolean } | null;

/**
 * Down-weighted Jaccard over shingle sets.
 *   weight(s) = ln(N / df(s))
 * When N < 10 we fall back to plain (unweighted) Jaccard and mark provisional.
 */
export function weightedJaccard(
  aHashes: string[],
  bHashes: string[],
  docFrequency: Map<string, number>,
  N: number,
): { score: number; provisional: boolean } {
  const setA = new Set(aHashes);
  const setB = new Set(bHashes);
  const union = new Set([...setA, ...setB]);
  const inter = [...setA].filter((h) => setB.has(h));

  if (N < 10) {
    const score = union.size === 0 ? 0 : inter.length / union.size;
    return { score, provisional: true };
  }

  const weight = (h: string) => {
    const df = Math.max(docFrequency.get(h) ?? 1, 1);
    return Math.log(N / df);
  };

  let unionWeight = 0;
  for (const h of union) unionWeight += weight(h);
  let interWeight = 0;
  for (const h of inter) interWeight += weight(h);

  return { score: unionWeight === 0 ? 0 : interWeight / unionWeight, provisional: false };
}

export function compositeScore(contentScore: number | null, filenameScore: number): number {
  return contentScore === null ? filenameScore : 0.7 * contentScore + 0.3 * filenameScore;
}

// Thresholds from the spec.
export const CONTENT_FLAG_THRESHOLD = 0.55;
export const METADATA_FLAG_THRESHOLD = 0.8;

export function sizeBucket(sizeBytes: number): number {
  return Math.floor(Math.log(Math.max(sizeBytes, 1)) / Math.log(1.2));
}

/**
 * The single decision the pipeline makes about a scored pair: was it flagged,
 * and with what confidence? Extracted so it can be tested directly.
 */
export function classifyPair(
  contentScore: number | null,
  provisional: boolean,
  filenameScore: number,
): { flagged: boolean; confidence: "high" | "provisional" | "metadata-only"; composite: number } {
  const composite = compositeScore(contentScore, filenameScore);
  const flagged = contentScore !== null
    ? composite >= CONTENT_FLAG_THRESHOLD
    : filenameScore >= METADATA_FLAG_THRESHOLD;
  const confidence = contentScore === null
    ? "metadata-only"
    : provisional
    ? "provisional"
    : "high";
  return { flagged, confidence, composite };
}
