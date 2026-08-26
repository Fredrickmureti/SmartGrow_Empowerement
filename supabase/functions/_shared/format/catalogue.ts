/**
 * currencyCatalogue (edge mirror) — the ONE source of currency presentation
 * facts for every server-rendered artifact (report PDFs, document PDFs,
 * payroll documents, CSV/XLSX exports).
 *
 * Mirrors `src/lib/currency/catalogue.ts` entry for entry: the screen and the
 * archived PDF must state the same figure in the same units. The client
 * module cannot be imported by Deno and the edge module cannot be imported by
 * Vite, so the rule lives in one shape in two runtimes, pinned by a parity
 * test (`src/test/architecture/currency-catalogue-parity.test.ts`).
 *
 * Precedence: tenant catalogue (`public.currencies`) → ISO 4217 minor units →
 * two decimals. Presentation only; never arithmetic.
 */

/** ISO 4217 currencies whose minor unit is not 2. Everything else is 2. */
export const ISO_MINOR_UNITS: Record<string, number> = {
  // Zero-decimal currencies
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, IDR: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // Three-decimal currencies
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

/** Symbols used before the tenant catalogue loads (and for unknown codes). */
export const SEED_SYMBOLS: Record<string, string> = {
  USD: "$", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥",
  KES: "KSh", UGX: "USh", TZS: "TSh", NGN: "₦",
  ZAR: "R", GHS: "GH₵", INR: "₹", AUD: "A$", CAD: "C$",
  CHF: "CHF", SEK: "kr", NOK: "kr", DKK: "kr",
  BRL: "R$", MXN: "Mex$", ARS: "AR$", COP: "$",
  AED: "د.إ", SAR: "﷼", QAR: "ر.ق", KWD: "د.ك",
  SGD: "S$", HKD: "HK$", NZD: "NZ$", PHP: "₱", THB: "฿",
  MYR: "RM", IDR: "Rp", VND: "₫", KRW: "₩", TWD: "NT$",
  EGP: "E£", MAD: "MAD", XOF: "CFA", XAF: "FCFA",
  RWF: "RF", ETB: "Br", BWP: "P", MWK: "MK", ZMW: "ZK",
};

export interface CurrencyCatalogueRow {
  code: string;
  symbol?: string | null;
  decimal_places?: number | null;
}

const runtime = new Map<string, { symbol: string; decimals: number }>();
let loaded = false;

export function setCurrencyCatalogue(rows: CurrencyCatalogueRow[]): void {
  runtime.clear();
  for (const row of rows) {
    if (!row?.code) continue;
    const code = row.code.toUpperCase();
    runtime.set(code, {
      symbol: (row.symbol || "").trim() || code,
      decimals:
        typeof row.decimal_places === "number" && row.decimal_places >= 0
          ? row.decimal_places
          : isoDecimals(code),
    });
  }
  loaded = runtime.size > 0;
}

export function resetCurrencyCatalogue(): void {
  runtime.clear();
  loaded = false;
}

/**
 * Load the tenant catalogue once per isolate. A failure is not fatal: the ISO
 * table already gives correct minor units, so the artifact still renders in
 * the right units with seed symbols.
 */
// deno-lint-ignore no-explicit-any
export async function loadCurrencyCatalogue(supabase: any): Promise<void> {
  if (loaded) return;
  try {
    const { data, error } = await supabase
      .from("currencies")
      .select("code, symbol, decimal_places")
      .eq("is_active", true);
    if (error || !data?.length) return;
    setCurrencyCatalogue(data as CurrencyCatalogueRow[]);
  } catch (_e) {
    // Presentation degrades to the ISO table; never blocks a document.
  }
}

function isoDecimals(code: string): number {
  return ISO_MINOR_UNITS[code] ?? 2;
}

export function getCurrencyDecimals(code?: string | null): number {
  if (!code) return 2;
  const upper = code.toUpperCase();
  return runtime.get(upper)?.decimals ?? isoDecimals(upper);
}

export function getCurrencySymbolRaw(code?: string | null): string {
  if (!code) return "";
  const upper = code.toUpperCase();
  return runtime.get(upper)?.symbol ?? SEED_SYMBOLS[upper] ?? upper;
}

export function getCurrencyPrefix(code?: string | null): string {
  const symbol = getCurrencySymbolRaw(code);
  if (!symbol) return "";
  return /[\p{L}.]$/u.test(symbol) ? `${symbol} ` : symbol;
}

export function formatCurrencyDigits(value: number, code?: string | null): string {
  const decimals = getCurrencyDecimals(code);
  return Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
