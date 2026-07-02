/**
 * T-B — Void is idempotent.
 *
 * Two parallel calls to `void_journal_entry_atomic` against the same
 * journal entry MUST return the same reversal id and produce exactly
 * one reversal row.
 *
 * Guards against any future weakening of the in-RPC short-circuit and
 * the `idx_journal_entries_source_unique` index.
 */
import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  adminClient,
  canRun,
  postJE,
  seedAccounts,
  TEST_ORG_ID,
} from "./_accountingTestHelpers.ts";

Deno.test("T-B void RPC is idempotent under concurrent calls", async () => {
  const gate = canRun();
  if (!gate.ok) {
    console.log(`SKIP T-B: ${gate.reason}`);
    return;
  }
  const admin = adminClient();
  const { debitId, creditId, cleanup } = await seedAccounts(admin, TEST_ORG_ID, "ID");

  try {
    const jeId = await postJE(admin, {
      orgId: TEST_ORG_ID,
      debitId,
      creditId,
      amount: 50,
      sourceType: "test_void_idempotency",
    });

    // Fire two reversals concurrently.
    const args = {
      _entry_id: jeId,
      _reason: "T-B parallel reversal",
      _user_id: null,
      _entry_number: null,
      _reversal_date: null,
    } as any;
    const [r1, r2] = await Promise.all([
      admin.rpc("void_journal_entry_atomic", args),
      admin.rpc("void_journal_entry_atomic", args),
    ]);

    if (r1.error) throw r1.error;
    if (r2.error) throw r2.error;
    assertEquals(r1.data, r2.data, "both calls must return the same reversal id");

    // Confirm exactly one reversal row exists for this source.
    const { data: rows, error } = await admin
      .from("journal_entries")
      .select("id")
      .eq("organization_id", TEST_ORG_ID)
      .eq("source_type", "test_void_idempotency")
      .eq("source_subtype", "reversal");
    if (error) throw error;
    assertEquals(rows?.length, 1, "exactly one reversal row must exist");

    await admin.from("journal_entries").delete().eq("id", r1.data as string);
    await admin.from("journal_entries").delete().eq("id", jeId);
  } finally {
    await cleanup();
  }
});
