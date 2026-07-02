/**
 * Exchange-rate integration handlers.
 *
 * One module = one capability. Each provider exposes two operations:
 *   - test(creds): cheap call to verify credentials work.
 *   - fetchRates(creds, targets): returns { base, rates: { CODE: number } }.
 *
 * The orchestrator (`provider-run` edge fn) translates fetched rates into
 * upserts on `public.platform_exchange_rates` (USD-based).
 */

export type ExchangeRateMap = Record<string, number>;

export interface FetchResult {
  base: string;
  rates: ExchangeRateMap;
  asOf?: string;
}

export interface ProviderHandler {
  test(credentials: Record<string, string>): Promise<{ ok: boolean; message: string }>;
  fetch(credentials: Record<string, string>, targets: string[]): Promise<FetchResult>;
}

const TARGETS_DEFAULT = ["EUR", "GBP", "KES", "UGX", "TZS", "RWF", "ZAR", "INR", "NGN", "JPY", "CAD", "AUD"];

// ─── exchangerate.host (free, optional key) ────────────────────────────
const exchangerateHost: ProviderHandler = {
  async test(creds) {
    const url = `https://api.exchangerate.host/latest?base=USD&symbols=EUR${creds.api_key ? `&access_key=${creds.api_key}` : ""}`;
    const r = await fetch(url);
    if (!r.ok) return { ok: false, message: `HTTP ${r.status}` };
    const j = await r.json();
    if (j?.rates?.EUR) return { ok: true, message: "Connection OK" };
    return { ok: false, message: j?.error?.info || "Unexpected response" };
  },
  async fetch(creds, targets) {
    const symbols = targets.join(",");
    const url = `https://api.exchangerate.host/latest?base=USD&symbols=${symbols}${creds.api_key ? `&access_key=${creds.api_key}` : ""}`;
    const r = await fetch(url);
    const j = await r.json();
    if (!j?.rates) throw new Error(j?.error?.info || "No rates returned");
    return { base: "USD", rates: j.rates, asOf: j.date };
  },
};

// ─── openexchangerates.org ─────────────────────────────────────────────
const openExchangeRates: ProviderHandler = {
  async test(creds) {
    if (!creds.app_id) return { ok: false, message: "Missing App ID" };
    const r = await fetch(`https://openexchangerates.org/api/usage.json?app_id=${creds.app_id}`);
    if (!r.ok) return { ok: false, message: `HTTP ${r.status}` };
    const j = await r.json();
    if (j?.status === 200) return { ok: true, message: `Plan: ${j?.data?.plan?.name ?? "ok"}` };
    return { ok: false, message: j?.description || "Authentication failed" };
  },
  async fetch(creds, targets) {
    if (!creds.app_id) throw new Error("Missing App ID");
    const symbols = targets.join(",");
    const r = await fetch(
      `https://openexchangerates.org/api/latest.json?app_id=${creds.app_id}&base=USD&symbols=${symbols}`
    );
    const j = await r.json();
    if (!j?.rates) throw new Error(j?.description || "No rates returned");
    return { base: "USD", rates: j.rates, asOf: new Date(j.timestamp * 1000).toISOString() };
  },
};

// ─── fixer.io (free tier base = EUR; we triangulate to USD) ────────────
const fixer: ProviderHandler = {
  async test(creds) {
    if (!creds.access_key) return { ok: false, message: "Missing access key" };
    const r = await fetch(`https://data.fixer.io/api/latest?access_key=${creds.access_key}&symbols=USD,EUR`);
    if (!r.ok) return { ok: false, message: `HTTP ${r.status}` };
    const j = await r.json();
    if (j?.success) return { ok: true, message: "Connection OK" };
    return { ok: false, message: j?.error?.info || "Authentication failed" };
  },
  async fetch(creds, targets) {
    if (!creds.access_key) throw new Error("Missing access key");
    // Free plan forces base=EUR — fetch USD + targets, then re-base to USD.
    const symbols = Array.from(new Set([...targets, "USD"])).join(",");
    const r = await fetch(`https://data.fixer.io/api/latest?access_key=${creds.access_key}&symbols=${symbols}`);
    const j = await r.json();
    if (!j?.success || !j?.rates) throw new Error(j?.error?.info || "No rates returned");
    const eurToUsd = Number(j.rates.USD);
    if (!eurToUsd || !isFinite(eurToUsd)) throw new Error("Cannot triangulate without USD rate");
    const out: ExchangeRateMap = {};
    for (const [code, eurRate] of Object.entries(j.rates)) {
      if (code === "USD") continue;
      out[code] = Number(eurRate) / eurToUsd; // USD → code
    }
    return { base: "USD", rates: out, asOf: j.date };
  },
};

// ─── freecurrencyapi.com ───────────────────────────────────────────────
const freeCurrencyApi: ProviderHandler = {
  async test(creds) {
    if (!creds.api_key) return { ok: false, message: "Missing API key" };
    const r = await fetch(
      `https://api.freecurrencyapi.com/v1/status?apikey=${creds.api_key}`
    );
    if (!r.ok) return { ok: false, message: `HTTP ${r.status}` };
    const j = await r.json();
    if (j?.quotas) return { ok: true, message: `Quota: ${j.quotas.month?.remaining ?? "?"} left` };
    return { ok: false, message: j?.message || "Authentication failed" };
  },
  async fetch(creds, targets) {
    if (!creds.api_key) throw new Error("Missing API key");
    const r = await fetch(
      `https://api.freecurrencyapi.com/v1/latest?apikey=${creds.api_key}&base_currency=USD&currencies=${targets.join(",")}`
    );
    const j = await r.json();
    if (!j?.data) throw new Error(j?.message || "No rates returned");
    return { base: "USD", rates: j.data, asOf: new Date().toISOString() };
  },
};

export const HANDLERS: Record<string, ProviderHandler> = {
  exchangerate_host: exchangerateHost,
  openexchangerates: openExchangeRates,
  fixer: fixer,
  freecurrencyapi: freeCurrencyApi,
};

export function getHandler(providerKey: string): ProviderHandler {
  const h = HANDLERS[providerKey];
  if (!h) throw new Error(`Unknown exchange-rate provider: ${providerKey}`);
  return h;
}

export const DEFAULT_TARGETS = TARGETS_DEFAULT;
