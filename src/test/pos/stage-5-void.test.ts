/**
 * Stage 5 — Void / Refund / Cancel separation regression test.
 *
 * Structural read of the latest migration that defines `process_pos_void`.
 * Asserts every guard that ships with the v2 RPC + the schema bits it
 * depends on:
 *
 *   1. New enum value `void_post_payment` exists.
 *   2. `pos_void_reasons` table is created.
 *   3. `pos_security_settings.void_requires_manager_above_amount` exists.
 *   4. `pos_transactions.void_reason_id` / `void_note` / `void_override_id`
 *      columns exist.
 *   5. RPC body references: shift `open` guard, completed guard, prior-return
 *      block, reason FK, threshold + override gate (`void_above_threshold`),
 *      stock reversal via `stock_movements`, `expected_cash` adjustment,
 *      `reversal_type='void_post_payment'` stamp.
 *   6. Client wiring: `usePOSVoid` calls `process_pos_void` with the new
 *      6-arg shape; `VoidTransactionDialog` renders the reason picker;
 *      `ReceiptPreviewDialog` accepts `is_voided`.
 *   7. Settings: `POSVoidReasonsCard` mounted under Security tab; threshold
 *      input wired to `void_requires_manager_above_amount`.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function findMigration(needle: string): string {
  const dir = "supabase/migrations";
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const sql = readFileSync(join(dir, files[i]), "utf8");
    if (sql.includes(needle)) return sql;
  }
  throw new Error(`No migration contains: ${needle}`);
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("Stage 5 — Void/Refund/Cancel separation", () => {
  describe("schema", () => {
    const sql = findMigration("process_pos_void");

    it("declares pos_reversal_type enum with void_post_payment", () => {
      const enumSql = findMigration("pos_reversal_type");
      expect(enumSql).toMatch(/void_post_payment/);
      expect(enumSql).toMatch(/cancel_pre_payment/);
      expect(enumSql).toMatch(/return_refund/);
    });

    it("creates pos_void_reasons table", () => {
      const t = findMigration("pos_void_reasons");
      expect(t).toMatch(/create\s+table[\s\S]*pos_void_reasons/i);
      expect(t).toMatch(/requires_note/);
      expect(t).toMatch(/sort_order/);
    });

    it("adds void_requires_manager_above_amount on pos_security_settings", () => {
      expect(findMigration("void_requires_manager_above_amount")).toMatch(
        /pos_security_settings[\s\S]*void_requires_manager_above_amount/i,
      );
    });

    it("adds void_reason_id / void_note / void_override_id on pos_transactions", () => {
      const t = findMigration("void_override_id");
      expect(t).toMatch(/void_reason_id/);
      expect(t).toMatch(/void_note/);
      expect(t).toMatch(/void_override_id/);
    });

    it("RPC enforces same-shift, post-payment-only, prior-return block", () => {
      expect(sql).toMatch(/shift[\s\S]*open/i);
      expect(sql).toMatch(/completed/i);
      // Block already-returned transactions
      expect(sql).toMatch(/process_pos_return|original_transaction_id|already.*return/i);
    });

    it("RPC requires reason FK and conditional note", () => {
      expect(sql).toMatch(/p_void_reason_id/);
      expect(sql).toMatch(/requires_note/);
    });

    it("RPC honours void_above_threshold manager override", () => {
      expect(sql).toMatch(/void_above_threshold/);
      expect(sql).toMatch(/pos_manager_overrides/);
    });

    it("RPC reverses stock and adjusts expected cash", () => {
      expect(sql).toMatch(/stock_movements/);
      expect(sql).toMatch(/expected_cash/);
    });

    it("RPC stamps reversal_type=void_post_payment", () => {
      expect(sql).toMatch(/reversal_type[\s\S]*void_post_payment/);
    });
  });

  describe("client wiring", () => {
    it("usePOSVoid calls process_pos_void with the new param shape", () => {
      const src = read("src/hooks/pos/usePOSVoid.ts");
      expect(src).toMatch(/rpc\(\s*"process_pos_void"/);
      expect(src).toMatch(/p_void_reason_id/);
      expect(src).toMatch(/p_void_note/);
      expect(src).toMatch(/p_voided_by/);
      expect(src).toMatch(/p_override_id/);
    });

    it("VoidTransactionDialog renders the reason picker", () => {
      const src = read("src/components/pos/VoidTransactionDialog.tsx");
      expect(src).toMatch(/pos_void_reasons/);
      expect(src).toMatch(/requires_note/);
    });

    it("ReceiptPreviewBody accepts is_voided for VOID watermark", () => {
      // Step 5.2 retired `ReceiptPreviewDialog`; the void watermark now
      // lives in the shared `ReceiptPreviewBody` consumed by every reprint
      // surface.
      const src = read("src/components/pos/ReceiptPreviewBody.tsx");
      expect(src).toMatch(/is_voided/);
      expect(src).toMatch(/VOID/);
    });
  });

  describe("settings polish", () => {
    it("usePOSSecuritySettings exposes the void threshold field", () => {
      const src = read("src/hooks/pos/usePOSSecuritySettings.ts");
      expect(src).toMatch(/void_requires_manager_above_amount/);
    });

    it("SecuritySettingsCard binds an input to the void threshold", () => {
      const src = read("src/components/pos/SecuritySettingsCard.tsx");
      expect(src).toMatch(/void_requires_manager_above_amount/);
    });

    it("POSSettings mounts POSVoidReasonsCard under the Security tab", () => {
      const src = read("src/pages/pos/POSSettings.tsx");
      expect(src).toMatch(/POSVoidReasonsCard/);
    });
  });
});