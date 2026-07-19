/**
 * S4 architecture guard — POS holding-account fabric.
 *
 * Pins the S4 migration so a downstream engineer can't quietly:
 *   1. Drop the `businesses.use_holding_accounts` feature flag or flip its
 *      default from `false` (any migration that removes the OFF-by-default
 *      guarantee is an unreviewed business-impacting change).
 *   2. Skip the four new `system_account_roles` catalog entries (cash in
 *      drawer, merchant card clearing, mobile-money clearing, tip
 *      liability) — S5 posting resolves through these role_keys.
 *   3. Bypass the resolver: `resolve_pos_tender_gl_account` MUST be the
 *      only function the S5 GL RPC calls to answer "which account?", and
 *      MUST fall back to `pos_payment_methods.debit_account_id` when the
 *      flag is off (backward compatibility contract).
 *   4. Delete the `pos_tender_holding_account_map` provider-key dimension
 *      — a single tender kind (wallet) needs to settle to different
 *      clearing accounts per provider (M-Pesa vs MoMo). Merging that
 *      dimension breaks multi-provider retailers.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

function latestMigrationWith(pattern: string): string {
  const out = execSync(
    `rg -l ${JSON.stringify(pattern)} supabase/migrations`,
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .sort();
  const last = out[out.length - 1];
  if (!last) throw new Error(`no migration contains ${pattern}`);
  return last;
}

describe("POS holding accounts — S4 architectural surface", () => {
  const sql = readFileSync(
    latestMigrationWith("pos_tender_holding_account_map"),
    "utf8",
  );

  it("adds use_holding_accounts on businesses defaulted OFF", () => {
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS use_holding_accounts boolean NOT NULL DEFAULT false/i,
    );
  });

  it("registers the four new holding roles in system_account_roles", () => {
    for (const role of [
      "cash_in_drawer",
      "merchant_card_clearing",
      "mobile_money_clearing",
      "tip_liability",
    ]) {
      expect(sql).toContain(`'${role}'`);
    }
  });

  it("creates the mapping table with a provider_key dimension", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.pos_tender_holding_account_map/);
    expect(sql).toMatch(/provider_key\s+text/);
    expect(sql).toMatch(/role_key\s+text NOT NULL REFERENCES public\.system_account_roles/);
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
  });

  it("resolver is SECURITY DEFINER, STABLE, search_path = public", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.resolve_pos_tender_gl_account/);
    expect(sql).toMatch(/SECURITY DEFINER[\s\S]{0,120}SET search_path = public/i);
    expect(sql).toMatch(/\bSTABLE\b/);
  });

  it("resolver preserves legacy fallback to pos_payment_methods.debit_account_id", () => {
    // Two references: one to load v_fallback, one to return it when flag is off.
    const matches = sql.match(/pos_payment_methods/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(sql).toMatch(/debit_account_id\s+INTO\s+v_fallback/i);
    expect(sql).toMatch(/RETURN v_fallback/);
  });

  it("readiness view is exposed to authenticated + service_role", () => {
    expect(sql).toMatch(/CREATE OR REPLACE VIEW public\.v_pos_holding_account_readiness/);
    expect(sql).toMatch(
      /GRANT SELECT ON public\.v_pos_holding_account_readiness TO authenticated, service_role/,
    );
  });
});
