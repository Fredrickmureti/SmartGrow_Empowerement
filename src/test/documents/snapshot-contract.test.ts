/**
 * Wave 7.2 — snapshot builder contract test.
 *
 * Every builder under `src/services/documents/snapshots/` must:
 *   1. Return a `snapshot` blob shaped as a plain JSON object.
 *   2. Return a `documentDate` in ISO YYYY-MM-DD form (or null when the
 *      source has no date semantics).
 *   3. Include `document_type` and `document_type_label` on the snapshot
 *      so the renderer can pick a template variant.
 *
 * This guards against drift as new builders land in Wave 7.2. Adding a
 * builder here without also adding it to the SUITE below is caught by
 * the "every builder is covered" meta-check.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildPosReceiptSnapshot } from "@/services/documents/snapshots/posReceipt";
import { buildKitchenTicketSnapshot } from "@/services/documents/snapshots/posKitchenTicket";
import { buildSalesInvoiceSnapshot } from "@/services/documents/snapshots/salesInvoice";

const SNAPSHOTS_DIR = path.join(process.cwd(), "src/services/documents/snapshots");

// Every fixture below produces a valid input for its builder.
const SUITE: Array<{ file: string; run: () => { snapshot: Record<string, unknown>; documentDate: string | null } }> = [
  {
    file: "posReceipt.ts",
    run: () =>
      buildPosReceiptSnapshot({
        frozen: {
          schema_version: 1,
          transaction: {
            id: "t",
            receipt_number: "R-1",
            transacted_at: "2026-07-27T10:00:00Z",
            total_amount: 100,
          },
          items: [],
          payments: [],
          business: { id: "b" },
          branch: { id: "br" },
          organization: { id: "o" },
          customer: null,
          cashier: null,
          register: null,
        } as never,
      }),
  },
  {
    file: "posKitchenTicket.ts",
    run: () =>
      buildKitchenTicketSnapshot({
        orders: [
          {
            id: "k1",
            transaction_id: "t1",
            printer_category: "kitchen",
            created_at: "2026-07-27T10:00:00Z",
            organization_id: "o",
          },
        ],
        station: "kitchen",
      }),
  },
];

describe("snapshot builder contract", () => {
  for (const entry of SUITE) {
    it(`${entry.file} emits document_type/label and a well-formed documentDate`, () => {
      const { snapshot, documentDate } = entry.run();
      expect(snapshot).toBeTypeOf("object");
      expect(snapshot).toHaveProperty("document_type");
      expect(snapshot).toHaveProperty("document_type_label");
      expect(typeof snapshot.document_type).toBe("string");
      expect(typeof snapshot.document_type_label).toBe("string");
      if (documentDate !== null) {
        expect(documentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });
  }

  it("every file under snapshots/ (except index.ts) is covered by SUITE", () => {
    const files = fs
      .readdirSync(SNAPSHOTS_DIR)
      .filter((f) => f.endsWith(".ts") && f !== "index.ts");
    const covered = new Set(SUITE.map((s) => s.file));
    const missing = files.filter((f) => !covered.has(f));
    expect(
      missing,
      `snapshot builders missing from snapshot-contract.test.ts SUITE: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
