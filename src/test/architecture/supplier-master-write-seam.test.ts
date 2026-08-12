/**
 * Supplier master — write-seam and picker-gate guards.
 *
 * Two invariants of the supplier/vendor domain (ADR-0079):
 *
 *  1. The client never mutates the supplier role tables directly. Lifecycle,
 *     terms, banking, compliance, ASL and item terms all move through
 *     SECURITY DEFINER RPCs so `business_event_outbox` and the audit tables
 *     stay authoritative.
 *  2. Purchase document pages never offer a raw contact-typed vendor list.
 *     Vendor pickers read `usePurchasableVendors`, which subtracts suspended,
 *     blocked and archived supplier roles — the same rule the database gate
 *     triggers enforce server-side.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();

/** Role tables that may only be written by RPC. */
const ROLE_TABLES = [
  "suppliers",
  "supplier_qualifications",
  "supplier_qualification_documents",
  "supplier_compliance_checks",
  "supplier_bank_accounts",
  "supplier_item_terms",
  "supplier_terms_changes",
  "supplier_lifecycle_events",
  "approved_supplier_list",
] as const;

const WRITE_OPS = ["insert", "update", "upsert", "delete"] as const;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

const SOURCES = [
  ...walk(join(ROOT, "src/features")),
  ...walk(join(ROOT, "src/hooks")),
  ...walk(join(ROOT, "src/pages")),
  ...walk(join(ROOT, "src/components")),
  ...walk(join(ROOT, "src/lib")),
];

describe("supplier master — client writes go through RPCs", () => {
  it("no .from(<supplier role table>).insert/update/upsert/delete anywhere in the client", () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      const src = readFileSync(file, "utf8");
      for (const table of ROLE_TABLES) {
        const re = new RegExp(
          `\\.from\\(\\s*["']${table}["']\\s*\\)[\\s\\S]{0,200}?\\.(${WRITE_OPS.join("|")})\\(`,
          "g",
        );
        if (re.test(src)) {
          offenders.push(`${file.replace(ROOT + "/", "")}: writes ${table}`);
        }
      }
    }
    expect(
      offenders.join("\n") && offenders,
      `Supplier role tables are RPC-only. Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the retired vendor_pricelists compatibility view has no callers left", () => {
    const offenders = SOURCES.filter(
      (f) =>
        !f.endsWith("src/integrations/supabase/types.ts") &&
        /vendor_pricelists/.test(readFileSync(f, "utf8")),
    ).map((f) => f.replace(ROOT + "/", ""));
    expect(offenders).toEqual([]);
  });
});

describe("purchase documents — vendor pickers use the purchasable gate", () => {
  const PICKER_PAGES = [
    "src/features/purchases/orders/PurchaseOrderCreatePage.tsx",
    "src/features/purchases/orders/PurchaseOrderEditPage.tsx",
    "src/features/purchases/bills/BillCreatePage.tsx",
    "src/features/purchases/bills/BillEditPage.tsx",
    "src/features/purchases/rfqs/RFQCreatePage.tsx",
    "src/features/purchases/rfqs/RFQEditPage.tsx",
    "src/features/purchases/credit-notes/VendorCreditNoteCreatePage.tsx",
    "src/features/purchases/credit-notes/VendorCreditNoteEditPage.tsx",
    "src/features/purchases/returns/PurchaseReturnCreatePage.tsx",
    "src/features/purchases/expenses/ExpenseCreatePage.tsx",
    "src/features/purchases/expenses/ExpenseEditPage.tsx",
  ];

  it("every vendor-selecting purchases page imports usePurchasableVendors", () => {
    const offenders = PICKER_PAGES.filter(
      (rel) => !readFileSync(join(ROOT, rel), "utf8").includes("usePurchasableVendors"),
    );
    expect(offenders).toEqual([]);
  });

  it("no purchases page filters vendors by contact type inline", () => {
    const offenders: string[] = [];
    for (const rel of PICKER_PAGES) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      // Inline party-type filtering re-opens the gate the hook closes.
      if (/type\s*===\s*["']supplier["'][\s\S]{0,80}\|\|[\s\S]{0,40}["']both["']/.test(src)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
