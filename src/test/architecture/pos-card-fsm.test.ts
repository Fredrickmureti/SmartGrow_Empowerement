/**
 * Wave 2 · Phase C — Card/EMV FSM architecture guard.
 *
 * Locks in the invariants so nobody bypasses the state machine:
 *  - A migration defines pos_card_authorize / capture / void / reverse.
 *  - A trigger + transition table exists (pos_card_fsm_transitions +
 *    pos_card_fsm_guard).
 *  - CardTerminalController is the only client entry-point — no other
 *    file calls the pos_card_* RPCs directly, and no non-controller
 *    file writes `auth_state` on pos_transaction_payments.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();
const MIG_DIR = join(REPO, "supabase/migrations");

const migrations = readdirSync(MIG_DIR)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join(MIG_DIR, f), "utf8"))
  .join("\n");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(t|j)sx?$/.test(name)) out.push(p);
  }
  return out;
}

const srcFiles = walk(join(REPO, "src"));

describe("pos-card-fsm: substrate & entry-point invariants", () => {
  it("migration defines all four pos_card_* RPCs", () => {
    for (const fn of ["pos_card_authorize", "pos_card_capture", "pos_card_void", "pos_card_reverse"]) {
      expect(migrations, `missing migration for ${fn}`).toMatch(
        new RegExp(`FUNCTION\\s+public\\.${fn}`),
      );
    }
  });

  it("migration defines the transition table and guard trigger", () => {
    expect(migrations).toMatch(/pos_card_fsm_transitions/);
    expect(migrations).toMatch(/pos_card_fsm_guard/);
    expect(migrations).toMatch(/trg_pos_card_fsm_guard/);
  });

  it("CardTerminalController is the only caller of pos_card_* RPCs in src/", () => {
    const offenders = srcFiles.filter((p) => {
      if (p.endsWith("CardTerminalController.ts")) return false;
      if (p.includes("/test/") || p.includes("__tests__")) return false;
      const s = readFileSync(p, "utf8");
      return /["']pos_card_(authorize|capture|void|reverse)["']/.test(s);
    });
    expect(offenders, `direct pos_card_* RPC calls outside CardTerminalController: ${offenders.join(", ")}`)
      .toEqual([]);
  });

  it("no src/ file writes auth_state on pos_transaction_payments directly", () => {
    const offenders = srcFiles.filter((p) => {
      if (p.includes("/test/") || p.includes("__tests__")) return false;
      const s = readFileSync(p, "utf8");
      // Look for an update/insert on the payments table that also sets auth_state.
      return /pos_transaction_payments/.test(s)
        && /\bauth_state\s*:/.test(s)
        && /\.(update|insert|upsert)\s*\(/.test(s);
    });
    expect(offenders, `direct auth_state writes must go through pos_card_* RPCs: ${offenders.join(", ")}`)
      .toEqual([]);
  });
});
