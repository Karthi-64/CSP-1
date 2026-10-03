// Text extraction (format-specific), confidence floors, shingling and all
// scoring math. Everything here is deterministic arithmetic — no AI.

import JSZip from "npm:jszip@3.10.1";
import { extractText, getDocumentProxy } from "npm:unpdf@0.12.1";
import { shingleHash64 as hashOf } from "./hash.ts";

export type Extracted = {
  text: string;
  ok: boolean;
  reason: string;
  expectedMinChars: number;
  pageCount: number | null;
};

// --- per-format floors -------------------------------------------------------
export const CHARS_PER_PAGE = 1500; // prose (.docx / .pdf)
export const CHARS_PER_SLIDE = 150; // .pptx
export const CHARS_PER_CELL = 4; // .xlsx (non-empty cells)
export const CONFIDENCE_RATIO = 0.2; // actual must reach 20% of expected

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

function cleanText(s: string): string {
  return decodeXmlEntities(s)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const doc = zip.file("word/document.xml");
  const parts: string[] = [];
  if (doc) {
    const xml = await doc.async("string");
    // Paragraph breaks become newlines, runs (<w:t>) become text.
    for (const para of xml.split(/<\/w:p>/)) {
      const runs = [...para.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]);
      if (runs.length) parts.push(decodeXmlEntities(runs.join("")));
    }
  }
  return cleanText(parts.join("\n"));
}

async function extractPptx(bytes: Uint8Array): Promise<{ text: string; slides: number }> {
  const zip = await JSZip.loadAsync(bytes);
  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = Number(a.match(/(\d+)/)![1]);
      const nb = Number(b.match(/(\d+)/)![1]);
      return na - nb;
    });
  const parts: string[] = [];
  for (const name of slideFiles) {
    const xml = await zip.file(name)!.async("string");
    const runs = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]);
    if (runs.length) parts.push(decodeXmlEntities(runs.join(" ")));
  }
  return { text: cleanText(parts.join("\n\n")), slides: slideFiles.length };
}

async function extractXlsx(bytes: Uint8Array): Promise<{ text: string; nonEmptyCells: number }> {
  const zip = await JSZip.loadAsync(bytes);
  const parts: string[] = [];

  // Shared strings hold most cell text.
  const shared = zip.file("xl/sharedStrings.xml");
  if (shared) {
    const xml = await shared.async("string");
    for (const m of xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) {
      if (m[1].trim()) parts.push(decodeXmlEntities(m[1]));
    }
  }

  // Inline strings + numeric cells across all sheets.
  let nonEmptyCells = 0;
  for (const name of Object.keys(zip.files)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
    const xml = await zip.file(name)!.async("string");
    for (const m of xml.matchAll(/<c\b[^>]*>([\s\S]*?)<\/c>/g)) {
      const cell = m[1];
      const inline = cell.match(/<t[^>]*>([\s\S]*?)<\/t>/);
      const value = cell.match(/<v[^>]*>([\s\S]*?)<\/v>/);
      const content = inline ? decodeXmlEntities(inline[1]) : (value ? value[1] : "");
      if (content.trim()) {
        nonEmptyCells++;
        parts.push(content);
      }
    }
  }
  return { text: cleanText(parts.join("\t")), nonEmptyCells };
}

async function extractPdf(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  // Copy into a fresh buffer: pdf.js may detach the input.
  const proxy = await getDocumentProxy(new Uint8Array(bytes));
  const { text, totalPages } = await extractText(proxy, { mergePages: true });
  const merged = Array.isArray(text) ? text.join("\n") : text;
  return { text: cleanText(merged ?? ""), pages: totalPages };
}

function extractPlain(bytes: Uint8Array): string {
  return cleanText(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
}

export function extensionOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : "";
}

export function stemOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(0, i) : base;
}

/**
 * Extract text + page count for a file, applying the spec's confidence floor.
 * Returns extraction_ok=false (and a reason) when the text layer is too thin,
 * which sends the pair to metadata-only comparison.
 */
export async function extractFile(
  filename: string,
  bytes: Uint8Array,
): Promise<Extracted> {
  const ext = extensionOf(filename);
  const fail = (reason: string, expected = 0): Extracted => ({
    text: "",
    ok: false,
    reason,
    expectedMinChars: expected,
    pageCount: null,
  });

  try {
    if (ext === "txt" || ext === "md" || ext === "csv") {
      const text = extractPlain(bytes);
      return {
        text,
        ok: text.length > 0,
        reason: text.length > 0 ? "plain-text read directly" : "empty plain-text file",
        expectedMinChars: 0,
        pageCount: null,
      };
    }

    if (ext === "docx") {
      const text = await extractDocx(bytes);
      // .docx exposes no reliable page count without a layout engine; treat
      // the document as at least one page.
      const expected = CHARS_PER_PAGE;
      const ok = text.length >= expected * CONFIDENCE_RATIO;
      return {
        text,
        ok,
        reason: ok ? "docx XML text nodes parsed" : "docx text layer below confidence floor",
        expectedMinChars: expected,
        pageCount: null,
      };
    }

    if (ext === "pptx") {
      const { text, slides } = await extractPptx(bytes);
      const expected = Math.max(slides, 1) * CHARS_PER_SLIDE;
      const ok = text.length >= expected * CONFIDENCE_RATIO;
      return {
        text,
        ok,
        reason: ok ? "pptx slide text parsed" : "pptx text below confidence floor",
        expectedMinChars: expected,
        pageCount: slides,
      };
    }

    if (ext === "xlsx") {
      const { text, nonEmptyCells } = await extractXlsx(bytes);
      const expected = Math.max(nonEmptyCells, 1) * CHARS_PER_CELL;
      const ok = text.length >= expected * CONFIDENCE_RATIO;
      return {
        text,
        ok,
        reason: ok ? "xlsx shared/inline strings parsed" : "xlsx text below confidence floor",
        expectedMinChars: expected,
        pageCount: null,
      };
    }

    if (ext === "pdf") {
      const { text, pages } = await extractPdf(bytes);
      const expected = Math.max(pages, 1) * CHARS_PER_PAGE;
      const ok = text.length >= expected * CONFIDENCE_RATIO;
      return {
        text,
        ok,
        reason: ok ? "pdf text layer extracted" : "scanned/pdf text layer below confidence floor",
        expectedMinChars: expected,
        pageCount: pages,
      };
    }

    return fail(`unsupported format: .${ext}`);
  } catch (err) {
    return fail(`extraction error: ${(err as Error).message}`);
  }
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

/** Normalised Levenshtein distance in [0,1]; 1 - distance = similarity. */
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
