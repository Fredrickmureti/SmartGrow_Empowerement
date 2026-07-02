/**
 * Ranking engine tests.
 *
 * Covers: exact/prefix/contains/fuzzy match, kind ordering, context boost,
 * usage recency decay, empty-query behavior. Locks in the score
 * components so tuning regressions get caught early.
 */

import { describe, it, expect } from "vitest";
import { LayoutGrid } from "lucide-react";
import { rankEntries, buildEmptyStateBuckets } from "../rank";
import type { CommandEntry } from "../types";

function entry(over: Partial<CommandEntry> & { id: string; title: string }): CommandEntry {
  return {
    kind: "page",
    appId: "platform",
    icon: LayoutGrid,
    keywords: [],
    weight: 50,
    to: `/${over.id}`,
    ...over,
  } as CommandEntry;
}

const NOW = 1_700_000_000_000;

describe("rankEntries", () => {
  it("returns nothing when query has no match", () => {
    const r = rankEntries(
      [entry({ id: "a", title: "Invoices" })],
      { query: "zzzz", currentAppId: null, usage: {}, now: NOW },
    );
    expect(r).toHaveLength(0);
  });

  it("ranks exact title above prefix above contains", () => {
    const items = [
      entry({ id: "c", title: "Customer Invoice Items" }),
      entry({ id: "p", title: "Invoice Drafts" }),
      entry({ id: "e", title: "Invoice" }),
    ];
    const r = rankEntries(items, { query: "invoice", currentAppId: null, usage: {}, now: NOW });
    expect(r[0].entry.id).toBe("e");
    expect(r[1].entry.id).toBe("p");
    expect(r[2].entry.id).toBe("c");
  });

  it("matches via keywords / aliases", () => {
    const r = rankEntries(
      [entry({ id: "a", title: "Sales Orders", keywords: ["so", "quote"] })],
      { query: "quote", currentAppId: null, usage: {}, now: NOW },
    );
    expect(r[0]?.entry.id).toBe("a");
  });

  it("applies a context boost when entry belongs to current app", () => {
    const a = entry({ id: "a", title: "Invoices", appId: "finance" });
    const b = entry({ id: "b", title: "Invoices", appId: "sales" });
    const r = rankEntries([a, b], {
      query: "invoices", currentAppId: "finance", usage: {}, now: NOW,
    });
    expect(r[0].entry.id).toBe("a");
    expect(r[0].score).toBeGreaterThan(r[1].score);
  });

  it("prefers pages over modules and actions when querying", () => {
    const items = [
      entry({ id: "m", title: "Invoices", kind: "module" }),
      entry({ id: "p", title: "Invoices", kind: "page" }),
      entry({ id: "a", title: "Invoices", kind: "action" }),
    ];
    const r = rankEntries(items, { query: "invoices", currentAppId: null, usage: {}, now: NOW });
    expect(r[0].entry.id).toBe("p");
  });

  it("fuzzy subsequence matches non-contiguous chars", () => {
    const r = rankEntries(
      [entry({ id: "a", title: "Customer Statements" })],
      { query: "cstm", currentAppId: null, usage: {}, now: NOW },
    );
    expect(r[0]?.entry.id).toBe("a");
  });

  it("usage recency decays — recent beats old at same frequency", () => {
    const items = [
      entry({ id: "a", title: "Alpha" }),
      entry({ id: "b", title: "Beta" }),
    ];
    const usage = {
      a: { count: 1, lastUsedAt: NOW - 1000 },
      b: { count: 1, lastUsedAt: NOW - 30 * 24 * 60 * 60 * 1000 }, // 30d old
    };
    const r = rankEntries(items, { query: "", currentAppId: null, usage, now: NOW });
    expect(r[0].entry.id).toBe("a");
  });

  it("empty query returns all entries scored by boosts only", () => {
    const items = [
      entry({ id: "a", title: "Alpha" }),
      entry({ id: "b", title: "Beta" }),
    ];
    const r = rankEntries(items, { query: "", currentAppId: null, usage: {}, now: NOW });
    expect(r).toHaveLength(2);
  });

  it("respects the limit option", () => {
    const items = Array.from({ length: 50 }, (_, i) =>
      entry({ id: `e${i}`, title: `Entry ${i}` }),
    );
    const r = rankEntries(items, { query: "entry", currentAppId: null, usage: {}, now: NOW, limit: 5 });
    expect(r).toHaveLength(5);
  });
});

describe("buildEmptyStateBuckets", () => {
  const items = [
    entry({ id: "a", title: "Alpha", appId: "finance", weight: 80 }),
    entry({ id: "b", title: "Beta", appId: "finance", weight: 60 }),
    entry({ id: "c", title: "Gamma", appId: "sales", weight: 90 }),
  ];

  it("sorts recent by lastUsedAt desc", () => {
    const usage = {
      a: { count: 1, lastUsedAt: 100 },
      b: { count: 1, lastUsedAt: 200 },
    };
    const { recent } = buildEmptyStateBuckets(items, usage, null);
    expect(recent.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("suggested is scoped to current app and sorted by weight", () => {
    const { suggested } = buildEmptyStateBuckets(items, {}, "finance");
    expect(suggested.map((e) => e.id)).toEqual(["a", "b"]);
  });
});
