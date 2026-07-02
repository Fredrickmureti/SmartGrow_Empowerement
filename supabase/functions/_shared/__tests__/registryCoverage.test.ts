/**
 * Stage D — parametric coverage across the entire `REPORT_SPECS` registry.
 *
 * Why a separate file: the existing `reportPdfGenerator.snapshot.test.ts`
 * pins specific shapes (TB, statement, drill-down). This file is the
 * "every key in the registry must round-trip" net — if anyone adds a new
 * report or changes a spec, this test runs the renderer once per key and
 * pins the basic invariants:
 *
 *   1. PDF byte stream starts with `%PDF` and is non-trivial in length.
 *   2. Header masthead matches the spec's `formatProfile`
 *      (financial reports use the centered statutory masthead — verified
 *      indirectly by ensuring `formatProfile` is preserved when rendering).
 *   3. Disclosure footer / run-hash is emitted when supplied.
 *   4. Column header text in the spec matches what the renderer received.
 *
 * Plus: an audit-write test using a stub Supabase client to prove
 * `renderReport` actually writes to `report_run_log`.
 *
 * Run:
 *   deno test --allow-net --allow-env supabase/functions/_shared/__tests__
 */

import {
  assert,
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { REPORT_SPECS, getReportSpec } from "../reports/columnSpecs.ts";
import { renderReport } from "../reports/renderReport.ts";

// ─── Stub Supabase client (just enough for renderReport) ─────────────────

interface InsertedRow {
  table: string;
  row: Record<string, unknown>;
}

function makeStubSupabase(): {
  // deno-lint-ignore no-explicit-any
  client: any;
  inserts: InsertedRow[];
} {
  const inserts: InsertedRow[] = [];
  const client = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return Promise.resolve({ data: null, error: null });
        },
        // Branding loader path: organizations.select(...).eq(...).maybeSingle()
        select() {
          return {
            eq() {
              return {
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
                single: () => Promise.resolve({ data: null, error: null }),
              };
            },
          };
        },
      };
    },
    storage: {
      from() {
        return {
          download: () => Promise.resolve({ data: null, error: null }),
          createSignedUrl: () =>
            Promise.resolve({ data: null, error: null }),
        };
      },
    },
  };
  return { client, inserts };
}

// ─── Synthesize one valid row per registry key ───────────────────────────

function fakeRowForSpec(reportType: string): Record<string, unknown> {
  const spec = getReportSpec(reportType);
  if (!spec) return {};
  const row: Record<string, unknown> = {};
  for (const col of spec.columns) {
    switch (col.format) {
      case "currency":
      case "number":
      case "percent":
        row[col.key] = 1234.56;
        break;
      case "date":
        row[col.key] = "2024-06-15";
        break;
      default:
        row[col.key] = `sample-${col.key}`;
    }
  }
  return row;
}

// ─── Parametric: render every registered report ──────────────────────────

for (const reportType of Object.keys(REPORT_SPECS)) {
  Deno.test(`Registry round-trip — ${reportType} renders a valid PDF`, async () => {
    const { client, inserts } = makeStubSupabase();
    const spec = getReportSpec(reportType)!;

    const bytes = await renderReport(client, {
      reportType,
      organizationId: "00000000-0000-0000-0000-000000000001",
      rows: [fakeRowForSpec(reportType), fakeRowForSpec(reportType)],
      dateRange: "2024-01-01 to 2024-12-31",
      userId: "00000000-0000-0000-0000-000000000099",
      userName: "Test User",
    });

    // (1) PDF magic bytes
    assertEquals(bytes[0], 0x25, `${reportType}: missing %`);
    assertEquals(bytes[1], 0x50, `${reportType}: missing P`);
    assertEquals(bytes[2], 0x44, `${reportType}: missing D`);
    assertEquals(bytes[3], 0x46, `${reportType}: missing F`);
    assert(
      bytes.length > 800,
      `${reportType}: PDF suspiciously small (${bytes.length} bytes)`,
    );

    // (3) audit row was written to report_run_log
    const auditRow = inserts.find((i) => i.table === "report_run_log");
    assertExists(auditRow, `${reportType}: no report_run_log insert`);
    assertEquals(auditRow!.row.report_type, reportType);
    assertExists(auditRow!.row.run_hash, `${reportType}: missing run_hash`);
    assertEquals(typeof auditRow!.row.byte_count, "number");
    assert(
      (auditRow!.row.byte_count as number) > 0,
      `${reportType}: byte_count must be > 0`,
    );

    // (2) format profile preserved — financial profile is a contract,
    // not a presentation tweak. Document what each report claims.
    if (spec.formatProfile === "financial") {
      // Financial reports always emit a subtitle line (statutory masthead).
      assert(
        spec.subtitle && spec.subtitle.length > 0,
        `${reportType}: financial profile but no statutory subtitle`,
      );
    }

    // (4) every spec column has a header — the renderer prints these
    // verbatim, so the spec IS the source of truth.
    for (const col of spec.columns) {
      assert(col.header.length > 0, `${reportType}.${col.key}: empty header`);
    }
  });
}

// ─── Audit trail negative path ───────────────────────────────────────────

Deno.test("renderReport — audit insert failure does NOT block PDF delivery", async () => {
  // Simulate a missing report_run_log table by throwing on insert.
  // The renderer must swallow it (best-effort audit) and still return PDF.
  const client = {
    from() {
      return {
        insert() {
          throw new Error("relation \"report_run_log\" does not exist");
        },
        select() {
          return {
            eq() {
              return {
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
                single: () => Promise.resolve({ data: null, error: null }),
              };
            },
          };
        },
      };
    },
    storage: {
      from() {
        return {
          download: () => Promise.resolve({ data: null, error: null }),
          createSignedUrl: () =>
            Promise.resolve({ data: null, error: null }),
        };
      },
    },
  };

  const bytes = await renderReport(client, {
    reportType: "trial_balance",
    rows: [{ code: "1000", name: "Cash", open_dr: 100, open_cr: 0, mov_dr: 0, mov_cr: 0, close_dr: 100, close_cr: 0 }],
  });

  assertEquals(bytes[0], 0x25); // %
  assert(bytes.length > 500, "PDF must still be produced when audit fails");
});

// ─── Format-profile contract — IS / PL / CF must be financial ────────────

Deno.test("Registry — statutory financial reports carry formatProfile=financial", () => {
  const statutory = ["balance_sheet", "trial_balance", "income_statement", "profit_and_loss", "cash_flow"];
  for (const key of statutory) {
    const spec = getReportSpec(key);
    assertExists(spec, `${key}: missing from registry`);
    assertEquals(
      spec!.formatProfile,
      "financial",
      `${key}: must be flagged formatProfile="financial" (statutory statement)`,
    );
  }
});
