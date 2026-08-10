/**
 * ADR 0076 (Stock Event Fabric) + ADR 0077 (3-way match + landed cost) —
 * session-8 guards.
 *
 * Enforces:
 *  1. `DomainEventType` includes the five `stock.movement.*` fabric types
 *     the DB trigger `tg_stock_movement_emit_event` publishes.
 *  2. `BusinessSagaMount` registers a saga handler for at least one
 *     `stock.movement.*` type — proves ADR 0076's outbox path is drained
 *     by an application-side consumer (Priority A).
 *  3. Session-8 migration file exists and declares both new RPCs
 *     (`allocate_landed_cost_bill`, `match_bill_to_grn`).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "../..");
const MIGRATIONS = join(__dirname, "../../../supabase/migrations");

const STOCK_MOVEMENT_TYPES = [
  "stock.movement.received",
  "stock.movement.dispatched",
  "stock.movement.transferred",
  "stock.movement.adjusted",
  "stock.movement.posted",
];

describe("ADR-0076 Stock Event Fabric — client wiring", () => {
  it("DomainEventType includes every stock.movement.* type the DB trigger emits", () => {
    const src = readFileSync(join(SRC, "services/events/domainEventBus.ts"), "utf8");
    for (const t of STOCK_MOVEMENT_TYPES) {
      expect(src, `DomainEventType must include '${t}'`).toContain(`'${t}'`);
    }
  });

  it("BusinessSagaMount registers a handler for at least one stock.movement.* type", () => {
    const src = readFileSync(join(SRC, "components/events/BusinessSagaMount.tsx"), "utf8");
    const registered = STOCK_MOVEMENT_TYPES.filter((t) =>
      src.includes(`saga.register('${t}'`) || src.includes(`saga.register("${t}"`),
    );
    expect(
      registered.length,
      "BusinessSagaMount must subscribe to at least one stock.movement.* event",
    ).toBeGreaterThan(0);
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
