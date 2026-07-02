/**
 * Edge-function copy of src/lib/sms/phone.ts (Deno-safe, no React/Vite imports).
 * Keep these two files in sync.
 */

const CALLING_CODES: Record<string, string> = {
  US: "1", CA: "1", GB: "44", IE: "353", AU: "61", NZ: "64",
  DE: "49", FR: "33", ES: "34", IT: "39", NL: "31", BE: "32",
  CH: "41", AT: "43", SE: "46", NO: "47", DK: "45", FI: "358",
  PL: "48", PT: "351", GR: "30", CZ: "420",
  KE: "254", UG: "256", TZ: "255", RW: "250", ET: "251", NG: "234",
  GH: "233", ZA: "27", EG: "20", MA: "212", DZ: "213", TN: "216",
  IN: "91", PK: "92", BD: "880", LK: "94",
  CN: "86", JP: "81", KR: "82", TW: "886", HK: "852", SG: "65",
  MY: "60", TH: "66", VN: "84", ID: "62", PH: "63",
  AE: "971", SA: "966", IL: "972", TR: "90", QA: "974",
  BR: "55", MX: "52", AR: "54", CL: "56", CO: "57", PE: "51",
};

export function normalizeE164(
  input: string | null | undefined,
  defaultCountry?: string,
): string | null {
  if (!input) return null;
  let s = String(input).trim();
  if (!s) return null;
  s = s.replace(/[^\d+]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (!s.startsWith("+")) {
    const cc = defaultCountry ? CALLING_CODES[defaultCountry.toUpperCase()] : undefined;
    if (!cc) return null;
    if (s.startsWith("0")) s = s.slice(1);
    s = "+" + cc + s;
  }
  return isValidE164(s) ? s : null;
}

export function isValidE164(s: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(s);
}
