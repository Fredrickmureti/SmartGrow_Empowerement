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

  // Wave 2 · Phase C-2 — UI wiring guards.

  it("CardPaymentModal exists and imports CardTerminalController.preAuthorize", () => {
    const modal = readFileSync(join(REPO, "src/components/pos/CardPaymentModal.tsx"), "utf8");
    expect(modal).toMatch(/from ["']@\/services\/pos\/CardTerminalController["']/);
    expect(modal).toMatch(/cardTerminal\.preAuthorize\(/);
    // Modal must NOT reach into the private driver field.
    expect(modal).not.toMatch(/cardTerminal\[["']driver["']\]/);
  });

  it("TenderWorkspace wires the card modal for tender_kind='card'", () => {
    const dlg = readFileSync(join(REPO, "src/apps/pos/terminal/tender/TenderWorkspace.tsx"), "utf8");
    expect(dlg).toMatch(/import\s*\{[^}]*CardPaymentModal[^}]*\}\s*from\s*["']@\/components\/pos\/CardPaymentModal["']/);
    expect(dlg).toMatch(/tender_kind\s*===\s*["']card["']/);
    expect(dlg).toMatch(/<CardPaymentModal\b/);
  });

  it("TenderWorkspacePayment and PaymentMethod carry card FSM metadata", () => {
    const dlg = readFileSync(join(REPO, "src/apps/pos/terminal/tender/TenderWorkspace.tsx"), "utf8");
    const off = readFileSync(join(REPO, "src/hooks/pos/usePOSTransactionOffline.ts"), "utf8");
    for (const field of ["auth_state", "auth_id", "vendor_txn_id", "authorized_amount"]) {
      expect(dlg, `TenderWorkspacePayment must expose ${field}`).toMatch(new RegExp(`${field}\\??:`));
      expect(off, `PaymentMethod must expose ${field}`).toMatch(new RegExp(`${field}\\??:`));
    }
    // The RPC payload map must forward the FSM fields.
    expect(off).toMatch(/auth_state:\s*p\.auth_state/);
    expect(off).toMatch(/vendor_txn_id:\s*p\.vendor_txn_id/);
  });

  it("CardTerminalController exposes preAuthorize (driver-only pre-commit hook)", () => {
    const ctrl = readFileSync(join(REPO, "src/services/pos/CardTerminalController.ts"), "utf8");
    expect(ctrl).toMatch(/async\s+preAuthorize\s*\(/);
  });

  // Wave 3 · Phase 4 — offline replay + restaurant commit both route
  // through the payment-session lifecycle (paymentSessionClient), not
  // the legacy RPCs. The card FSM metadata is forwarded as `auth_state`
  // + `driver_payload` on each recorded tender.

  it("SQLiteSyncManager routes offline replay through paymentSessionClient (no direct payment inserts)", () => {
    const p = join(REPO, "src/services/offline/SQLiteSyncManager.ts");
    const s = readFileSync(p, "utf8");
    expect(s, "must use the payment-session wrapper").toMatch(/paymentSessionClient|openSession|commitSession/);
    // The legacy commit RPC must no longer be called from the replay path.
    expect(s, "must not call process_pos_transaction directly").not.toMatch(
      /\.rpc\s*\(\s*["']process_pos_transaction["']/,
    );
    // Card FSM metadata still flows through — as auth_state on the tender.
    expect(s).toMatch(/auth_state:\s*p\.auth_state/);
    // No direct writes to any POS table on the replay path.
    for (const t of ["pos_transactions", "pos_transaction_items", "pos_transaction_payments"]) {
      expect(
        new RegExp(`\\.from\\(["']${t}["']\\)[\\s\\S]{0,120}\\.insert\\(`).test(s),
        `SQLiteSyncManager must not .insert() into ${t}`,
      ).toBe(false);
    }
  });

  it("POSTerminal restaurant branch commits via paymentSessionClient and forwards card FSM metadata", () => {
    const src = readFileSync(join(REPO, "src/pages/pos/POSTerminal.tsx"), "utf8");
    expect(src, "restaurant branch must call commitPaymentSession").toMatch(/commitPaymentSession/);
    expect(src, "must not call finalize_table_order directly").not.toMatch(
      /\.rpc\s*\(\s*["']finalize_table_order["']/,
    );
    // Restaurant branch must forward the same FSM fields the retail branch does.
    for (const field of ["auth_state", "auth_id", "vendor_txn_id", "authorized_amount"]) {
      expect(src, `POSTerminal must forward ${field}`).toMatch(new RegExp(`${field}`));
    }
  });

  it("migration defines the card-event outbox trigger (payment.card.*)", () => {
    expect(migrations).toMatch(/tg_emit_pos_card_fsm_event/);
    expect(migrations).toMatch(/trg_emit_pos_card_fsm_event/);
    for (const t of [
      "payment.card.authorized",
      "payment.card.captured",
      "payment.card.voided",
      "payment.card.reversed",
    ]) {
      expect(migrations, `missing topic ${t}`).toContain(t);
    }
  });

  it("CardPaymentActions exists and goes only through cardTerminal.* (no direct pos_card_* RPC)", () => {
    const p = join(REPO, "src/components/pos/transaction-detail/CardPaymentActions.tsx");
    const s = readFileSync(p, "utf8");
    expect(s).toMatch(/cardTerminal\.(capture|void|reverse)\(/);
    expect(s, "must not call pos_card_* RPCs directly").not.toMatch(
      /["']pos_card_(authorize|capture|void|reverse)["']/,
    );
  });
});


