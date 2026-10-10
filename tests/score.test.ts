// Headless tests for the REAL pipeline logic in
// supabase/functions/_shared/score.ts and hash.ts.
// Run with: node --test tests/score.test.ts
import test from "node:test";
import assert from "node:assert/strict";

import { sha256Hex, shingleHash64 } from "../supabase/functions/_shared/hash.ts";
import {
  CHARS_PER_CELL,
  CHARS_PER_PAGE,
  CHARS_PER_SLIDE,
  classifyPair,
  compositeScore,
  expectedCharsFor,
  extensionOf,
  filenameSimilarity,
  formatOf,
  levenshtein,
  passesConfidence,
  shingle,
  sizeBucket,
  stemOf,
  weightedJaccard,
} from "../supabase/functions/_shared/score.ts";

// --- hashing -----------------------------------------------------------------
test("sha256Hex matches the known 'abc' vector", async () => {
  const hex = await sha256Hex(new TextEncoder().encode("abc"));
  assert.equal(hex, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("shingleHash64 is deterministic and case/space insensitive", () => {
  const a = shingleHash64("The Quick Brown");
  const b = shingleHash64("the   quick   brown");
  assert.equal(a, b);
});

test("shingleHash64 stays inside PostgreSQL signed bigint range", () => {
  const MIN = -(2n ** 63n);
  const MAX = 2n ** 63n - 1n;
  for (let i = 0; i < 2000; i++) {
    const v = BigInt(shingleHash64(`shingle number ${i} with words`));
    assert.ok(v >= MIN && v <= MAX, `out of range: ${v}`);
  }
});

// --- shingling ---------------------------------------------------------------
test("shingle produces overlapping 5-word windows with correct start offsets", () => {
  const s = shingle("a b c d e f");
  assert.equal(s.length, 2, "6 words -> 2 windows");
  assert.equal(s[0].startOffset, 0);
  assert.equal(s[1].startOffset, 2, "'b' begins at index 2");
  // Windows overlap by 4 words.
  assert.equal(s[0].hash, shingleHash64("a b c d e"));
  assert.equal(s[1].hash, shingleHash64("b c d e f"));
});

test("shingle returns nothing when there are fewer than 5 words", () => {
  assert.deepEqual(shingle("one two three four"), []);
  assert.deepEqual(shingle(""), []);
});

test("start_offset is a character index usable for slicing evidence", () => {
  const text = "hello there general kenobi you are a bold one";
  const s = shingle(text);
  const offset = s[2].startOffset;
  assert.ok(
    text.startsWith("general", offset),
    "offset points at the first char of the window",
  );
});

// --- filename scoring --------------------------------------------------------
test("levenshtein distance is correct", () => {
  assert.equal(levenshtein("kitten", "sitting"), 3);
  assert.equal(levenshtein("abc", "abc"), 0);
  assert.equal(levenshtein("", "abc"), 3);
  assert.equal(levenshtein("abc", ""), 3);
});

test("filenameSimilarity is 1 for identical and 1 - dist/maxlen otherwise", () => {
  assert.equal(filenameSimilarity("Report", "report"), 1);
  assert.equal(filenameSimilarity("kitten", "sitting"), 1 - 3 / 7);
  assert.equal(filenameSimilarity("", ""), 1);
});

test("stemOf / extensionOf split filename and extension", () => {
  assert.equal(extensionOf("Report Final.PDF"), "pdf");
  assert.equal(stemOf("Report Final.PDF"), "Report Final");
  assert.equal(extensionOf("archive.tar.gz"), "gz");
  assert.equal(stemOf("archive.tar.gz"), "archive.tar");
  assert.equal(extensionOf("noext"), "");
  assert.equal(stemOf("noext"), "noext");
  assert.equal(stemOf("/tmp/dir/notes.md"), "notes");
});

// --- confidence floors -------------------------------------------------------
test("formatOf maps extensions to formats", () => {
  assert.equal(formatOf("docx"), "docx");
  assert.equal(formatOf("PPTX"), "pptx");
  assert.equal(formatOf("xlsx"), "xlsx");
  assert.equal(formatOf("pdf"), "pdf");
  assert.equal(formatOf("md"), "plain");
  assert.equal(formatOf("csv"), "plain");
  assert.equal(formatOf("png"), "unsupported");
});

test("expectedCharsFor applies the per-format floors", () => {
  assert.equal(expectedCharsFor("docx"), CHARS_PER_PAGE);
  assert.equal(expectedCharsFor("pdf", { pageCount: 3 }), 3 * CHARS_PER_PAGE);
  assert.equal(expectedCharsFor("pdf", { pageCount: null }), CHARS_PER_PAGE);
  assert.equal(expectedCharsFor("pptx", { slideCount: 4 }), 4 * CHARS_PER_SLIDE);
  assert.equal(expectedCharsFor("pptx"), CHARS_PER_SLIDE);
  assert.equal(expectedCharsFor("xlsx", { nonEmptyCells: 10 }), 10 * CHARS_PER_CELL);
  assert.equal(expectedCharsFor("plain"), 0);
  assert.equal(expectedCharsFor("unsupported"), 0);
});

test("passesConfidence uses the 20% ratio boundary", () => {
  // expected 1500 -> floor 300
  assert.equal(passesConfidence(300, 1500), true);
  assert.equal(passesConfidence(299, 1500), false);
  // plain text has no floor, so even empty text passes the ratio check
  assert.equal(passesConfidence(0, 0), true);
});

// --- content scoring ---------------------------------------------------------
test("weightedJaccard falls back to plain Jaccard and marks provisional when N < 10", () => {
  const r = weightedJaccard(["a", "b"], ["a", "c"], new Map(), 3);
  assert.equal(r.provisional, true);
  assert.equal(r.score, 1 / 3);

  const identical = weightedJaccard(["a", "b"], ["a", "b"], new Map(), 1);
  assert.equal(identical.score, 1);

  const disjoint = weightedJaccard(["a"], ["z"], new Map(), 5);
  assert.equal(disjoint.score, 0);
});

test("weightedJaccard down-weights common shingles (weight = ln(N/df))", () => {
  const N = 100;
  // df=100 -> weight 0; df=1 -> weight ln(100) ~ 4.605
  const df = new Map<string, number>([
    ["common", 100],
    ["rareA", 1],
    ["rareB", 1],
  ]);
  // Sets share only the ubiquitous "common" shingle -> it contributes nothing.
  const r = weightedJaccard(["common", "rareA"], ["common", "rareB"], df, N);
  assert.equal(r.provisional, false);
  assert.equal(r.score, 0, "sharing only a universal shingle is worth nothing");

  // A shared RARE shingle is what actually drives similarity.
  const r2 = weightedJaccard(["common", "rareA"], ["common", "rareA"], df, N);
  assert.equal(r2.score, 1);

  // Same data would score 1/3 under plain Jaccard, proving weighting differs.
  const plain = (1 / 3).toFixed(4);
  assert.notEqual(r.score.toFixed(4), plain);
});

test("weightedJaccard handles an empty intersection and empty sets", () => {
  const df = new Map<string, number>([["x", 1], ["y", 1]]);
  assert.equal(weightedJaccard(["x"], ["y"], df, 50).score, 0);
  assert.equal(weightedJaccard([], [], df, 50).score, 0);
});

// --- composite + classification ---------------------------------------------
test("compositeScore is 0.7*content + 0.3*filename, or filename alone", () => {
  assert.equal(compositeScore(0.8, 0.5), 0.7 * 0.8 + 0.3 * 0.5);
  assert.equal(compositeScore(null, 0.42), 0.42);
});

test("classifyPair flags content pairs at composite >= 0.55 with high confidence", () => {
  const r = classifyPair(0.8, false, 0.5);
  assert.equal(r.flagged, true);
  assert.equal(r.confidence, "high");
  assert.ok(Math.abs(r.composite - 0.71) < 1e-9);
});

test("a perfect filename cannot flag a low-content pair (content raises the bar)", () => {
  // 0.7*0 + 0.3*1 = 0.30 < 0.55
  const r = classifyPair(0.0, false, 1.0);
  assert.equal(r.flagged, false);
  // and just over the line
  const r2 = classifyPair(0.4, false, 0.9);
  assert.ok(Math.abs(r2.composite - 0.55) < 1e-9);
  assert.equal(r2.flagged, true, "exactly 0.55 flags");
});

test("metadata-only pairs use the filename >= 0.80 threshold", () => {
  const below = classifyPair(null, false, 0.79);
  assert.equal(below.flagged, false);
  assert.equal(below.confidence, "metadata-only");

  const at = classifyPair(null, false, 0.8);
  assert.equal(at.flagged, true);
  assert.equal(at.confidence, "metadata-only");
  assert.equal(at.composite, 0.8);
});

test("provisional content pairs are labelled provisional", () => {
  const r = classifyPair(0.9, true, 0.5);
  assert.equal(r.confidence, "provisional");
  assert.equal(r.flagged, true);
});

// --- size buckets ------------------------------------------------------------
test("sizeBucket uses floor(ln(size)/ln(1.2))", () => {
  assert.equal(sizeBucket(1), 0);
  assert.equal(sizeBucket(1000), Math.floor(Math.log(1000) / Math.log(1.2)));
  // Adjacent buckets differ by ~20% in size.
  const b = sizeBucket(1000);
  assert.equal(sizeBucket(1200), b + 1);
});
