/**
 * Purchase Returns, Phase 9 — architecture ratchets.
 *
 * The Purchase Returns subsystem is server-authoritative: `purchase_returns`
 * and `purchase_return_items` are SELECT-only for `authenticated`, stock leaves
 * the business only inside `purchase_return_dispatch`, and the vendor debit note
 * is minted only by `purchase_return_raise_credit` through the canonical
 * vendor-credit engine.
 *
 * These tests fail the build if application code re-acquires any of those
 * responsibilities:
 *   1. No client file writes the two return tables directly.
 *   2. No client file moves stock or posts journal lines for a return.
 *   3. No client file creates a vendor credit/debit note for a return.
 *   4. `purchaseReturnRpcs.ts` stays the single mutation surface — every
 *      `purchase_return_*` RPC call in the app is made from that module.
 *   5. Return numbers are never generated in the browser.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../");
const RPC_MODULE = "lib/purchases/purchaseReturnRpcs.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "test") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const rel = (p: string) => path.relative(SRC, p).replace(/\\/g, "/");
const FILES = walk(SRC).filter((f) => !/integrations\/supabase\/types\.ts$/.test(rel(f)));
const read = (f: string) => readFileSync(f, "utf8");

describe("Purchase Returns — architecture guards", () => {
  it("no client code writes purchase_returns / purchase_return_items directly", () => {
    const write =
      /\.from\(\s*["'`]purchase_return(s|_items|_events)["'`]\s*\)[\s\S]{0,300}?\.(insert|update|upsert|delete)\(/;
    const offenders = FILES.filter((f) => write.test(read(f))).map(rel);
    expect(offenders, "purchase return tables are RPC-only writes").toEqual([]);
  });

  it("no client code moves stock or posts journals for a purchase return", () => {
    const offenders = FILES.filter((f) => {
      const src = read(f);
      if (!/purchase_return/.test(src)) return false;
      return /\.from\(\s*["'`](stock_movements|stock_quants|journal_entries|journal_entry_lines|cost_layers)["'`]\s*\)[\s\S]{0,300}?\.(insert|update|upsert|delete)\(/.test(
        src,
      );
    }).map(rel);
    expect(
      offenders,
      "stock leaves only inside purchase_return_dispatch; journals only via the posting engine",
    ).toEqual([]);
  });

  it("no client code mints a vendor debit note for a purchase return", () => {
    const offenders = FILES.filter((f) => {
      const src = read(f);
      if (!/purchase_return/.test(src)) return false;
      return (
        /\.from\(\s*["'`](credit_notes|vendor_credit_notes|bill_payment_allocations)["'`]\s*\)[\s\S]{0,300}?\.(insert|update|upsert)\(/.test(
          src,
        ) || /rpc\(\s*["'`]create_vendor_credit_note_atomic["'`]/.test(src)
      );
    }).map(rel);
    expect(offenders, "use purchase_return_raise_credit instead").toEqual([]);
  });

  it("purchaseReturnRpcs.ts is the only caller of the purchase_return_* commands", () => {
    const call = /rpc\(\s*["'`]purchase_return_[a-z_]+["'`]/;
    const offenders = FILES.filter((f) => rel(f) !== RPC_MODULE)
      .filter((f) => call.test(read(f)))
      .map(rel);
    expect(offenders, `route lifecycle calls through @/${RPC_MODULE}`).toEqual([]);
  });

  it("return numbers are never generated in the browser", () => {
    const offenders = FILES.filter((f) => {
      const src = read(f);
      if (!/purchase_return|return_number/.test(src)) return false;
      return /return_number\s*[:=]\s*[`"']?(PR-|\$\{)/.test(src);
    }).map(rel);
    expect(offenders, "numbering belongs to get_next_purchase_return_number").toEqual([]);
  });

  it("the returned-quantity ledger is never recomputed in the browser", () => {
    // Received-vs-returned must come from `purchase_return_returnable_lines`
    // (the same ledger the server clamps against). A client-side SUM over
    // purchase_return_items would drift from the invariant it is meant to show.
    const offenders = FILES.filter((f) => {
      const src = read(f);
      if (!/purchase_return_items/.test(src)) return false;
      return /\.from\(\s*["'`]purchase_return_items["'`]\s*\)[\s\S]{0,400}?(sum\(|reduce\()/i.test(src);
    }).map(rel);
    expect(offenders, "read purchase_return_returnable_lines instead").toEqual([]);
  });

  it("the client status union carries no legacy lifecycle values", () => {
    const src = read(path.join(SRC, RPC_MODULE));
    const union = src.slice(
      src.indexOf("export type PurchaseReturnStatus"),
      src.indexOf("export type PurchaseReturnKind"),
    );
    expect(/["']pending["']/.test(union), "'pending' is no longer a legal status").toBe(false);
    expect(/["']processed["']/.test(union), "'processed' is no longer a legal status").toBe(false);
  });
});
