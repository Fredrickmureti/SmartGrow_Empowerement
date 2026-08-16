/**
 * Architecture guard — Wave 3 · Phase 4 (POS Payment Engine)
 *
 * Contract test for `public.pos_payment_session_commit`. The function is
 * the single write-path for both retail sales and restaurant table-order
 * finalisation, and its correctness relies on four invariants that are
 * easy to regress if the SQL is edited by a future migration:
 *
 *  (C1) Envelope routing — `existing_transaction_id` present in the
 *       envelope routes to `finalize_table_order`; absence routes to
 *       `process_pos_transaction`. No third branch may exist.
 *
 *  (C2) Idempotent replay — repeated calls with the same
 *       `p_session_id` must return the cached response envelope from
 *       `pos_payment_session_apply_log` / `pos_transaction_idempotency`
 *       instead of re-executing the underlying commit RPC. This is what
 *       makes crash-recovery and network-retry semantics safe.
 *
 *  (C3) Apply log write — every successful commit records exactly one
 *       row in `pos_payment_session_apply_log` referencing the resulting
 *       `transaction_id`, before returning to the client.
 *
 *  (C4) Snapshot immutability — `pos_payment_session_open` freezes
 *       `fx_rate`, `settlement_currency`, `tip_policy` at insert time.
 *       Nothing in the commit or record paths may mutate them; a replay
 *       of `open` MUST return the original session row unchanged.
 *
 * All four invariants are asserted by scanning the shipped migration
 * files. This is intentional: pgTAP live-DB tests are covered elsewhere;
 * this guard fails the build the instant an edit weakens the contract.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIG = join(process.cwd(), "supabase/migrations");

function readMigrationsMatching(pattern: RegExp): string {
  const files = readdirSync(MIG)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files
    .map((f) => readFileSync(join(MIG, f), "utf8"))
    .filter((s) => pattern.test(s))
    .join("\n\n-- ── next migration ──\n\n");
}

/**
 * Return only the LATEST migration body that matches `pattern`. Used
 * when we need to reason about the current definition of a function
 * (e.g., "exactly one apply-log INSERT") rather than every historical
 * revision concatenated together.
 */
function readLatestMigrationMatching(pattern: RegExp): string {
  const files = readdirSync(MIG)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const body = readFileSync(join(MIG, files[i]), "utf8");
    if (pattern.test(body)) return body;
  }
  return "";
}

/**
 * Extract just the body of `CREATE OR REPLACE FUNCTION public.<name>` from a
 * blob of migration SQL (up to its `$function$;` / `$$;` terminator). Phase 7
 * ships the sweeper and `pos_payment_session_cancel` in the same migration, so
 * a file-level regex would see cancel's (legitimate) `status = 'cancelled'`
 * UPDATE and mis-attribute it to the sweeper.
 */
function extractFunctionBody(sql: string, name: string): string {
  const start = new RegExp(
    String.raw`CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.` + name + String.raw`\b`,
    "i",
  );
  const bodies: string[] = [];
  let rest = sql;
  for (;;) {
    const m = rest.match(start);
    if (!m || m.index === undefined) break;
    const from = rest.slice(m.index);
    const end = from.search(/\$function\$\s*;|\$\$\s*;/);
    bodies.push(end === -1 ? from : from.slice(0, end));
    rest = from.slice(end === -1 ? from.length : end + 1);
    if (!rest) break;
  }
  return bodies.join("\n");
}

describe("pos_payment_session_commit — SQL contract (Wave 3 Phase 4)", () => {
  const commitSql = readLatestMigrationMatching(
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.pos_payment_session_commit/i,
  );

  it("(C1) routes on existing_transaction_id — restaurant → finalize_table_order, retail → process_pos_transaction", () => {
    expect(commitSql, "must exist").not.toEqual("");
    // Restaurant branch: the envelope key is captured and drives the branch.
    expect(commitSql).toMatch(
      /existing_transaction_id["']\s*\)\s*[^\n]*::uuid|v_existing\s*:=\s*NULLIF\s*\(\s*p_transaction_envelope->>\s*'existing_transaction_id'/i,
    );
    // Both underlying RPCs must be invoked from this function body.
    expect(commitSql, "must forward to finalize_table_order").toMatch(
      /finalize_table_order\s*\(/,
    );
    expect(commitSql, "must forward to process_pos_transaction").toMatch(
      /process_pos_transaction\s*\(/,
    );
    // Guard against a rogue third path: the only commit-side call
    // targets are those two forwardees. No other function name that
    // ends in `_pos_transaction` or `_table_order` may be invoked.
    const forbiddenCallers = [
      /\b_pos_record_payment\s*\(/,        // internal helper — not a commit entrypoint
      /\bpos_finalize_sale\s*\(/,          // hypothetical replacement — must land as a migration first
    ];
    for (const re of forbiddenCallers) {
      expect(
        re.test(commitSql),
        `pos_payment_session_commit must not call ${re}`,
      ).toBe(false);
    }
  });

  it("(C2) idempotent replay returns the cached envelope without re-executing the underlying commit", () => {
    // Positional analysis must ignore `-- line comments`, otherwise the
    // function-header docblock (which mentions both RPC names) skews
    // the "first occurrence" indices.
    const stripped = commitSql.replace(/--[^\n]*/g, "");
    const applyLogIdx = stripped.search(/pos_payment_session_apply_log/i);
    const processIdx  = stripped.search(/process_pos_transaction\s*\(/i);
    const finalizeIdx = stripped.search(/finalize_table_order\s*\(/i);
    expect(applyLogIdx, "must consult the apply log").toBeGreaterThan(-1);
    expect(processIdx, "must call process_pos_transaction at least once").toBeGreaterThan(-1);
    expect(finalizeIdx, "must call finalize_table_order at least once").toBeGreaterThan(-1);
    // First apply-log read must precede first commit RPC in either branch.
    expect(applyLogIdx).toBeLessThan(Math.min(processIdx, finalizeIdx));
    // And the cached-return path must exist: an EXISTING apply-log row
    // implies looking up the idempotency response cache and returning
    // it, not re-invoking the underlying commit.
    expect(commitSql).toMatch(/pos_transaction_idempotency/i);
    expect(commitSql).toMatch(/RETURN\s+/i);
  });

  it("(C3) writes exactly one apply-log row per successful commit, before returning", () => {
    // One INSERT into the apply log, keyed by (session_id, transaction_id).
    const inserts = commitSql.match(/INSERT\s+INTO\s+public\.pos_payment_session_apply_log/gi) ?? [];
    expect(inserts.length, "exactly one apply-log insert").toBe(1);
    // The insert must supply session_id + transaction_id columns.
    expect(commitSql).toMatch(
      /INSERT\s+INTO\s+public\.pos_payment_session_apply_log[\s\S]{0,120}\(\s*session_id\s*,\s*transaction_id/i,
    );
    // And the insert must appear before the function's final RETURN of
    // the response envelope (i.e., not orphaned after RETURN).
    const insertIdx = commitSql.search(/INSERT\s+INTO\s+public\.pos_payment_session_apply_log/i);
    const finalReturnIdx = commitSql.lastIndexOf("RETURN ");
    expect(insertIdx).toBeGreaterThan(-1);
    expect(finalReturnIdx).toBeGreaterThan(insertIdx);
  });
});

describe("pos_payment_session_open — snapshot immutability (Wave 3 Phase 4.d)", () => {
  const openSql = readMigrationsMatching(
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.pos_payment_session_open/i,
  );

  it("(C4a) accepts and inserts fx_rate / settlement_currency / tip_policy at open time", () => {
    expect(openSql, "must exist").not.toEqual("");
    for (const arg of ["p_fx_rate", "p_settlement_currency", "p_tip_policy"]) {
      expect(openSql, `must declare ${arg}`).toMatch(new RegExp(`\\b${arg}\\b`));
    }
    // Snapshot columns must be part of the INSERT ... VALUES tuple.
    expect(openSql).toMatch(/fx_rate[\s\S]{0,80}settlement_currency[\s\S]{0,80}tip_policy/i);
  });

  it("(C4b) never issues an UPDATE against the snapshot columns from a runtime code path", () => {
    // Backfills (one-shot UPDATEs inside the migration that first added
    // the columns) are legitimate — the row was created before the
    // snapshot existed. What must NEVER happen is a runtime UPDATE
    // living inside a function body, trigger, or later migration.
    //
    // Strategy: extract every plpgsql function body across all session
    // migrations and assert none of them mutate the snapshot columns.
    const allSessionSql = readMigrationsMatching(/pos_payment_session/i);
    const fnBodyRe = /\$\$([\s\S]*?)\$\$/g;
    const bodies: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = fnBodyRe.exec(allSessionSql)) !== null) bodies.push(m[1]);
    const bodiesJoined = bodies.join("\n\n-- ── next fn body ──\n\n");

    const forbiddenUpdates = [
      /UPDATE\s+public\.pos_payment_sessions[\s\S]{0,400}\bSET\b[\s\S]{0,400}\bfx_rate\s*=/i,
      /UPDATE\s+public\.pos_payment_sessions[\s\S]{0,400}\bSET\b[\s\S]{0,400}\bsettlement_currency\s*=/i,
      /UPDATE\s+public\.pos_payment_sessions[\s\S]{0,400}\bSET\b[\s\S]{0,400}\btip_policy\s*=/i,
    ];
    for (const re of forbiddenUpdates) {
      expect(
        re.test(bodiesJoined),
        `snapshot columns must be immutable after open — offending pattern in a function body: ${re}`,
      ).toBe(false);
    }
  });

  it("(C4c) rehydrating the same idempotency_key returns the existing session row instead of re-inserting", () => {
    // The `open` function must short-circuit when a row already exists
    // for (business_id, idempotency_key). Guard against a regression
    // that removes the pre-insert SELECT.
    expect(openSql).toMatch(
      /SELECT[\s\S]{0,200}FROM\s+public\.pos_payment_sessions[\s\S]{0,200}idempotency_key\s*=\s*p_idempotency_key/i,
    );
  });
});

describe("pos_payment_session_sweep_abandoned — FSM-safe cancel (Wave 3 Phase 4.e)", () => {
  const sweepMigrations = readMigrationsMatching(
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.pos_payment_session_sweep_abandoned/i,
  );
  const sweepSql = extractFunctionBody(sweepMigrations, "pos_payment_session_sweep_abandoned");

  it("cancels via pos_payment_session_cancel — never a raw UPDATE against pos_payment_sessions.status", () => {
    expect(sweepSql, "must exist").not.toEqual("");
    // Must call the cancel function (which internally reverses tenders
    // through the card FSM).
    expect(sweepSql).toMatch(/pos_payment_session_cancel\s*\(/i);
    // Must NOT bypass the FSM by setting status = 'cancelled' directly.
    expect(
      /UPDATE\s+public\.pos_payment_sessions[\s\S]{0,300}\bSET\b[\s\S]{0,300}status\s*=\s*'cancelled'/i.test(
        sweepSql,
      ),
      "sweeper must not bypass pos_payment_session_cancel with a raw UPDATE",
    ).toBe(false);
  });

  it("only closes sessions with nothing allocated (Phase 7)", () => {
    expect(sweepSql).toMatch(/pos_payment_session_allocated\s*\(\s*s\.id\s*\)\s*=\s*0/i);
  });

  it("is restricted to service_role", () => {
    expect(sweepMigrations).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.pos_payment_session_sweep_abandoned/i);
    expect(sweepMigrations).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.pos_payment_session_sweep_abandoned[\s\S]{0,80}TO\s+service_role/i,
    );
  });
});
