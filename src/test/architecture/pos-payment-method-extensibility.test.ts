import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Phase B (Wave 2) — Payment method catalog extensibility guard.
 *
 * Contract: `pos_payment_methods` is the SINGLE SOURCE OF TRUTH for tender
 * behavior. PaymentDialog must route by capability metadata
 * (tender_kind / capture_mode / provider_key), NEVER by hardcoded method_key
 * strings. Adding a new payment method (gift card, BNPL, wallet) must be a
 * migration + optional tender panel — never a PaymentDialog edit.
 *
 * See docs/architecture/POS_CHECKOUT_ENGINE.md § "Extensibility contract".
 */
describe("POS PaymentDialog is catalog-driven (Phase B)", () => {
  const dialogPath = resolve(__dirname, "../../components/pos/PaymentDialog.tsx");
  const src = readFileSync(dialogPath, "utf8");

  const BUILT_IN_METHOD_KEYS = [
    "cash",
    "card",
    "mobile_money",
    "bank_transfer",
    "voucher",
    "credit",
  ];

  it("does not gate behavior on hardcoded method_key string equality", () => {
    // Strip strings that legitimately construct payment objects for the
    // C2B fallback (method_key mirror only, method resolved from catalog).
    // We look for control-flow patterns: `selectedMethod === "cash"`,
    // `method_key === "credit"`, `.some(m => m.method_key === "mpesa")`, etc.
    for (const key of BUILT_IN_METHOD_KEYS) {
      const patterns = [
        new RegExp(`selectedMethod\\s*===\\s*["']${key}["']`),
        new RegExp(`method_key\\s*===\\s*["']${key}["']`),
        new RegExp(`\\.method_key\\s*===\\s*["']${key}["']`),
      ];
      for (const re of patterns) {
        expect(re.test(src), `PaymentDialog contains hardcoded method_key comparison for '${key}' (${re}); route via tender_kind/capture_mode/provider_key instead.`).toBe(false);
      }
    }
  });

  it("references the extensibility contract fields", () => {
    // The dialog must actually consult catalog metadata. If none of these
    // fields are read the routing is by accident, not by design.
    expect(src).toMatch(/tender_kind/);
    expect(src).toMatch(/capture_mode|provider_key/);
  });

  it("resolves cash/credit/wallet method keys from the catalog, not literals", () => {
    // Guards against silently regressing to `method: "cash"` etc. Any
    // payment line constructed with a hardcoded built-in method key is a
    // regression unless it is a documented fallback (annotated with
    // `?? "..."` for offline safety).
    for (const key of BUILT_IN_METHOD_KEYS) {
      const hardcoded = new RegExp(`method:\\s*["']${key}["']\\s*,`);
      expect(hardcoded.test(src), `PaymentDialog builds a payment line with hardcoded method: "${key}" — resolve it from the catalog (e.g. cashMethod.method_key).`).toBe(false);
    }
  });
});
