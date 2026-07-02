/**
 * Command Palette — Ranking Engine
 *
 * Pure, dependency-free scoring. Given a query and a pre-filtered list
 * of `CommandEntry` objects, returns the top N ranked results.
 *
 * Score components (all additive):
 *   matchScore   0..1.5  — fuzzy match against title/keywords/subtitle
 *   contextBoost 0..0.25 — entry belongs to the user's current app
 *   kindBoost    0..0.20 — page/report > module > action when querying
 *   usageBoost   0..0.50 — log frequency + recency half-life (7 days)
 *   weight/100   0..1.0  — static priority from the entry definition
 *
 * Deliberately simple: no trigram index, no worker, no async. With
 * ~500 entries this runs in well under 4 ms on a mid-tier laptop.
 */

import type { CommandEntry, RankedEntry, UsageMap } from "./types";

const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/* ── Fuzzy matching ───────────────────────────────────────────────── */

/** Subsequence match: are all chars of `q` in `t` in order? */
function subseqScore(q: string, t: string): number {
  if (!q) return 0;
  let qi = 0;
  let lastHit = -1;
  let gaps = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (lastHit !== -1) gaps += ti - lastHit - 1;
      lastHit = ti;
      qi++;
    }
  }
  if (qi < q.length) return 0;
  // Tighter sequences (smaller gaps) score higher.
  const density = q.length / (q.length + gaps);
  return 0.4 + density * 0.4; // 0.4..0.8
}

function tokenScore(q: string, tokens: string[]): number {
  if (!q || tokens.length === 0) return 0;
  let best = 0;
  for (const tok of tokens) {
    if (tok === q) return 1.5; // exact token = strongest signal
    if (tok.startsWith(q)) best = Math.max(best, 1.1);
    else if (tok.includes(q)) best = Math.max(best, 0.85);
  }
  return best;
}

function matchScore(query: string, entry: CommandEntry): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;

  const title = entry.title.toLowerCase();
  const subtitle = (entry.subtitle ?? "").toLowerCase();

  // 1. Strong: title prefix / contains / exact
  if (title === q) return 1.5;
  if (title.startsWith(q)) return 1.2;
  if (title.includes(q)) return 0.95;

  // 2. Token / keyword match
  const tok = tokenScore(q, entry.keywords);
  if (tok > 0) return tok;

  // 3. Subtitle contains
  if (subtitle.includes(q)) return 0.7;

  // 4. Fuzzy subsequence on title
  const sub = subseqScore(q, title);
  if (sub > 0) return sub;

  return 0;
}

/* ── Boosts ───────────────────────────────────────────────────────── */

function contextBoost(entry: CommandEntry, currentAppId: string | null): number {
  if (!currentAppId) return 0;
  if (entry.appId === currentAppId) return 0.25;
  return 0;
}

function kindBoost(entry: CommandEntry, hasQuery: boolean): number {
  if (!hasQuery) {
    // Empty query: surface actions and recents first.
    if (entry.kind === "action") return 0.15;
    if (entry.kind === "page") return 0.10;
    return 0.05;
  }
  // With query: prefer concrete pages and reports over abstract modules.
  if (entry.kind === "page") return 0.20;
  if (entry.kind === "report") return 0.15;
  if (entry.kind === "action") return 0.10;
  return 0;
}

function usageBoost(entry: CommandEntry, usage: UsageMap, now: number): number {
  const rec = usage[entry.id];
  if (!rec) return 0;
  // log-scaled frequency, capped.
  const freq = Math.min(0.30, Math.log2(rec.count + 1) * 0.10);
  // exponential recency decay.
  const age = Math.max(0, now - rec.lastUsedAt);
  const recency = 0.20 * Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
  return freq + recency;
}

/* ── Public API ───────────────────────────────────────────────────── */

export interface RankOptions {
  query: string;
  currentAppId: string | null;
  usage: UsageMap;
  /** Max results returned (default 30). */
  limit?: number;
  /** Override "now" for deterministic tests. */
  now?: number;
}

/**
 * Rank a pre-filtered list of entries. Returns the top `limit` matches
 * sorted by score descending. With an empty query, results are scored
 * purely from boosts (usage + kind + weight).
 */
export function rankEntries(
  entries: readonly CommandEntry[],
  opts: RankOptions,
): RankedEntry[] {
  const { query, currentAppId, usage, limit = 30, now = Date.now() } = opts;
  const q = query.trim();
  const hasQuery = q.length > 0;

  const scored: RankedEntry[] = [];
  for (const entry of entries) {
    const m = hasQuery ? matchScore(q, entry) : 0;
    if (hasQuery && m === 0) continue;

    const score =
      m +
      contextBoost(entry, currentAppId) +
      kindBoost(entry, hasQuery) +
      usageBoost(entry, usage, now) +
      (entry.weight ?? 0) / 100;

    scored.push({ entry, score });
  }

  scored.sort((a, b) => b.score - a.score);

  // Module suppression: if any "page" entry scored ≥ 1.0 within an app,
  // drop noisier "module" entries for that same app — the user clearly
  // matched something more specific.
  if (hasQuery) {
    const strongPageApps = new Set<string>();
    for (const r of scored) {
      if (r.entry.kind === "page" && r.score >= 1.0) {
        strongPageApps.add(r.entry.appId);
      }
    }
    if (strongPageApps.size > 0) {
      const filtered = scored.filter(
        (r) => !(r.entry.kind === "module" && strongPageApps.has(r.entry.appId)),
      );
      return filtered.slice(0, limit);
    }
  }

  return scored.slice(0, limit);
}

/**
 * Empty-state buckets shown when the user opens the palette with no query.
 * Recents = most recently used (top 5)
 * Frequent = most-used overall (top 5)
 * Suggested = highest-weight entries scoped to current app (top 5)
 */
export function buildEmptyStateBuckets(
  entries: readonly CommandEntry[],
  usage: UsageMap,
  currentAppId: string | null,
  now: number = Date.now(),
): { recent: CommandEntry[]; frequent: CommandEntry[]; suggested: CommandEntry[] } {
  const byId = new Map(entries.map(e => [e.id, e] as const));

  const used = Object.entries(usage)
    .map(([id, rec]) => ({ entry: byId.get(id), rec }))
    .filter((x): x is { entry: CommandEntry; rec: typeof x.rec } => !!x.entry);

  const recent = [...used]
    .sort((a, b) => b.rec.lastUsedAt - a.rec.lastUsedAt)
    .slice(0, 5)
    .map(x => x.entry);

  const frequent = [...used]
    .sort((a, b) => b.rec.count - a.rec.count)
    .slice(0, 5)
    .map(x => x.entry);

  const suggested = entries
    .filter(e => e.appId === currentAppId && e.kind !== "module")
    .slice()
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, 5);

  // ack `now` so callers can pass it through deterministically.
  void now;
  return { recent, frequent, suggested };
}
