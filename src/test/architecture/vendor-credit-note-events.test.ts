/**
 * Vendor credit note — lifecycle event coverage ratchet.
 *
 * Every state a vendor credit note can reach must be observable downstream.
 * The emission itself is server-side (`_vcn_emit_lifecycle` on
 * `vendor_credit_notes`), so this test guards the *client* contract that keeps
 * that emission reachable and honest:
 *
 *  1. Each lifecycle command the UI can invoke goes through a server RPC —
 *     a direct table write would mutate state without ever firing the trigger.
 *  2. The action hook exposes every transition, so no state is reachable only
 *     from a hand-rolled call site the ratchets cannot see.
 *
 * If a new lifecycle command is added, add it to TRANSITIONS here in the same
 * change; a command absent from the writer module is a command whose event
 * nobody will ever receive.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const WRITER = "src/hooks/useVendorCreditNotes.ts";
const ACTIONS = "src/features/purchases/credit-notes/useVendorCreditNoteActions.tsx";

/** RPC name → the state the outbox emits when that command succeeds. */
const TRANSITIONS: Array<{ rpc: string; state: string }> = [
  { rpc: "create_vendor_credit_note_atomic", state: "created" },
  { rpc: "vendor_credit_note_submit", state: "submitted" },
  { rpc: "vendor_credit_note_approve", state: "approved" },
  { rpc: "vendor_credit_note_reject", state: "rejected" },
  { rpc: "vendor_credit_note_cancel", state: "cancelled" },
  { rpc: "vendor_credit_note_dispute", state: "disputed" },
  { rpc: "vendor_credit_note_resolve_dispute", state: "dispute resolved" },
  { rpc: "issue_vendor_credit_note_atomic", state: "posted" },
  { rpc: "apply_vendor_credit_to_bill_atomic", state: "applied" },
  { rpc: "reverse_vendor_credit_note_atomic", state: "reversed" },
];

describe("vendor credit note — every lifecycle transition is server-emitted", () => {
  const writer = read(WRITER);

  it.each(TRANSITIONS)("$state goes through $rpc", ({ rpc }) => {
    expect(
      writer.includes(rpc),
      `${rpc} is missing from ${WRITER}; its lifecycle event would never be emitted`,
    ).toBe(true);
  });

  it("the writer module never writes vendor_credit_notes directly", () => {
    const direct =
      /\.from\(\s*["'`]vendor_credit_notes?["'`]\s*\)[\s\S]{0,120}?\.(insert|update|delete|upsert)\(/;
    expect(
      direct.test(writer),
      "A direct table write bypasses the lifecycle trigger and loses the outbox event",
    ).toBe(false);
  });

  it("the action hook surfaces the full commercial lifecycle", () => {
    const actions = read(ACTIONS);
    for (const id of ["submit", "approve", "reject", "cancel", "dispute"]) {
      expect(actions.includes(`id: "${id}"`), `action "${id}" is missing`).toBe(true);
    }
  });
});
