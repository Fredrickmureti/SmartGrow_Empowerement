/**
 * ADR 0136 — one FX engine, no silent 1:1.
 *
 * Ratchet guard. The browser may DISPLAY a rate; it may never invent one, and
 * there may be exactly one client-side lookup (`@/services/fx/rateBook`).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRateFromBook, convertWithBook, type RateBookRow } from "@/services/fx/rateBook";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const ROWS: RateBookRow[] = [
  { from_currency: "USD", to_currency: "KES", rate: 130, effective_date: "2026-08-01", source: "provider" },
  { from_currency: "USD", to_currency: "KES", rate: 128, effective_date: "2026-08-01", source: "override" },
  { from_currency: "EUR", to_currency: "KES", rate: 140, effective_date: "2026-07-01", source: "provider" },
];

describe("rateBook — the single client lookup", () => {
  it("returns null (never 1) when no rate is on file", () => {
    expect(resolveRateFromBook(ROWS, "JPY", "GBP", "2026-08-12", "KES")).toBeNull();
    expect(convertWithBook(ROWS, 100, "JPY", "GBP", "2026-08-12", "KES")).toBeNull();
  });

  it("returns 1 only for an identical pair", () => {
    expect(resolveRateFromBook(ROWS, "KES", "KES")).toBe(1);
  });

  it("honours source precedence: override beats provider on the same date", () => {
    expect(resolveRateFromBook(ROWS, "USD", "KES", "2026-08-12", "KES")).toBe(128);
  });

  it("ignores rows effective after the as-of date", () => {
    expect(resolveRateFromBook(ROWS, "USD", "KES", "2026-07-15", "KES")).toBeNull();
  });

  it("inverts a reverse pair", () => {
    expect(resolveRateFromBook(ROWS, "KES", "USD", "2026-08-12", "KES")).toBeCloseTo(1 / 128, 10);
  });

  it("triangulates through the base-currency pivot", () => {
    // EUR→KES 140, USD→KES 128  ⇒  EUR→USD = 140/128
    expect(resolveRateFromBook(ROWS, "EUR", "USD", "2026-08-12", "KES")).toBeCloseTo(140 / 128, 10);
  });
});

describe("no parallel client FX engines", () => {
  it("useTenantFx delegates to the shared rate book and reads the accounting book", () => {
    const src = read("src/hooks/useTenantFx.ts");
    expect(src).toMatch(/resolveRateFromBook/);
    expect(src).toMatch(/from\("exchange_rates"\)/);
    expect(src).not.toMatch(/platform_exchange_rates/);
  });

  it("CurrencyContext delegates to the shared rate book", () => {
    const src = read("src/contexts/CurrencyContext.tsx");
    expect(src).toMatch(/resolveRateFromBook/);
  });

  it("tenant-entered rates are written as overrides, never as provider rows", () => {
    const src = read("src/contexts/CurrencyContext.tsx");
    expect(src).toMatch(/source:\s*"override"/);
  });

  it("useAdminCurrency carries no hardcoded rate literal and no silent 1 fallback", () => {
    const src = read("src/hooks/useAdminCurrency.ts");
    expect(src).not.toMatch(/129\.5/);
    expect(src).toMatch(/usdToTargetRate[\s\S]{0,900}return null;|usdToTargetRate[\s\S]{0,900}resolveRateFromBook/);
  });

  it("useAdminCurrency resolves through the shared rate book, not its own lookup", () => {
    const src = read("src/hooks/useAdminCurrency.ts");
    expect(src).toMatch(/resolveRateFromBook/);
    // No hand-rolled direct/reverse pair lookup may survive in the resolver.
    expect(src).not.toMatch(/from_currency === "USD" && r\.to_currency/);
  });
});

describe("platform billing normalisation", () => {
  it("has exactly one USD normalisation helper, delegating to the rate book", () => {
    const helper = read("src/services/fx/platformUsd.ts");
    expect(helper).toMatch(/resolveRateFromBook/);
    for (const f of ["src/hooks/usePlatformAdmin.ts", "src/pages/admin/AdminAnalytics.tsx"]) {
      const src = read(f);
      expect(src).toMatch(/@\/services\/fx\/platformUsd/);
      // No local toUSD engine may be reintroduced.
      expect(src).not.toMatch(/function toUSD\(/);
    }
  });

  it("an unconvertible amount is excluded, never counted at 1:1", () => {
    const helper = read("src/services/fx/platformUsd.ts");
    expect(helper).toMatch(/return rate === null \? null : amount \* rate;/);
    expect(helper).not.toMatch(/return amount;/);
  });
});

describe("FX admin surface (ADR 0136 provenance)", () => {
  const settings = read("src/components/settings/CurrencySettings.tsx");

  it("tenant overrides are written through the guarded server RPC only", () => {
    expect(settings).toMatch(/set_exchange_rate_override/);
    expect(settings).not.toMatch(/from\("exchange_rates"\)[\s\S]{0,120}\.insert\(/);
  });

  it("the rate book is displayed with its provenance", () => {
    expect(settings).toMatch(/source/);
    expect(settings).toMatch(/provider_key/);
    expect(settings).toMatch(/published_at/);
  });

  it("operating currencies are toggled through the guarded server RPC only", () => {
    expect(settings).toMatch(/set_business_active_currency/);
    expect(settings).not.toMatch(/from\("business_active_currencies"\)[\s\S]{0,160}\.(insert|update|upsert|delete)\(/);
  });

  it("the enabled set and the base flag are resolved server-side", () => {
    expect(settings).toMatch(/list_business_active_currencies/);
    expect(settings).not.toMatch(/from\("business_active_currencies"\)/);
  });
});


describe("FX exposure reporting is a server-side projection", () => {
  const hook = read("src/hooks/finance/useFxExposure.ts");
  const page = read("src/pages/reports/FxExposureReport.tsx");

  it("reads exposure only through the guarded server RPCs", () => {
    expect(hook).toMatch(/fx_exposure_by_currency/);
    expect(hook).toMatch(/fx_exposure_open_items/);
    // No client-side rate book read, no direct table access.
    expect(hook).not.toMatch(/from\("exchange_rates"\)/);
    expect(hook).not.toMatch(/from\("journal_entry_lines"\)/);
  });

  it("the exposure surface computes no rate and no conversion of its own", () => {
    expect(page).not.toMatch(/from\("exchange_rates"\)/);
    expect(page).not.toMatch(/resolveRateFromBook|convertWithBook/);
    // A missing rate must render as an absence, never as 1.
    expect(page).toMatch(/No rate on file/);
    expect(page).not.toMatch(/rate\s*\?\?\s*1\b/);
  });
});

describe("realized FX reporting is a projection of the ledger, not a second engine", () => {
  const hook = read("src/hooks/finance/useFxRealized.ts");
  const page = read("src/pages/reports/FxRealizedReport.tsx");

  it("reads realized FX only through the guarded server RPC", () => {
    expect(hook).toMatch(/fx_realized_gain_loss/);
    expect(hook).not.toMatch(/from\("exchange_rates"\)/);
    expect(hook).not.toMatch(/from\("journal_entry_lines"\)/);
  });

  it("the realized surface resolves no rate and computes no posted amount", () => {
    expect(page).not.toMatch(/from\("exchange_rates"\)/);
    expect(page).not.toMatch(/from\("journal_entry_lines"\)/);
    expect(page).not.toMatch(/resolveRateFromBook|convertWithBook/);
    expect(page).not.toMatch(/rate\s*\?\?\s*1\b/);
  });
});



describe("the revaluation run owns neither its reporting currency nor its FX accounts", () => {
  const hook = read("src/hooks/finance/useFxRevaluation.ts");
  const panel = read("src/components/finance/FinanceAccountingControls.tsx");

  it("the browser sends no base currency and no gain/loss account to the engine", () => {
    expect(hook).toMatch(/revalue_fx_balances/);
    expect(hook).not.toMatch(/_base_currency/);
    expect(hook).not.toMatch(/_unrealized_gain_account|_unrealized_loss_account/);
  });

  it("the control panel offers no free-text base currency and no per-run account pickers", () => {
    expect(panel).not.toMatch(/placeholder="Base currency"/);
    expect(panel).not.toMatch(/placeholder="Unrealized (gain|loss) account"/);
  });
});

describe("exposure dimensions are a projection, not a second engine", () => {
  const hook = read("src/hooks/finance/useFxExposure.ts");
  const page = read("src/pages/reports/FxExposureReport.tsx");

  it("counterparty and ageing cuts come from the server function", () => {
    expect(hook).toMatch(/fx_exposure_dimensions/);
    expect(hook).not.toMatch(/from\("exchange_rates"\)/);
    expect(hook).not.toMatch(/resolveRateFromBook|convertWithBook/);
  });

  it("the browser neither resolves a rate nor buckets the ageing itself", () => {
    expect(page).not.toMatch(/resolveRateFromBook|convertWithBook/);
    expect(page).not.toMatch(/rate\s*\?\?\s*1\b/);
    expect(page).not.toMatch(/0-30|31-60|61-90/);
  });
});

describe("ADR 0136 §4 — no call site supplies a posting rate", () => {
  const walk = (dir: string): string[] => {
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    return readdirSync(dir).flatMap((entry: string) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return /\.(ts|tsx)$/.test(full) ? [full] : [];
    });
  };
  const root = join(process.cwd(), "src");
  const appFiles = walk(root).filter(
    (f) => !f.includes("/test/") && !f.includes("__tests__") && !f.endsWith("types.ts"),
  );

  // Settlement RPCs resolve their own rate server-side and REJECT a supplied one,
  // so a call site that still passes it would fail at runtime.
  const SETTLEMENT_RPCS = [
    "record_multi_invoice_payment",
    "record_multi_bill_payment",
    "apply_credit_to_invoice_atomic",
    "refund_customer_atomic",
    "refund_from_vendor_atomic",
    "pos_payment_session_open",
  ];

  it("no client call passes _exchange_rate or p_fx_rate to a settlement RPC", () => {
    const offenders = appFiles.filter((f) => {
      const src = read(f.replace(`${process.cwd()}/`, ""));
      if (!SETTLEMENT_RPCS.some((rpc) => src.includes(rpc))) return false;
      return /(\b_exchange_rate|\bp_fx_rate)\s*:/.test(src);
    });
    expect(offenders.map((f) => f.replace(`${process.cwd()}/`, ""))).toEqual([]);
  });


  it("the POS session client no longer carries an fxRate input", () => {
    const client = read("src/lib/pos/paymentSessionClient.ts");
    expect(client).not.toMatch(/fxRate/);
    expect(client).toMatch(/resolved server-side/);
  });
});

describe("Phase 8 ratchet — a missing rate is an absence, never a substitute", () => {
  const OPEN_ITEMS = "src/services/finance/openItems.ts";

  it("open items never substitute a foreign amount for a missing base amount", () => {
    const src = read(OPEN_ITEMS);
    // The removed silent 1:1 conversion, in any of its shapes.
    expect(src).not.toMatch(/base_credit_amount\s*\?\?\s*\w*credit_amount/);
    expect(src).not.toMatch(/base_credit_amount\s*\|\|\s*\w*credit_amount/);
    expect(src).not.toMatch(/base_(credit_)?amount\s*\?\?\s*amount\b/);
  });

  it("open items type base amounts as nullable and skip unrated rows in totals", () => {
    const src = read(OPEN_ITEMS);
    expect(src).toMatch(/base_credit_amount:\s*number\s*\|\s*null/);
    expect(src).toMatch(/base_credit_amount === null/);
  });

  it("no app file coerces a null base amount to the foreign amount", () => {
    const walk = (dir: string): string[] => {
      const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
      return readdirSync(dir).flatMap((entry: string) => {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) return walk(full);
        return /\.(ts|tsx)$/.test(full) ? [full] : [];
      });
    };
    const appFiles = walk(join(process.cwd(), "src")).filter(
      (f) => !f.includes("/test/") && !f.includes("__tests__"),
    );
    const offenders = appFiles.filter((f) => {
      const src = read(f.replace(`${process.cwd()}/`, ""));
      return /base_(credit_|debit_|)amount[a-z_]*\s*(\?\?|\|\|)\s*(?!null|0\b)[a-z_]*amount/i.test(src);
    });
    expect(offenders.map((f) => f.replace(`${process.cwd()}/`, ""))).toEqual([]);
  });

  it("the client rate book still refuses to invent a rate", () => {
    const src = read("src/services/fx/rateBook.ts");
    expect(src).not.toMatch(/\?\?\s*1\b/);
    expect(src).not.toMatch(/return\s+1;\s*\/\/\s*fallback/i);
  });
});
