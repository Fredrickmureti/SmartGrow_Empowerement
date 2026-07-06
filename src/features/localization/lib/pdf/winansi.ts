/**
 * winansiSafe — browser mirror of
 * `supabase/functions/_shared/pdf/winansi.ts`.
 *
 * MUST remain byte-identical in logic to the Deno copy — see
 * `src/test/localization/certificateRenderer-parity.test.ts`. If you
 * change one, change the other in the same commit.
 */

const REPLACEMENTS: Record<string, string> = {
  "\u26A0": "[!]", "\u2705": "[ok]", "\u274C": "[x]",
  "\u2713": "v", "\u2717": "x",
  "\u2192": "->", "\u2190": "<-", "\u2194": "<->",
  "\u221E": "inf", "\u00D7": "x",
  "\uFE0F": "", "\u200D": "",
  "\u2013": "-", "\u2014": "-", "\u2212": "-",
  "\u2018": "'", "\u2019": "'", "\u201C": '"', "\u201D": '"',
  "\u2026": "...", "\u2022": "*", "\u00B7": "*",
  "\u20A6": "NGN ", "\u20A8": "Rs ", "\u20B9": "INR ",
  "\u20AB": "VND ", "\u20B1": "PHP ", "\u20B4": "UAH ",
  "\u20BD": "RUB ", "\u20BF": "BTC ",
  "\u2116": "No.", "\u00A0": " ",
};

export function isWinAnsiSafe(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0xff) return false;
  }
  return true;
}

export function winansiSafe(s: unknown): string {
  if (s === null || s === undefined) return "";
  const str = typeof s === "string" ? s : String(s);
  if (isWinAnsiSafe(str)) return str;
  let out = "";
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0xff) { out += ch; continue; }
    const repl = REPLACEMENTS[ch];
    if (repl !== undefined) { out += repl; continue; }
    out += "?";
  }
  return out;
}
