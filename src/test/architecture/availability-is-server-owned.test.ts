/**
 * ADR 0142 — availability is computed on the server.
 *
 * No browser code may derive availability by subtracting reserved from
 * quantity. Decision-making code must call `resolveAvailability`
 * (src/lib/inventory/availability.ts), which wraps the canonical
 * `resolve_stock_availability` RPC.
 *
 * PENDING_MIGRATION lists surfaces that still derive availability locally.
 * The list may only ever shrink — adding to it requires a new ADR.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "glob";

/** Files still doing client-side availability arithmetic (Phase 7 backlog). */
const PENDING_MIGRATION: string[] = [
  "src/components/products/ProductStockPanel.tsx",
  "src/components/products/detail/ProductDetailPanel.tsx",
  "src/components/products/detail/tabs/OverviewTab.tsx",
  "src/components/products/detail/tabs/StockTab.tsx",
  "src/features/sales/invoices/InvoiceCreatePage.tsx",
  "src/hooks/useBranchScopedProducts.ts",
  "src/lib/replenishment/engine.ts",
  "src/pages/Inventory.tsx",
];


/** `x.quantity - x.reserved_quantity`, in either naming convention. */
const DERIVATION =
  /(quantity|qty|on_?hand|onHand)\s*[-−]\s*[\w.?\[\]"'() ]*(reserved_quantity|reservedQuantity|reserved)\b/i;

const isExempt = (file: string) =>
  file.startsWith("src/test/") ||
  file.includes("__tests__") ||
  file === "src/lib/inventory/availability.ts" ||
  file === "src/integrations/supabase/types.ts";

describe("ADR 0142: availability is server-owned", () => {
  const files = globSync("src/**/*.{ts,tsx}", { nodir: true }).filter(
    (f) => !isExempt(f),
  );

  it("no new client-side availability derivation", () => {
    const offenders = files.filter((file) => {
      if (PENDING_MIGRATION.includes(file)) return false;
      return DERIVATION.test(readFileSync(file, "utf8"));
    });

    expect(
      offenders,
      `These files derive availability in the browser. Call resolveAvailability() from src/lib/inventory/availability.ts instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the pending-migration allowlist only shrinks", () => {
    const stale = PENDING_MIGRATION.filter((file) => {
      try {
        return !DERIVATION.test(readFileSync(file, "utf8"));
      } catch {
        return true; // file gone — remove it from the list
      }
    });

    expect(
      stale,
      `These files no longer derive availability (or no longer exist). Remove them from PENDING_MIGRATION:\n${stale.join("\n")}`,
    ).toEqual([]);
  });
});
