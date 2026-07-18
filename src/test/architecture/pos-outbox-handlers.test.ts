/**
 * Wave 2 · Phase E — Architecture guard for durable outbox handlers.
 *
 * Every topic that has moved off the UI onto the server dispatcher must
 * have a matching entry in the HANDLERS map of the outbox-dispatcher
 * edge function. Add a new assertion here every time Phase E lands a
 * new subscriber so the substrate can never silently regress to
 * no-op delivery.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();
const DISPATCHER = readFileSync(
  join(REPO, "supabase/functions/outbox-dispatcher/index.ts"),
  "utf8",
);

describe("pos-outbox-handlers: durable subscribers", () => {
  it("registers a handler for pos.sale.committed", () => {
    expect(DISPATCHER).toMatch(/["']pos\.sale\.committed["']\s*:\s*handlePosSaleCommitted/);
  });

  it("pos.sale.committed handler calls apply_loyalty_accrual_for_sale", () => {
    expect(DISPATCHER).toMatch(/apply_loyalty_accrual_for_sale/);
  });

  it("pos.sale.committed handler triggers fiscal transmission via etims-transmit", () => {
    expect(DISPATCHER).toMatch(/etims-transmit/);
  });

  it("registers a handler for inventory.movement.recorded", () => {
    expect(DISPATCHER).toMatch(
      /["']inventory\.movement\.recorded["']\s*:\s*handleInventoryMovementRecorded/,
    );
  });

  it("has a migration defining apply_loyalty_accrual_for_sale", () => {
    const dir = join(REPO, "supabase/migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    const hasFn = files.some((f) =>
      /apply_loyalty_accrual_for_sale/.test(readFileSync(join(dir, f), "utf8")),
    );
    expect(hasFn, "expected a migration defining apply_loyalty_accrual_for_sale").toBe(true);
  });
});
