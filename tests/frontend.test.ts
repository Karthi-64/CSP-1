// Tests for the pure frontend helpers and for how we use the `diff` package.
// Run with: node --test tests/frontend.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { diffWords } from "diff";

import {
  excerpt,
  formatBytes,
  formatDate,
  formatPercent,
} from "../src/lib/format.ts";

test("formatBytes scales units", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatBytes(-1), "0 B");
});

test("formatPercent rounds to whole percent and handles null", () => {
  assert.equal(formatPercent(0.556), "56%");
  assert.equal(formatPercent(0), "0%");
  assert.equal(formatPercent(null), "—");
  assert.equal(formatPercent(Number.NaN), "—");
});

test("formatDate renders valid dates and dashes invalid ones", () => {
  const out = formatDate("2026-10-03T04:33:12Z");
  assert.match(out, /2026/);
  assert.notEqual(out, "—");
  assert.equal(formatDate("not-a-date"), "—");
});

test("excerpt slices around an offset and adds ellipses at the edges", () => {
  const text = "x".repeat(200);
  const middle = excerpt(text, 100, 10);
  assert.ok(middle.startsWith("…"));
  assert.ok(middle.endsWith("…"));
  // A window at the very start should not gain a leading ellipsis.
  const head = excerpt(text, 0, 10);
  assert.ok(!head.startsWith("…"));
});

test("diffWords marks additions and removals (the library contract we rely on)", () => {
  const parts = diffWords("the quick brown fox", "the quick red fox");
  const removed = parts.filter((p) => p.removed).map((p) => p.value.trim());
  const added = parts.filter((p) => p.added).map((p) => p.value.trim());
  assert.ok(removed.includes("brown"), `expected 'brown' removed, got ${JSON.stringify(removed)}`);
  assert.ok(added.includes("red"), `expected 'red' added, got ${JSON.stringify(added)}`);
  // Unchanged text is neither added nor removed.
  assert.ok(parts.some((p) => !p.added && !p.removed && p.value.includes("quick")));
});
