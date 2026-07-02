/**
 * T-A — Void must NOT double-count.
 *
 * Regression guard for the M-4 trigger interaction:
 *   - line trigger applies reversal on mirror-line INSERT
 *   - status-change trigger MUST no-op on posted→reversed
 *
 * If anyone re-introduces the old behavior where the status trigger also
 * subtracts on `reversed`, this test will fail loudly.
 *
 * Setup: create posted JE that moves $100 DR / $100 CR.
 * Snapshot balances after post.
 * Void it.
 * Assert: balances net 0 vs pre-post baseline (NOT -$100 / +$100).
 */
import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  adminClient,
  canRun,
  getBalance,
  postJE,
  seedAccounts,
  TEST_ORG_ID,
} from "./_accountingTestHelpers.ts";

Deno.test("T-A void does not double-count balances", async () => {
  const gate = canRun();
  if (!gate.ok) {
    console.log(`SKIP T-A: ${gate.reason}`);
    return;
  }
  const admin = adminClient();
  const { debitId, creditId, cleanup } = await seedAccounts(admin, TEST_ORG_ID, "DC");

  try {
    const drBefore = await getBalance(admin, debitId);
    const crBefore = await getBalance(admin, creditId);

    const sourceId = crypto.randomUUID();
    const jeId = await postJE(admin, {
      orgId: TEST_ORG_ID,
      debitId,
      creditId,
      amount: 100,
      sourceType: "test_void_doublecount",
      sourceId,
    });

    const drAfterPost = await getBalance(admin, debitId);
    const crAfterPost = await getBalance(admin, creditId);
    assertEquals(drAfterPost - drBefore, 100, "DR balance should rise by 100");
    // Revenue account: credit increases balance by 100.
    assertEquals(crAfterPost - crBefore, 100, "CR balance should rise by 100");

    // Reverse via canonical RPC.
    const { data: reversalId, error: voidErr } = await admin.rpc(
      "void_journal_entry_atomic",
      {
        _entry_id: jeId,
        _reason: "T-A test reversal",
        _user_id: null,
        _entry_number: null,
        _reversal_date: null,
      } as any,
    );
    if (voidErr) throw voidErr;
    if (!reversalId) throw new Error("reversal id was null");

    const drAfterVoid = await getBalance(admin, debitId);
    const crAfterVoid = await getBalance(admin, creditId);

    // CRITICAL: net effect must equal baseline. If the status-change
    // trigger ever stops being a no-op for posted→reversed, these would
    // be -100 / -100 (DR) and -100 / +100 (CR) instead of 0 / 0.
    assertEquals(drAfterVoid - drBefore, 0, "DR must net to baseline after void");
    assertEquals(crAfterVoid - crBefore, 0, "CR must net to baseline after void");

    // Cleanup the JEs (cascade lines)
    await admin.from("journal_entries").delete().eq("id", reversalId);
    await admin.from("journal_entries").delete().eq("id", jeId);
  } finally {
    await cleanup();
  }
});
