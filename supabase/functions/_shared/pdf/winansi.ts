/**
 * winansiSafe — sanitize a string so it can be safely encoded by pdf-lib's
 * built-in StandardFonts, which use WinAnsi (Latin-1) and throw on any
 * code point outside that range (e.g. "⚠" U+26A0, "—" U+2014, smart
 * quotes, CJK, ₦, ₹, etc.).
 *
 * Strategy:
 *   1. Replace a curated set of common non-Latin-1 characters with their
 *      closest Latin-1 equivalents so headings, punctuation, currency
 *      symbols and warning markers remain legible.
 *   2. Drop everything else outside U+0000–U+00FF, replacing it with "?"
 *      so the renderer never throws even if a localization pack ships an
 *      unexpected glyph.
 *
 * This is defense-in-depth: callers should still prefer Latin-1 source
 * strings. The longer-term fix is to embed a Unicode TTF (NotoSans /
 * DejaVuSans) via fontkit so non-Latin scripts render natively. Until
 * then this guarantees the PDF pipeline cannot crash on a single glyph.
 */

const REPLACEMENTS: Record<string, string> = {
  // Warning / status glyphs used in our own diagnostics
  "\u26A0": "[!]",   // ⚠ WARNING SIGN
  "\u2705": "[ok]",  // ✅
  "\u274C": "[x]",   // ❌
  "\u2713": "v",     // ✓
  "\u2717": "x",     // ✗
  "\u2192": "->",    // →
  "\u2190": "<-",    // ←
  "\u2194": "<->",   // ↔
  "\u221E": "inf",   // ∞
  "\u00D7": "x",     // × multiplication sign
  "\uFE0F": "",      // emoji variation selector
  "\u200D": "",      // zero-width joiner
  // Dashes
  "\u2013": "-",     // – en dash
  "\u2014": "-",     // — em dash
  "\u2212": "-",     // − minus
  // Quotes
  "\u2018": "'",
  "\u2019": "'",
  "\u201C": '"',
  "\u201D": '"',
  // Ellipsis & bullets
  "\u2026": "...",
  "\u2022": "*",
  "\u00B7": "*",     // middle dot is Latin-1 but keep mapping for clarity
  // Currency symbols outside Latin-1
  "\u20A6": "NGN ",  // ₦
  "\u20A8": "Rs ",   // ₨
  "\u20B9": "INR ",  // ₹
  "\u20AB": "VND ",  // ₫
  "\u20B1": "PHP ",  // ₱
  "\u20B4": "UAH ",  // ₴
  "\u20BD": "RUB ",  // ₽
  "\u20BF": "BTC ",  // ₿
  // Misc
  "\u2116": "No.",   // №
  "\u00A0": " ",     // NBSP -> regular space
};

/** Returns true when every char in `s` is within WinAnsi range. */
export function isWinAnsiSafe(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0xff) return false;
  }
  return true;
}

export function winansiSafe(s: unknown): string {
  if (s === null || s === undefined) return "";
  let str = typeof s === "string" ? s : String(s);
  if (isWinAnsiSafe(str)) return str;

  let out = "";
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0xff) {
      out += ch;
      continue;
    }
    const repl = REPLACEMENTS[ch];
    if (repl !== undefined) {
      out += repl;
      continue;
    }
    out += "?";
  }
  return out;
}
