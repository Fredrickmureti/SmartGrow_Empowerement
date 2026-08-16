/**
 * Architecture guard — Landed Cost.
 *
 * The landed cost module is a *client of* the canonical engines, never a
 * second implementation of them:
 *
 *   - status transitions (allocate / post / reverse) are database RPCs;
 *     the browser never writes `status`, `posted_at`, `journal_entry_id`;
 *   - money is never converted in the browser — no `* exchangeRate` maths,
 *     no rate literal, no currency literal list;
 *   - inventory valuation and journal rows are produced by the server
 *     (`inventory_apply_cost_revaluation`, `post_journal_entry_atomic`);
 *   - capitalisation treatment and expense accounts come from the component
 *     type catalog, never from hardcoded account codes.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import path from "path";

const DIR = path.resolve(process.cwd(), "src/features/purchases/landed-costs");

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
  .map((f) => ({ name: f, source: readFileSync(path.join(DIR, f), "utf8") }));

const RPC_WRAPPER = "landedCostRpcs.ts";

describe("landed cost architecture", () => {
  it("has source files to guard", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("never writes voucher lifecycle columns from the browser", () => {
    const forbidden = /\.update\(\s*\{[^}]*\b(status|posted_at|posted_by|journal_entry_id|allocated_at|capitalized_amount|expensed_amount|approval_request_id)\b/s;
    for (const f of files) {
      expect(
        forbidden.test(f.source),
        `${f.name} mutates a server-owned lifecycle column — use an RPC in ${RPC_WRAPPER}`,
      ).toBe(false);
    }
  });

  it("routes every lifecycle transition through the RPC wrapper", () => {
    for (const f of files) {
      if (f.name === RPC_WRAPPER) continue;
      expect(
        /supabase\.rpc\(\s*["'`]landed_cost_/.test(f.source),
        `${f.name} calls a landed cost RPC directly — go through ${RPC_WRAPPER}`,
      ).toBe(false);
    }
  });

  it("never touches journal or stock tables from the browser", () => {
    const tables = [
      "journal_entries",
      "journal_entry_lines",
      "stock_movements",
      "stock_quants",
      "cost_layers",
    ];
    for (const f of files) {
      for (const t of tables) {
        expect(
          f.source.includes(`from("${t}")`),
          `${f.name} reads/writes ${t} directly — that is server territory`,
        ).toBe(false);
      }
    }
  });

  it("does not convert currency in the browser", () => {
    for (const f of files) {
      expect(
        /\*\s*(exchangeRate|exchange_rate|fxRate)\b/.test(f.source),
        `${f.name} multiplies by an exchange rate — the server stamps base amounts`,
      ).toBe(false);
      expect(
        /(exchange_?[Rr]ate)\s*[:=]\s*1\b/.test(f.source),
        `${f.name} falls back to a 1:1 rate — a missing rate must surface, never default`,
      ).toBe(false);
    }
  });

  it("carries no hardcoded currency or account-code literals", () => {
    for (const f of files) {
      expect(
        /["'](KES|USD|EUR|GBP)["']/.test(f.source),
        `${f.name} hardcodes a currency code — read it from the business/currency catalog`,
      ).toBe(false);
      expect(
        /account_code\s*[:=]\s*["']\d/.test(f.source),
        `${f.name} hardcodes an account code — resolve accounts through the catalog/settings`,
      ).toBe(false);
    }
  });

  it("does not decide capitalisation treatment in the browser", () => {
    for (const f of files) {
      if (f.name === "LandedCostComponentTypesPage.tsx") continue; // the catalog editor sets it
      expect(
        /is_capitalizable\s*[:=]\s*(true|false)\b/.test(f.source),
        `${f.name} hardcodes a capitalisation flag — it belongs to the component type catalog`,
      ).toBe(false);
    }
  });
  it("does not keep a competing landed-cost total in the browser", () => {
    for (const f of files) {
      // Money and lifecycle counts come from the server-side aggregates
      // (landed_cost_workspace_summary / _clearing_exposure / _receipt_summary),
      // never from a reduce over whichever page of rows the client holds.
      expect(
        /\.reduce\((?:[^)]*)(capitalized_amount|expensed_amount|total_base_amount|allocated_amount)/.test(
          f.source,
        ),
        `${f.name} sums landed-cost money client-side — read a server-side aggregate instead`,
      ).toBe(false);
      expect(
        /rows\.filter\([^)]*\)\.length/.test(f.source),
        `${f.name} counts lifecycle buckets from a paged row set — use landed_cost_workspace_summary`,
      ).toBe(false);
    }
  });
});
