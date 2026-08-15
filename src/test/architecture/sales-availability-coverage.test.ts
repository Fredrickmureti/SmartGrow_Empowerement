/**
 * ADR 0142 / Phase 5 — availability coverage guard.
 *
 * Availability is server-owned; these tests do NOT re-check that (see
 * `availability-is-server-owned.test.ts`). They check the *coverage* rule the
 * Phase 5 audit found broken: only invoices consulted stock, so operators could
 * commit sales orders and delivery notes blind, and the two invoice pages each
 * carried their own hand-rolled copy of the oversell guard which had already
 * drifted apart.
 *
 * Rules enforced here:
 *  1. Every Sales document kind has an explicit stock policy — a new document
 *     cannot ship without someone deciding what it promises about stock.
 *  2. Every Sales editor that captures product lines goes through the shared
 *     `useSalesLineAvailability` hook.
 *  3. Every `commit`-policy editor renders `OversellConfirmation` AND guards
 *     its submit path, so the badge, the confirmation and the guard can never
 *     disagree.
 *  4. No Sales editor hand-rolls the oversell comparison any more.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SALES_STOCK_POLICY,
  type SalesDocumentKind,
} from "@/features/sales/availability/salesStockPolicy";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

/** Sales editors that capture product lines, and the document they write. */
const LINE_CAPTURING_EDITORS: Array<{
  file: string;
  kind: SalesDocumentKind;
}> = [
  { file: "src/features/sales/invoices/InvoiceCreatePage.tsx", kind: "invoice" },
  { file: "src/features/sales/invoices/InvoiceEditPage.tsx", kind: "invoice" },
  { file: "src/features/sales/orders/SalesOrderCreatePage.tsx", kind: "sales_order" },
  { file: "src/features/sales/orders/SalesOrderEditPage.tsx", kind: "sales_order" },
  {
    file: "src/features/sales/delivery-notes/DeliveryNoteCreatePage.tsx",
    kind: "delivery_note",
  },
  { file: "src/features/sales/estimates/EstimateCreatePage.tsx", kind: "estimate" },
  { file: "src/features/sales/estimates/EstimateEditPage.tsx", kind: "estimate" },
  { file: "src/features/sales/proforma/ProformaCreatePage.tsx", kind: "proforma" },
];

describe("Sales availability coverage", () => {
  it("declares a stock policy for every Sales document kind", () => {
    const kinds: SalesDocumentKind[] = [
      "invoice",
      "sales_order",
      "delivery_note",
      "estimate",
      "proforma",
      "credit_note",
      "sales_return",
    ];
    for (const kind of kinds) {
      expect(SALES_STOCK_POLICY[kind], `no stock policy declared for ${kind}`).toBeDefined();
    }
  });

  it.each(LINE_CAPTURING_EDITORS)(
    "$file consults the shared availability hook",
    ({ file }) => {
      expect(
        read(file),
        `${file} captures product lines but never calls useSalesLineAvailability. ` +
          `Operators would enter quantities blind.`,
      ).toContain("useSalesLineAvailability");
    },
  );

  it.each(LINE_CAPTURING_EDITORS.filter((e) => SALES_STOCK_POLICY[e.kind] === "commit"))(
    "$file (commit policy) both renders and enforces the oversell guard",
    ({ file }) => {
      const source = read(file);
      expect(
        source,
        `${file} commits stock but never renders OversellConfirmation — the ` +
          `operator would be blocked with no way to acknowledge.`,
      ).toContain("OversellConfirmation");
      expect(
        /availability\.(assertSellable|blockingReason)\(\)/.test(source),
        `${file} commits stock but its submit path never calls ` +
          `availability.assertSellable() / blockingReason(). The UI would warn ` +
          `while the save proceeded regardless.`,
      ).toBe(true);
    },
  );

  it.each(LINE_CAPTURING_EDITORS)(
    "$file does not hand-roll the oversell comparison",
    ({ file }) => {
      const source = read(file);
      expect(
        /confirmOversell|oversellNow/.test(source),
        `${file} still carries a local oversell flag. Use the shared hook so ` +
          `the badge, the confirmation and the submit guard cannot drift apart.`,
      ).toBe(false);
      expect(
        source.includes("evaluateStock("),
        `${file} calls evaluateStock directly. Go through ` +
          `useSalesLineAvailability so policy is applied consistently.`,
      ).toBe(false);
    },
  );
});
