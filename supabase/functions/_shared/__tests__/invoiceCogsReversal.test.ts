/**
 * T-D — Invoice with COGS produces TWO journal entries (revenue + COGS),
 *        and voiding the invoice produces TWO matching reversals so that
 *        every account nets to zero.
 *
 * The two JEs share `(source_type='invoice', source_id=<inv>)` but
 * differ on `source_subtype`: NULL (treated as 'main') for revenue,
 * `'cogs'` for the inventory→COGS leg. The unique index
 * `idx_journal_entries_source_unique` permits both because subtype
 * is part of the key.
 *
 * This test simulates the contract directly via the canonical posting
 * RPC rather than going through `confirmInvoiceGL` to keep the test
 * hermetic (no products / customers fixtures required).
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

Deno.test("T-D invoice + COGS dual-JE void nets to zero", async () => {
  const gate = canRun();
  if (!gate.ok) {
    console.log(`SKIP T-D: ${gate.reason}`);
    return;
  }
  const admin = adminClient();
  const ar = await seedAccounts(admin, TEST_ORG_ID, "AR");
  const inv = await seedAccounts(admin, TEST_ORG_ID, "INV");

  try {
    const sourceId = crypto.randomUUID();
    const baselines = {
      arDr: await getBalance(admin, ar.debitId),
      arCr: await getBalance(admin, ar.creditId),
      invDr: await getBalance(admin, inv.debitId),
      invCr: await getBalance(admin, inv.creditId),
    };

    // Main JE: AR DR / Revenue CR
    const mainJe = await postJE(admin, {
      orgId: TEST_ORG_ID,
      debitId: ar.debitId,
      creditId: ar.creditId,
      amount: 200,
      sourceType: "test_invoice_cogs",
      sourceId,
      sourceSubtype: null,
    });
    // COGS JE: COGS DR / Inventory CR
    const cogsJe = await postJE(admin, {
      orgId: TEST_ORG_ID,
      debitId: inv.debitId,
      creditId: inv.creditId,
      amount: 120,
      sourceType: "test_invoice_cogs",
      sourceId,
      sourceSubtype: "cogs",
    });

    // Void both via canonical RPC.
    const v1 = await admin.rpc("void_journal_entry_atomic", {
      _entry_id: mainJe,
      _reason: "T-D reversal main",
      _user_id: null,
      _entry_number: null,
      _reversal_date: null,
    } as any);
    if (v1.error) throw v1.error;

    const v2 = await admin.rpc("void_journal_entry_atomic", {
      _entry_id: cogsJe,
      _reason: "T-D reversal cogs",
      _user_id: null,
      _entry_number: null,
      _reversal_date: null,
    } as any);
    if (v2.error) throw v2.error;

    const after = {
      arDr: await getBalance(admin, ar.debitId),
      arCr: await getBalance(admin, ar.creditId),
      invDr: await getBalance(admin, inv.debitId),
      invCr: await getBalance(admin, inv.creditId),
    };

    assertEquals(after.arDr - baselines.arDr, 0, "AR debit account nets to baseline");
    assertEquals(after.arCr - baselines.arCr, 0, "AR credit account nets to baseline");
    assertEquals(after.invDr - baselines.invDr, 0, "COGS account nets to baseline");
    assertEquals(after.invCr - baselines.invCr, 0, "Inventory account nets to baseline");

    // Cleanup
    await admin.from("journal_entries").delete().eq("id", v1.data as string);
    await admin.from("journal_entries").delete().eq("id", v2.data as string);
    await admin.from("journal_entries").delete().eq("id", mainJe);
    await admin.from("journal_entries").delete().eq("id", cogsJe);
  } finally {
    await ar.cleanup();
    await inv.cleanup();
  }
});
