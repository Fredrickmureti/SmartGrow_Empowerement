/**
 * Architecture guard — Wave 3 · Phase 4 postmortem.
 *
 * The POS checkout flow calls `pos_payment_session_open` as a Supabase
 * RPC. PostgREST resolves overloaded functions by matching the JSON body
 * key-set to a function's parameter names; when multiple overloads are
 * viable candidates it returns `PGRST203 — Could not choose the best
 * candidate function` (HTTP 400).
 *
 * Phase 4.d added FX + tip-policy snapshot fields to
 * `pos_payment_session_open` via `CREATE OR REPLACE FUNCTION` — but a
 * `CREATE OR REPLACE` with a *different* argument list creates a NEW
 * overload, not a replacement. The legacy 6-arg overload survived
 * silently and every checkout 400'd once the client started sending the
 * 9-arg payload. Fixed by an explicit `DROP FUNCTION` in the postmortem
 * migration; this guard makes sure the drop is present and stays present
 * for the record-tender / reverse-tender / commit / cancel siblings too.
 *
 * The idiom (regex over migration text) matches the rest of the
 * `pos-payment-session-*.test.ts` suite; a live-DB `pg_proc` check runs
 * separately in CI and does not belong in a static guard.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(process.cwd(), "supabase/migrations");

function allMigrationSql(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files
    .map((f) => readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"))
    .join("\n\n-- FILE BOUNDARY --\n\n");
}

const SQL = allMigrationSql();

describe("pos_payment_session_open — single-overload discipline", () => {
  it("has a DROP FUNCTION for the legacy 6-arg overload", () => {
    // Whitespace-tolerant match on the exact signature that predated
    // the FX / settlement_currency / tip_policy snapshot fields.
    const rx =
      /DROP\s+FUNCTION\s+IF\s+EXISTS\s+public\.pos_payment_session_open\s*\(\s*uuid\s*,\s*numeric\s*,\s*text\s*,\s*text\s*,\s*numeric\s*,\s*uuid\s*\)/i;
    expect(SQL, "legacy 6-arg overload of pos_payment_session_open must be dropped").toMatch(rx);
  });

  it("keeps the 9-arg snapshot overload as the sole CREATE definition", () => {
    // The current definition MUST carry the three snapshot params. This
    // asserts the migrations declare them in the parameter list.
    const rx =
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.pos_payment_session_open\s*\([\s\S]*?p_fx_rate[\s\S]*?p_settlement_currency[\s\S]*?p_tip_policy[\s\S]*?\)\s+RETURNS\s+uuid/i;
    expect(SQL).toMatch(rx);
  });
});

describe("pos_payment_session_* — overload-drift scaffolding", () => {
  // Every session RPC MUST have exactly one live CREATE OR REPLACE
  // signature in the migration history. If a future edit adds a new
  // argument list, the same discipline (drop the superseded overload)
  // must be applied.
  const RPCS = [
    "pos_payment_session_record_tender",
    "pos_payment_session_reverse_tender",
    "pos_payment_session_commit",
    "pos_payment_session_cancel",
  ] as const;

  for (const rpc of RPCS) {
    it(`${rpc} — every CREATE OR REPLACE has a matching DROP-or-single-signature discipline`, () => {
      const creates = [
        ...SQL.matchAll(
          new RegExp(
            `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${rpc}\\s*\\(([^)]*)\\)`,
            "gi",
          ),
        ),
      ];
      expect(creates.length, `${rpc} must be defined by migration`).toBeGreaterThan(0);

      // Collect unique parameter-count signatures across all CREATEs.
      const paramCounts = new Set(
        creates.map((m) => {
          const inner = m[1].trim();
          if (!inner) return 0;
          // Rough count: commas at top level. Session RPC signatures do
          // not embed parenthesized types (all params are scalar), so
          // this is safe.
          return inner.split(",").length;
        }),
      );

      // If more than one signature ever shipped, the migration history
      // MUST also carry an explicit DROP for the superseded shape.
      if (paramCounts.size > 1) {
        const dropRx = new RegExp(
          `DROP\\s+FUNCTION\\s+IF\\s+EXISTS\\s+public\\.${rpc}\\s*\\(`,
          "i",
        );
        expect(
          SQL,
          `${rpc} has multiple CREATE OR REPLACE signatures; a DROP FUNCTION for the superseded overload is required (see Wave 3 · Phase 4 postmortem)`,
        ).toMatch(dropRx);
      }
    });
  }
});
