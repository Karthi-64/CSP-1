import { diffWords } from "diff";
import type { ReactNode } from "react";

/**
 * Myers-style word diff over two extracted texts, rendered as inline
 * added/removed spans. Uses the `diff` npm package — no AI, no custom engine.
 */
export function renderWordDiff(a: string, b: string): ReactNode[] {
  const parts = diffWords(a, b);
  return parts.map((part, i) => {
    if (part.added) {
      return (
        <ins key={i} className="diff-add">
          {part.value}
        </ins>
      );
    }
    if (part.removed) {
      return (
        <del key={i} className="diff-del">
          {part.value}
        </del>
      );
    }
    return <span key={i}>{part.value}</span>;
  });
}

/** Slice ~chars characters of context around an offset in extracted text. */
export function excerpt(text: string, offset: number, radius = 100): string {
  const start = Math.max(0, offset - radius);
  const end = Math.min(text.length, offset + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(start, end).replace(/\s+/g, " ").trim() + suffix;
}
