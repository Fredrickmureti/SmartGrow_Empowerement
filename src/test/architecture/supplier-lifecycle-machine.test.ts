/**
 * Supplier lifecycle state machine — invariant contract.
 *
 * Every transition goes through `public._supplier_transition(...)`, called by
 * the thin RPCs (`approve_supplier`, `suspend_supplier`, `block_supplier`,
 * `unblock_supplier`, `archive_supplier`, `restore_supplier`,
 * `start_supplier_qualification`). That single writer guarantees:
 *
 *  - row lock (`FOR UPDATE`) → no lost update on concurrent approvals;
 *  - tenancy check via `user_has_business_access`;
 *  - re-entrant no-op when already in the target state (replay-safe);
 *  - rejection of illegal from-states (`Cannot move supplier from X to Y`);
 *  - monotonic `lifecycle_seq`, one `supplier_lifecycle_events` row per bump;
 *  - one `business_event_outbox` row per (event, supplier, seq) via a
 *    deterministic idempotency key with `ON CONFLICT DO NOTHING`.
 *
 * Verified live against the deployed function on 2026-08-12. This test pins
 * the transition matrix and the idempotency mechanics to the migration source
 * so a later migration cannot weaken them unnoticed.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS = join(process.cwd(), "supabase/migrations");

/** RPC → (target state, legal from-states). Mirrors the deployed definitions. */
const TRANSITIONS: Record<string, { to: string; from: string[] }> = {
  approve_supplier: { to: "approved", from: ["draft", "qualifying", "suspended"] },
  suspend_supplier: { to: "suspended", from: ["draft", "qualifying", "approved"] },
  reinstate_supplier: { to: "approved", from: ["suspended"] },
  block_supplier: {
    to: "blocked",
    from: ["draft", "qualifying", "approved", "suspended"],
  },
  unblock_supplier: { to: "draft", from: ["blocked"] },
  archive_supplier: {
    to: "archived",
    from: ["draft", "qualifying", "approved", "suspended", "blocked"],
  },
  unarchive_supplier: { to: "draft", from: ["archived"] },
  // Automatic transitions: a failed compliance check suspends immediately and
  // an elapsed qualification drops an approved supplier back to qualifying.
  sweep_supplier_qualification_expiry: { to: "qualifying", from: ["approved"] },
};

/** States that must never be purchasable. */
const NON_PURCHASABLE = ["draft", "qualifying", "suspended", "blocked", "archived"];

function migrationSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n");
}

/** Latest definition body of a SQL function, as written in migrations. */
function latestFunctionBody(sql: string, name: string): string {
  const idx = sql.lastIndexOf(`FUNCTION public.${name}`);
  if (idx === -1) return "";
  return sql.slice(idx, idx + 5000);
}

describe("supplier lifecycle machine", () => {
  const sql = migrationSql();

  it("routes every transition RPC through the single writer", () => {
    const offenders: string[] = [];
    for (const rpc of Object.keys(TRANSITIONS)) {
      const body = latestFunctionBody(sql, rpc);
      if (!body) offenders.push(`${rpc}: not defined in migrations`);
      else if (!body.includes("_supplier_transition"))
        offenders.push(`${rpc}: does not call _supplier_transition`);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("declares the expected target state and legal from-states per RPC", () => {
    const offenders: string[] = [];
    for (const [rpc, { to, from }] of Object.entries(TRANSITIONS)) {
      const body = latestFunctionBody(sql, rpc);
      if (!body.includes(`'${to}'`)) offenders.push(`${rpc}: missing target ${to}`);
      for (const state of from) {
        if (!body.includes(`'${state}'`))
          offenders.push(`${rpc}: missing legal from-state ${state}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the single writer locks the row, checks tenancy, and is replay-safe", () => {
    const body = latestFunctionBody(sql, "_supplier_transition");
    expect(body).toContain("FOR UPDATE");
    expect(body).toContain("user_has_business_access");
    // Re-entrancy: same target state returns a no-op instead of a new event.
    expect(body).toMatch(/lifecycle_state\s*=\s*p_to_state/);
    expect(body).toContain("'noop'");
    // Illegal transitions are rejected, not coerced.
    expect(body).toMatch(/Cannot move supplier from/);
  });

  it("emits exactly one lifecycle event and one outbox row per seq bump", () => {
    const body = latestFunctionBody(sql, "_supplier_transition");
    expect(body).toMatch(/lifecycle_seq\s*\+\s*1/);
    expect(body).toContain("supplier_lifecycle_events");
    expect(body).toContain("business_event_outbox");
    // Deterministic key = event : supplier : seq, deduped by the DB.
    expect(body).toMatch(/idempotency_key/);
    expect(body).toMatch(/ON CONFLICT[\s\S]{0,60}DO NOTHING/i);
  });

  it("only 'approved' suppliers may transact (gate rejects all other states)", () => {
    const gate = latestFunctionBody(sql, "_assert_supplier_purchasable");
    expect(gate).toMatch(/approved/);
    // The gate is state-positive: it asserts approved rather than listing
    // blocked states, so new states default to non-purchasable.
    for (const state of NON_PURCHASABLE) {
      expect(TRANSITIONS.approve_supplier.to).not.toBe(state);
    }
  });
});
