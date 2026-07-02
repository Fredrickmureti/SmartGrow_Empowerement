/**
 * Fuzzy string matching for contact matching during migration.
 * Uses Levenshtein distance and token-based similarity.
 */

/** Calculate Levenshtein distance between two strings */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }

  return dp[m][n];
}

/** Normalized similarity score (0 to 1, 1 = identical) */
function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/** Token-based similarity: how many words overlap */
function tokenSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tokensB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let overlap = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) overlap++;
  }
  return overlap / Math.max(tokensA.size, tokensB.size);
}

export interface FuzzyMatch<T> {
  item: T;
  score: number;
  matchType: "exact" | "fuzzy" | "none";
}

/**
 * Find the best fuzzy match for a query string among candidates.
 * 
 * @param query The name to search for
 * @param candidates Array of items to match against
 * @param getName Function to extract the name from a candidate
 * @param threshold Minimum similarity score to consider a match (default 0.7)
 */
export function findBestMatch<T>(
  query: string,
  candidates: T[],
  getName: (item: T) => string,
  threshold = 0.7
): FuzzyMatch<T> | null {
  const q = query.toLowerCase().trim();
  if (!q) return null;

  let bestMatch: FuzzyMatch<T> | null = null;

  for (const item of candidates) {
    const name = getName(item).toLowerCase().trim();

    // Exact match
    if (name === q) {
      return { item, score: 1, matchType: "exact" };
    }

    // Combined similarity: weighted average of string and token similarity
    const strSim = similarity(q, name);
    const tokSim = tokenSimilarity(q, name);
    const combinedScore = strSim * 0.6 + tokSim * 0.4;

    if (combinedScore >= threshold && (!bestMatch || combinedScore > bestMatch.score)) {
      bestMatch = { item, score: combinedScore, matchType: "fuzzy" };
    }
  }

  return bestMatch;
}

/**
 * Find all matches above threshold, sorted by score descending.
 */
export function findAllMatches<T>(
  query: string,
  candidates: T[],
  getName: (item: T) => string,
  threshold = 0.5,
  maxResults = 5
): FuzzyMatch<T>[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const matches: FuzzyMatch<T>[] = [];

  for (const item of candidates) {
    const name = getName(item).toLowerCase().trim();
    const strSim = similarity(q, name);
    const tokSim = tokenSimilarity(q, name);
    const combinedScore = strSim * 0.6 + tokSim * 0.4;

    if (combinedScore >= threshold) {
      matches.push({
        item,
        score: combinedScore,
        matchType: name === q ? "exact" : "fuzzy",
      });
    }
  }

  return matches
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}
