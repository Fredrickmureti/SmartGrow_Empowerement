/**
 * Architecture guard — Scrap / Waste lifecycle wiring.
 *
 * Locks in the enterprise contract established by the scrap
 * investigation: scrap must flow through the `stock_adjustments`
 * document with `adjustment_type='scrap'`, be governed by a SoD
 * catalog entry, and emit a domain event on lifecycle transitions.
 * Regressions to a bare `stock_movements + journal_entries` insert
 * are blocked.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(p, "utf8");

describe("scrap lifecycle architecture", () => {
  it("promotes scrap to a stock_adjustments document (adjustment_type='scrap')", () => {
    const migs = readdirSync("supabase/migrations")
      .filter((f) => f.endsWith(".sql"))
      .map((f) => read(join("supabase/migrations", f)))
      .join("\n\n");
    expect(migs).toMatch(/adjustment_type/);
    expect(migs).toMatch(/'scrap'/);
    expect(migs).toMatch(/stock_adjustments_adjustment_type_check/);
  });

  it("record_scrap_atomic is a wrapper that delegates to approve_stock_adjustment_atomic", () => {
    const migs = readdirSync("supabase/migrations")
      .filter((f) => f.endsWith(".sql"))
      .map((f) => read(join("supabase/migrations", f)))
      .join("\n\n");
    // The current implementation must call the hardened engine.
    expect(migs).toMatch(/approve_stock_adjustment_atomic\(/);
    // The wrapper must set adjustment_type='scrap'.
    expect(migs).toMatch(/adjustment_type[^,]*'scrap'|'scrap'[^,]*adjustment_type/);
  });

  it("has SoD guard, catalog entries, and self-action policy seed for scrap", () => {
    const migs = readdirSync("supabase/migrations")
      .filter((f) => f.endsWith(".sql"))
      .map((f) => read(join("supabase/migrations", f)))
      .join("\n\n");
    expect(migs).toMatch(/sod_stock_adjustment_scrap_guard/);
    expect(migs).toMatch(/'scrap\.approve'/);
    expect(migs).toMatch(/'scrap\.post'/);
    expect(migs).toMatch(/'scrap\.reverse'/);

    const catalogue = read("src/lib/governance/selfActionCatalogue.ts");
    expect(catalogue).toMatch(/key:\s*"scrap\.approve"/);
    expect(catalogue).toMatch(/key:\s*"scrap\.post"/);
    expect(catalogue).toMatch(/key:\s*"scrap\.reverse"/);
  });

  it("emits scrap.posted / scrap.reversed into the domain event bus", () => {
    const bus = read("src/services/events/domainEventBus.ts");
    expect(bus).toMatch(/'scrap\.posted'/);
    expect(bus).toMatch(/'scrap\.reversed'/);

    const migs = readdirSync("supabase/migrations")
      .filter((f) => f.endsWith(".sql"))
      .map((f) => read(join("supabase/migrations", f)))
      .join("\n\n");
    expect(migs).toMatch(/emit_scrap_lifecycle_events/);
    expect(migs).toMatch(/'scrap\.posted'/);
    expect(migs).toMatch(/'scrap\.reversed'/);
  });

  it("has master data (scrap_reasons) and attachments (scrap_attachments) tables", () => {
    const migs = readdirSync("supabase/migrations")
      .filter((f) => f.endsWith(".sql"))
      .map((f) => read(join("supabase/migrations", f)))
      .join("\n\n");
    expect(migs).toMatch(/CREATE TABLE IF NOT EXISTS public\.scrap_reasons/);
    expect(migs).toMatch(/CREATE TABLE IF NOT EXISTS public\.scrap_attachments/);
    // GRANTs are mandatory for every public-schema table.
    expect(migs).toMatch(/GRANT[^;]+ON public\.scrap_reasons TO authenticated/);
    expect(migs).toMatch(/GRANT[^;]+ON public\.scrap_attachments TO authenticated/);
  });

  it("useScrap is the canonical entry point (no direct scrap RPC calls in pages)", () => {
    const scrapNew = read("src/pages/inventory/ScrapNew.tsx");
    const disallowed = [
      "src/pages/inventory/ScrapNew.tsx",
      "src/pages/inventory/ScrapRecording.tsx",
      "src/components/inventory/ScrapDetailSheet.tsx",
    ];
    for (const path of disallowed) {
      const src = read(path);
      expect(
        src.includes("record_scrap_atomic"),
        `${path} must not call record_scrap_atomic directly`,
      ).toBe(false);
    }
    expect(scrapNew).toMatch(/useRecordScrap/);
  });

  it("scrap dashboard filters by adjustment_type in SQL and selects the column", () => {
    const page = read("src/pages/inventory/ScrapRecording.tsx");
    const migs = readdirSync("supabase/migrations")
      .filter((f) => f.endsWith(".sql"))
      .map((f) => read(join("supabase/migrations", f)))
      .join("\n\n");
    expect(page).toMatch(/scrap_document_facts/);
    expect(migs).toMatch(/CREATE(?:\s+OR\s+REPLACE)?\s+VIEW\s+public\.scrap_document_facts/i);
    expect(migs).toMatch(/WHERE\s+a\.adjustment_type\s*=\s*'scrap'/i);
    expect(page).not.toMatch(/\.filter\([\s\S]{0,160}adjustment_type[\s\S]{0,160}scrap/);
  });

  it("scrap reason controls are enforced server-side before posting", () => {
    const migs = readdirSync("supabase/migrations")
      .filter((f) => f.endsWith(".sql"))
      .map((f) => read(join("supabase/migrations", f)))
      .join("\n\n");
    expect(migs).toMatch(/enforce_scrap_reason_controls/);
    expect(migs).toMatch(/SCRAP_ATTACHMENT_REQUIRED/);
    expect(migs).toMatch(/SCRAP_APPROVAL_REQUIRED/);
    expect(migs).toMatch(/offset_account_purpose/);
    expect(migs).toMatch(/_resolve_canonical_default_account/);
  });
});
