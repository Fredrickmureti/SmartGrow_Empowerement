/**
 * Shared entity matching for migration stages.
 * Replaces 3x duplicated matching logic (accounts, contacts, products).
 * 
 * Supports: exact match, case-insensitive match, fuzzy match.
 */

import { findBestMatch, findAllMatches, type FuzzyMatch } from "./fuzzyMatch";

export interface MatchResult<T> {
  item: T;
  score: number;
  matchType: "exact" | "case_insensitive" | "fuzzy";
}

export interface EntityMatcherConfig<T> {
  /** Primary key extractor (e.g., account code, SKU) */
  primaryKey?: (item: T) => string;
  /** Secondary key extractor (e.g., name) */
  secondaryKey?: (item: T) => string;
  /** Enable fuzzy matching on secondary key */
  fuzzyMatch?: boolean;
  /** Fuzzy match threshold (0-1, default 0.7) */
  fuzzyThreshold?: number;
}

/**
 * Build an entity matcher from a list of candidates.
 * Returns a match function that tries exact → case-insensitive → fuzzy.
 */
export function createEntityMatcher<T>(
  candidates: T[],
  config: EntityMatcherConfig<T>
) {
  // Build lookup maps
  const primaryMap = new Map<string, T>();
  const secondaryMap = new Map<string, T>();

  for (const item of candidates) {
    if (config.primaryKey) {
      const pk = config.primaryKey(item).toLowerCase().trim();
      if (pk) primaryMap.set(pk, item);
    }
    if (config.secondaryKey) {
      const sk = config.secondaryKey(item).toLowerCase().trim();
      if (sk) secondaryMap.set(sk, item);
    }
  }

  /**
   * Find the best match for a query.
   * @param primaryQuery Primary key to match (e.g., account code)
   * @param secondaryQuery Secondary key to match (e.g., name)
   */
  function match(
    primaryQuery?: string,
    secondaryQuery?: string
  ): MatchResult<T> | null {
    // 1. Exact primary key match
    if (primaryQuery && config.primaryKey) {
      const pk = primaryQuery.toLowerCase().trim();
      const found = primaryMap.get(pk);
      if (found) return { item: found, score: 1, matchType: "exact" };
    }

    // 2. Exact secondary key match (case-insensitive)
    if (secondaryQuery && config.secondaryKey) {
      const sk = secondaryQuery.toLowerCase().trim();
      const found = secondaryMap.get(sk);
      if (found) return { item: found, score: 1, matchType: "case_insensitive" };
    }

    // 3. Fuzzy match on secondary key
    if (
      secondaryQuery &&
      config.secondaryKey &&
      config.fuzzyMatch !== false
    ) {
      const result = findBestMatch(
        secondaryQuery,
        candidates,
        config.secondaryKey,
        config.fuzzyThreshold ?? 0.7
      );
      if (result) {
        return {
          item: result.item,
          score: result.score,
          matchType: "fuzzy",
        };
      }
    }

    return null;
  }

  /**
   * Find top fuzzy match candidates for UI display.
   */
  function findCandidates(
    query: string,
    maxResults = 3
  ): Array<{ item: T; score: number }> {
    if (!config.secondaryKey) return [];
    return findAllMatches(
      query,
      candidates,
      config.secondaryKey,
      0.5,
      maxResults
    ).map((m) => ({ item: m.item, score: m.score }));
  }

  return { match, findCandidates, primaryMap, secondaryMap };
}
