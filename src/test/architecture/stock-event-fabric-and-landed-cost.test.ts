/**
 * ADR 0076 (Stock Event Fabric) + ADR 0077 (3-way match + landed cost),
 * consolidated by the Inventory Foundation Wave · Phase 6.
 *
 * Enforces:
 *  1. `DomainEventType` carries the canonical inventory topics and no longer
 *     declares the retired five `stock.movement.*` types (one emitter, one
 *     topic: `inventory.movement.recorded`).
 *  2. `BusinessSagaMount` subscribes to `inventory.movement.recorded`.
 *  3. The `outbox-dispatcher` registers every inventory topic the DB emits,
 *     so no inventory event can dead-letter on the closed registry.
 *  4. Session-8 migration file exists and declares both new RPCs.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "../..");
const MIGRATIONS = join(__dirname, "../../../supabase/migrations");
const DISPATCHER = join(
  __dirname,
  "../../../supabase/functions/outbox-dispatcher/index.ts",
);

const INVENTORY_TOPICS = [
  "inventory.movement.recorded",
  "inventory.lot.quarantined",
  "inventory.lot.released",
  "inventory.lot.recall_opened",
  "inventory.lot.recall_closed",
  "inventory.serial.status_changed",
  "inventory.valuation.revalued",
  "inventory.valuation.revaluation_reversed",
];

const RETIRED_TOPICS = [
  "stock.movement.received",
  "stock.movement.dispatched",
  "stock.movement.transferred",
  "stock.movement.adjusted",
  "stock.movement.posted",
];

describe("ADR-0076 Stock Event Fabric — one emitter, one topic family", () => {
  it("DomainEventType declares every canonical inventory topic", () => {
    const src = readFileSync(join(SRC, "services/events/domainEventBus.ts"), "utf8");
    for (const t of INVENTORY_TOPICS) {
      expect(src, `DomainEventType must include '${t}'`).toContain(`'${t}'`);
    }
  });

  it("the retired stock.movement.* topics are gone from client code", () => {
    const bus = readFileSync(join(SRC, "services/events/domainEventBus.ts"), "utf8");
    const mount = readFileSync(join(SRC, "components/events/BusinessSagaMount.tsx"), "utf8");
    for (const t of RETIRED_TOPICS) {
      expect(bus, `DomainEventType must not re-declare '${t}'`).not.toContain(`'${t}'`);
      expect(mount, `BusinessSagaMount must not register '${t}'`).not.toContain(`'${t}'`);
    }
  });

  it("BusinessSagaMount subscribes to inventory.movement.recorded", () => {
    const src = readFileSync(join(SRC, "components/events/BusinessSagaMount.tsx"), "utf8");
    expect(src).toContain("saga.register('inventory.movement.recorded'");
  });

  it("the outbox dispatcher registers every inventory topic", () => {
    const src = readFileSync(DISPATCHER, "utf8");
    for (const t of INVENTORY_TOPICS) {
      expect(src, `outbox-dispatcher must register '${t}'`).toContain(`"${t}"`);
    }
  });
});


describe("Session 8 · Priority B — non-movement stock lifecycle fabric", () => {
  const LIFECYCLE_TYPES = [
    "stock.adjustment.posted",
    "stock.transfer.approved",
    "stock.transfer.completed",
    "stock.count.completed",
    "stock.count.cancelled",
  ];

  it("DomainEventType includes every non-movement lifecycle event", () => {
    const src = readFileSync(join(SRC, "services/events/domainEventBus.ts"), "utf8");
    for (const t of LIFECYCLE_TYPES) {
      expect(src, `DomainEventType must include '${t}'`).toContain(`'${t}'`);
    }
  });

  it("BusinessSagaMount subscribes to every non-movement lifecycle event", () => {
    const src = readFileSync(join(SRC, "components/events/BusinessSagaMount.tsx"), "utf8");
    for (const t of LIFECYCLE_TYPES) {
      expect(src, `BusinessSagaMount must register '${t}'`).toContain(`'${t}'`);
    }
  });

  it("migration files declare the three lifecycle emit triggers", () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));
    const joined = files
      .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
      .join("\n");
    expect(joined).toMatch(/tg_stock_adjustment_emit_lifecycle/);
    expect(joined).toMatch(/tg_stock_transfer_emit_lifecycle/);
    expect(joined).toMatch(/tg_physical_count_emit_lifecycle/);
  });
});

describe("ADR-0077 3-way match + landed cost — session-8 RPCs", () => {
  it("migration files declare allocate_landed_cost_bill and the single matcher", () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));
    const joined = files
      .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
      .join("\n");
    expect(joined).toMatch(/CREATE OR REPLACE FUNCTION\s+public\.allocate_landed_cost_bill\b/);
    expect(joined).toMatch(/CREATE OR REPLACE FUNCTION\s+public\.match_bill_atomic\b/);
    // The legacy second matcher was consolidated into match_bill_atomic.
    expect(joined).toMatch(/DROP FUNCTION IF EXISTS public\.match_bill_to_grn/);
  });

  it("the bill match action is wired to the single matcher, never the legacy one", () => {
    const src = readFileSync(join(SRC, "features/purchases/bills/useBillActions.tsx"), "utf8");
    expect(src).toContain("match_bill_atomic");
    expect(src).not.toContain("match_bill_to_grn");
  });


  it("Landed cost management page is registered on the Purchases router", () => {
    const routes = readFileSync(join(SRC, "apps/purchases/routes.tsx"), "utf8");
    expect(routes).toMatch(/landed-costs/);
  });
});
