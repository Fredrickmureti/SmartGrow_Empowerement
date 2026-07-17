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

describe("ADR-0077 3-way match + landed cost — session-8 RPCs", () => {
  it("migration files declare allocate_landed_cost_bill and match_bill_to_grn", () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));
    const joined = files
      .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
      .join("\n");
    expect(joined).toMatch(/CREATE OR REPLACE FUNCTION\s+public\.allocate_landed_cost_bill\b/);
    expect(joined).toMatch(/CREATE OR REPLACE FUNCTION\s+public\.match_bill_to_grn\b/);
  });
});
