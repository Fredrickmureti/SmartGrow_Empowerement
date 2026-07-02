/**
 * E.164 phone normalization for SMS.
 *
 * Why no libphonenumber-js? It's ~80KB. For ERP SMS we only need:
 *  1. Strip formatting (spaces, dashes, parens, dots).
 *  2. Convert leading 00 to +.
 *  3. Apply a default country code when the number has no +.
 *  4. Validate against E.164 grammar (+, then 8-15 digits).
 */

/**
 * ISO 3166-1 alpha-2 country code → calling code map for the most common ones.
 * Add more as tenants need them. Falls back to passing through `+` numbers as-is.
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

/**
 * Best-effort E.164 normalization.
 * Returns the normalized number or `null` if it cannot be coerced into a valid E.164 string.
 *
 * @param input  Raw user input (e.g. "+1 (555) 123-4567", "0712345678")
 * @param defaultCountry  ISO alpha-2 to use when input has no leading "+" or "00"
 */
export function normalizeE164(
  input: string | null | undefined,
  defaultCountry?: string,
): string | null {
  if (!input) return null;
  let s = String(input).trim();
  if (!s) return null;

  // Strip every char that is not + or digit
  s = s.replace(/[^\d+]/g, "");

  // 00xx → +xx (international prefix used in much of Europe/Africa/Asia)
  if (s.startsWith("00")) s = "+" + s.slice(2);

  if (!s.startsWith("+")) {
    // Apply default country
    const cc = defaultCountry ? CALLING_CODES[defaultCountry.toUpperCase()] : undefined;
    if (!cc) return null;

    // Strip a single leading "0" (national trunk prefix in many countries)
    if (s.startsWith("0")) s = s.slice(1);

    s = "+" + cc + s;
  }

  return isValidE164(s) ? s : null;
}

/** Strict E.164 check: leading +, then 8 to 15 digits, first digit non-zero. */
export function isValidE164(s: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(s);
}

/** Mask a phone for display in logs/UI: keep first 4 and last 2. */
export function maskPhone(phone: string): string {
  if (!phone) return "";
  if (phone.length <= 6) return "****" + phone.slice(-2);
  return phone.slice(0, 4) + "****" + phone.slice(-2);
}
