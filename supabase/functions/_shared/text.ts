// Text extraction (format-specific) for the upload pipeline. All the pure
// arithmetic — shingling, scoring, confidence floors — lives in ./score.ts.
// Everything here is deterministic; no AI service is called.
import JSZip from "npm:jszip@3.10.1";
import { extractText, getDocumentProxy } from "npm:unpdf@0.12.1";
import {
  extensionOf,
  formatOf,
  expectedCharsFor,
  passesConfidence,
} from "./score.ts";

export * from "./score.ts";

export type Extracted = {
  text: string;
  ok: boolean;
  reason: string;
  expectedMinChars: number;
  pageCount: number | null;
};

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
  const format = formatOf(ext);
  const fail = (reason: string, expected = 0): Extracted => ({
    text: "",
    ok: false,
    reason,
    expectedMinChars: expected,
    pageCount: null,
  });

  try {
    if (format === "plain") {
      const text = extractPlain(bytes);
      return {
        text,
        ok: text.length > 0,
        reason: text.length > 0 ? "plain-text read directly" : "empty plain-text file",
        expectedMinChars: 0,
        pageCount: null,
      };
    }

    if (format === "docx") {
      const text = await extractDocx(bytes);
      // .docx exposes no reliable page count without a layout engine; treat
      // the document as at least one page.
      const expected = expectedCharsFor("docx");
      const ok = passesConfidence(text.length, expected);
      return {
        text,
        ok,
        reason: ok ? "docx XML text nodes parsed" : "docx text layer below confidence floor",
        expectedMinChars: expected,
        pageCount: null,
      };
    }

    if (format === "pptx") {
      const { text, slides } = await extractPptx(bytes);
      const expected = expectedCharsFor("pptx", { slideCount: slides });
      const ok = passesConfidence(text.length, expected);
      return {
        text,
        ok,
        reason: ok ? "pptx slide text parsed" : "pptx text below confidence floor",
        expectedMinChars: expected,
        pageCount: slides,
      };
    }

    if (format === "xlsx") {
      const { text, nonEmptyCells } = await extractXlsx(bytes);
      const expected = expectedCharsFor("xlsx", { nonEmptyCells });
      const ok = passesConfidence(text.length, expected);
      return {
        text,
        ok,
        reason: ok ? "xlsx shared/inline strings parsed" : "xlsx text below confidence floor",
        expectedMinChars: expected,
        pageCount: null,
      };
    }

    if (format === "pdf") {
      const { text, pages } = await extractPdf(bytes);
      const expected = expectedCharsFor("pdf", { pageCount: pages });
      const ok = passesConfidence(text.length, expected);
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
