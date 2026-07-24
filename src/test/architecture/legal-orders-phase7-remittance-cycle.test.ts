/**
 * ADR-0096 Phase 7 — Legal Orders remittance cycle closure architecture pin.
 *
 * Pins the invariants that make the planning → bank file → settlement →
 * bank-reconciliation loop safe:
 *
 *   1. Aggregate + line tables exist (`legal_order_remittance_batches`,
 *      `legal_order_remittance_batch_lines`).
 *   2. The four sanctioned RPCs are declared as SECURITY DEFINER:
 *        - legal_order_build_remittance_batch
 *        - legal_order_generate_remittance_bank_file
 *        - legal_order_settle_remittance_batch
 *        - legal_order_cancel_remittance_batch
 *      and the safety-net job `legal_order_auto_satisfy`.
 *   3. Phase 7 step 2 adds a `legal_order_remittance_batch_id` column on
 *      `bank_reconciliation_matches` and a matching RPC
 *      `legal_order_match_batch_to_bank_txn` so a settled batch can be
 *      linked to a bank transaction from the reconciliation surface.
 *   4. The remittance-batches workspace does NOT flip `status` directly
 *      on `legal_orders_records` — all lifecycle writes still route
 *      through the FSM (`apply_system_garnishment_transition`).
 *   5. The remittance-batches workspace exposes the "Match" affordance
 *      so operators can close the loop without leaving the surface.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const repo = process.cwd();
const migrationsDir = "supabase/migrations";

function allMigrationSrc(): string {
  return readdirSync(join(repo, migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(repo, migrationsDir, f), "utf8"))
    .join("\n");
}

describe("legal-orders phase 7 — remittance cycle closure", () => {
  const src = allMigrationSrc();

  it("aggregate + line tables are created", () => {
    expect(
      /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?public\.legal_order_remittance_batches\b/i.test(src),
    ).toBe(true);
    expect(
      /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?public\.legal_order_remittance_batch_lines\b/i.test(src),
    ).toBe(true);
  });

  it.each([
    "legal_order_build_remittance_batch",
    "legal_order_generate_remittance_bank_file",
    "legal_order_settle_remittance_batch",
    "legal_order_cancel_remittance_batch",
    "legal_order_auto_satisfy",
  ])("%s is declared as SECURITY DEFINER", (fn) => {
    const re = new RegExp(
      `CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+(public\\.)?${fn}\\b[\\s\\S]*?SECURITY\\s+DEFINER`,
      "i",
    );
    expect(re.test(src), `${fn} missing or not SECURITY DEFINER`).toBe(true);
  });

  it("bank reconciliation gains a batch link column and matching RPC", () => {
    expect(
      /ALTER\s+TABLE\s+(public\.)?bank_reconciliation_matches[\s\S]{0,400}legal_order_remittance_batch_id/i.test(
        src,
      ),
    ).toBe(true);
    expect(
      /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(public\.)?legal_order_match_batch_to_bank_txn\b[\s\S]*?SECURITY\s+DEFINER/i.test(
        src,
      ),
    ).toBe(true);
  });

  it("remittance-batches workspace never writes legal_orders_records.status directly", () => {
    const path = join(repo, "src/pages/hr/payroll/LegalOrderRemittanceBatches.tsx");
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, "utf8");
    // No direct .from("legal_orders_records").update({ status: ... })
    expect(body).not.toMatch(/legal_orders_records[\s\S]{0,120}\.update\s*\(\s*\{[\s\S]{0,200}status/);
  });

  it("remittance-batches workspace exposes a Match affordance", () => {
    const body = readFileSync(
      join(repo, "src/pages/hr/payroll/LegalOrderRemittanceBatches.tsx"),
      "utf8",
    );
    expect(body).toMatch(/legal_order_match_batch_to_bank_txn/);
    expect(body).toMatch(/MatchBatchDialog/);
  });
});
