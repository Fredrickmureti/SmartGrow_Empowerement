/**
 * Architecture guard — RFQ / Sourcing domain (Phase 5).
 *
 * Invariants enforced here (see the RFQ rebuild plan in `.lovable/plan.md`):
 *
 *  1. The legacy sourcing layer is GONE, not deprecated. No source file may
 *     reference `rfq_vendors`, `rfq_vendor_items`, or the retired
 *     `sourcing_events` engine. Retired means deleted — never a fallback.
 *  2. The browser never writes RFQ lifecycle state. All transitions go
 *     through server-side RPCs (`rfq_*`).
 *  3. RFQ never writes stock, cost layers, or the general ledger.
 *  4. Purchase orders born from an award carry reverse traceability
 *     (`rfq_id` + `rfq_award_id`), and conversion is guarded against
 *     partially-linked awards.
 *  5. The canonical lifecycle RPCs are declared in migrations.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const SRC = path.join(ROOT, "src");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

/** Application source, excluding generated types and this guard itself. */
function appSources(): string[] {
  return walk(SRC).filter(
    (p) =>
      !p.endsWith(path.join("integrations", "supabase", "types.ts")) &&
      !p.includes(path.join("test", "architecture")),
  );
}

/** Concatenated migration SQL (source of truth for RPC declarations). */
function migrationSql(): string {
  if (!existsSync(MIGRATIONS)) return "";
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(path.join(MIGRATIONS, f), "utf8"))
    .join("\n");
}

const RETIRED_IDENTIFIERS = [
  "rfq_vendors",
  "rfq_vendor_items",
  "sourcing_events",
  "sourcing_event_awards",
  "sourcing_scoring_criteria",
  "sourcing_vendor_scores",
  "sourcing_event_id",
  "create_sourcing_event",
  "open_sourcing_event",
  "close_sourcing_event",
  "score_sourcing_vendor",
  "award_sourcing_event_atomic",
  "award_rfq_atomic",
  "convert_rfq_to_po_atomic",
];

const CANONICAL_RFQ_RPCS = [
  "rfq_submit_for_approval",
  "rfq_approve",
  "rfq_release",
  "rfq_record_quotation",
  "rfq_withdraw_quotation",
  "rfq_award",
  "rfq_convert_awards_to_po",
  "rfq_revise",
  "rfq_cancel",
  "rfq_expire_due",
];

describe("RFQ sourcing domain — legacy retirement", () => {
  it("no application source references the retired sourcing layer", () => {
    const offenders: string[] = [];
    for (const file of appSources()) {
      const src = readFileSync(file, "utf8");
      for (const id of RETIRED_IDENTIFIERS) {
        if (src.includes(id)) {
          offenders.push(`${path.relative(ROOT, file)} -> ${id}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the retirement migration actually drops the legacy tables", () => {
    const sql = migrationSql();
    if (!sql) return;
    expect(sql).toContain("DROP TABLE IF EXISTS public.rfq_vendors");
    expect(sql).toContain("DROP TABLE IF EXISTS public.rfq_vendor_items");
    expect(sql).toContain("DROP TABLE IF EXISTS public.sourcing_events");
  });
});

describe("RFQ sourcing domain — server-side lifecycle", () => {
  it("the browser never writes rfqs.status or lifecycle stamps", () => {
    // A client-side status write looks like `.from("rfqs").update({ status ... })`
    // or an update touching awarded_at / released_at / converted_at.
    const offenders: string[] = [];
    const updateOnRfqs =
      /from\(\s*["'`]rfqs["'`]\s*\)[\s\S]{0,400}?\.update\(([\s\S]{0,400}?)\)/g;
    const forbiddenFields =
      /\b(status|released_at|released_by|awarded_at|awarded_by|approved_at|approved_by|converted_at|closed_at|cancelled_at|version)\b/;

    for (const file of appSources()) {
      const src = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      updateOnRfqs.lastIndex = 0;
      while ((m = updateOnRfqs.exec(src))) {
        if (forbiddenFields.test(m[1])) {
          offenders.push(path.relative(ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no client writes to the immutable sourcing record tables", () => {
    const IMMUTABLE = [
      "rfq_quotations",
      "rfq_quotation_items",
      "rfq_awards",
      "rfq_award_items",
      "rfq_revisions",
      // Phase 4b: bid evidence is written only by
      // rfq_attach_quotation_document / rfq_remove_quotation_attachment.
      "rfq_quotation_attachments",

    ];
    const offenders: string[] = [];
    for (const file of appSources()) {
      const src = readFileSync(file, "utf8");
      for (const table of IMMUTABLE) {
        const re = new RegExp(
          `from\\(\\s*["'\`]${table}["'\`]\\s*\\)[\\s\\S]{0,200}?\\.(insert|update|upsert|delete)\\(`,
          "g",
        );
        if (re.test(src)) offenders.push(`${path.relative(ROOT, file)} -> ${table}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every canonical RFQ lifecycle RPC is declared in a migration", () => {
    const sql = migrationSql();
    if (!sql) return;
    const missing = CANONICAL_RFQ_RPCS.filter(
      (fn) => !sql.includes(`FUNCTION public.${fn}(`),
    );
    expect(missing).toEqual([]);
  });
});

describe("RFQ sourcing domain — boundaries and traceability", () => {
  it("RFQ RPC bodies never touch stock, cost layers, or the ledger", () => {
    const sql = migrationSql();
    if (!sql) return;
    const FORBIDDEN = [
      "stock_quants",
      "stock_movements",
      "cost_layers",
      "journal_entries",
      "journal_entry_lines",
    ];
    // Slice each `CREATE ... FUNCTION public.rfq_*` body and scan it.
    const bodyRe =
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(rfq_[a-z_]+)\s*\(([\s\S]*?)\$\$;/g;
    const offenders: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = bodyRe.exec(sql))) {
      const [, fn, body] = m;
      for (const table of FORBIDDEN) {
        if (new RegExp(`\\b(public\\.)?${table}\\b`).test(body)) {
          offenders.push(`${fn} -> ${table}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("purchase orders carry reverse traceability to the RFQ and award", () => {
    const sql = migrationSql();
    if (!sql) return;
    expect(/purchase_orders[\s\S]{0,400}rfq_id/.test(sql)).toBe(true);
    expect(sql).toContain("rfq_award_id");
  });

  it("conversion completeness is enforced in the database, not the client", () => {
    const sql = migrationSql();
    if (!sql) return;
    expect(sql).toContain("_rfq_assert_conversion_complete");
  });

  it("guard lists stay meaningful", () => {
    expect(RETIRED_IDENTIFIERS.length).toBeGreaterThan(5);
    expect(CANONICAL_RFQ_RPCS.length).toBeGreaterThan(5);
  });
});
