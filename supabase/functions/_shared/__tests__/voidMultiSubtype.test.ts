/**
 * T-G / T-H — Multi-subtype void integrity.
 *
 * Pins the regression where `void_journal_entry_atomic` previously matched
 * any reversal for `(org, source_type, source_id)` and short-circuited
 * cross-subtype calls. That caused the COGS sub-entry of an invoice to be
 * marked `status='reversed'` linked to the MAIN reversal — without ever
 * inserting COGS reversal lines, leaving Inventory/COGS balances stuck.
 *
 * Fix verified here:
 *   - Main JE (subtype IS NULL) and COGS sub-JE (subtype='cogs') each get
 *     their OWN reversal sub-entry.
 *   - Reversal subtypes are 'reversal' and 'reversal:cogs' respectively.
 *   - All four affected accounts net back to baseline.
 *   - Calling void twice on the COGS JE returns the same id (per-subtype
 *     idempotency) and never collides with the main reversal.
 */
import "https://deno.land/std@0.224.0/dotenv/load.ts";
import {
  assert,
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  adminClient,
  canRun,
  getBalance,
  seedAccounts,
  TEST_ORG_ID,
} from "./_accountingTestHelpers.ts";

Deno.test("T-G — main + COGS void produces two distinct reversal sub-entries", async () => {
  const gate = canRun();
  if (!gate.ok) {
    console.warn(`[T-G SKIPPED] ${gate.reason}`);
    return;
  }

  const admin = adminClient();
  const tag = "TG" + Date.now().toString().slice(-5);

  // Seed two account pairs: one for main (AR/Sales), one for COGS (COGS/Inventory)
  const main = await seedAccounts(admin, TEST_ORG_ID, `${tag}-M`);
  const cogsSeed = await seedAccounts(admin, TEST_ORG_ID, `${tag}-C`);

  const sourceId = crypto.randomUUID();
  const baseAR = await getBalance(admin, main.debitId);
  const baseRev = await getBalance(admin, main.creditId);
  const baseCOGS = await getBalance(admin, cogsSeed.debitId);
  const baseInv = await getBalance(admin, cogsSeed.creditId);

  try {
    // Post main invoice JE (subtype = NULL)
    const mainPost = await admin.rpc("post_journal_entry_atomic", {
      _organization_id: TEST_ORG_ID,
      _entry_date: new Date().toISOString().split("T")[0],
      _description: `T-G main ${tag}`,
      _source_type: "invoice",
      _source_id: sourceId,
      _source_subtype: null,
      _entry_number: null,
      _reference_number: null,
      _business_id: null,
      _user_id: null,
      _lines: [
        { account_id: main.debitId, debit: 1000, credit: 0, description: "AR" },
        { account_id: main.creditId, debit: 0, credit: 1000, description: "Sales" },
      ],
      _auto_post: true,
      _idempotency_key: null,
      _metadata: null,
    } as any);
    if (mainPost.error) throw mainPost.error;
    const mainJeId = mainPost.data as string;

    // Post COGS sub-entry (subtype = 'cogs')
    const cogsPost = await admin.rpc("post_journal_entry_atomic", {
      _organization_id: TEST_ORG_ID,
      _entry_date: new Date().toISOString().split("T")[0],
      _description: `T-G cogs ${tag}`,
      _source_type: "invoice",
      _source_id: sourceId,
      _source_subtype: "cogs",
      _entry_number: null,
      _reference_number: null,
      _business_id: null,
      _user_id: null,
      _lines: [
        { account_id: cogsSeed.debitId, debit: 600, credit: 0, description: "COGS" },
        { account_id: cogsSeed.creditId, debit: 0, credit: 600, description: "Inventory" },
      ],
      _auto_post: true,
      _idempotency_key: null,
      _metadata: null,
    } as any);
    if (cogsPost.error) throw cogsPost.error;
    const cogsJeId = cogsPost.data as string;

    // Void MAIN first
    const voidMain = await admin.rpc("void_journal_entry_atomic", {
      _entry_id: mainJeId,
      _reason: "T-G test main",
      _user_id: null,
      _entry_number: null,
      _reversal_date: null,
    } as any);
    if (voidMain.error) throw voidMain.error;
    const mainRevId = voidMain.data as string;

    // Void COGS — must NOT short-circuit on the main reversal
    const voidCogs = await admin.rpc("void_journal_entry_atomic", {
      _entry_id: cogsJeId,
      _reason: "T-G test cogs",
      _user_id: null,
      _entry_number: null,
      _reversal_date: null,
    } as any);
    if (voidCogs.error) throw voidCogs.error;
    const cogsRevId = voidCogs.data as string;

    // Distinct reversal entries
    assertNotEquals(mainRevId, cogsRevId, "main and COGS must produce distinct reversals");

    // Verify subtypes carried through correctly
    const { data: revs } = await admin
      .from("journal_entries")
      .select("id, source_subtype, reversal_of_id")
      .in("id", [mainRevId, cogsRevId]);
    const mainRev = revs!.find((r) => r.id === mainRevId)!;
    const cogsRev = revs!.find((r) => r.id === cogsRevId)!;
    assertEquals(mainRev.source_subtype, "reversal");
    assertEquals(mainRev.reversal_of_id, mainJeId);
    assertEquals(cogsRev.source_subtype, "reversal:cogs");
    assertEquals(cogsRev.reversal_of_id, cogsJeId);

    // All four accounts net back to baseline
    assertEquals(await getBalance(admin, main.debitId), baseAR);
    assertEquals(await getBalance(admin, main.creditId), baseRev);
    assertEquals(await getBalance(admin, cogsSeed.debitId), baseCOGS);
    assertEquals(await getBalance(admin, cogsSeed.creditId), baseInv);
  } finally {
    // Cleanup: hard-delete the test JEs first, then accounts
    await admin
      .from("journal_entries")
      .delete()
      .eq("organization_id", TEST_ORG_ID)
      .eq("source_id", sourceId);
    await main.cleanup();
    await cogsSeed.cleanup();
  }
});

Deno.test("T-H — voiding the same COGS JE twice returns the same reversal id", async () => {
  const gate = canRun();
  if (!gate.ok) {
    console.warn(`[T-H SKIPPED] ${gate.reason}`);
    return;
  }

  const admin = adminClient();
  const tag = "TH" + Date.now().toString().slice(-5);
  const seed = await seedAccounts(admin, TEST_ORG_ID, tag);
  const sourceId = crypto.randomUUID();

  try {
    const post = await admin.rpc("post_journal_entry_atomic", {
      _organization_id: TEST_ORG_ID,
      _entry_date: new Date().toISOString().split("T")[0],
      _description: `T-H cogs ${tag}`,
      _source_type: "invoice",
      _source_id: sourceId,
      _source_subtype: "cogs",
      _entry_number: null,
      _reference_number: null,
      _business_id: null,
      _user_id: null,
      _lines: [
        { account_id: seed.debitId, debit: 100, credit: 0, description: "COGS" },
        { account_id: seed.creditId, debit: 0, credit: 100, description: "Inventory" },
      ],
      _auto_post: true,
      _idempotency_key: null,
      _metadata: null,
    } as any);
    if (post.error) throw post.error;
    const cogsId = post.data as string;

    const v1 = await admin.rpc("void_journal_entry_atomic", {
      _entry_id: cogsId,
      _reason: "T-H first",
      _user_id: null,
      _entry_number: null,
      _reversal_date: null,
    } as any);
    if (v1.error) throw v1.error;

    const v2 = await admin.rpc("void_journal_entry_atomic", {
      _entry_id: cogsId,
      _reason: "T-H second",
      _user_id: null,
      _entry_number: null,
      _reversal_date: null,
    } as any);
    if (v2.error) throw v2.error;

    assertEquals(v1.data, v2.data, "second void must return the same reversal id");

    // And that reversal must carry subtype 'reversal:cogs', not 'reversal'
    const { data: rev } = await admin
      .from("journal_entries")
      .select("source_subtype")
      .eq("id", v1.data as string)
      .single();
    assertEquals(rev!.source_subtype, "reversal:cogs");
  } finally {
    await admin
      .from("journal_entries")
      .delete()
      .eq("organization_id", TEST_ORG_ID)
      .eq("source_id", sourceId);
    await seed.cleanup();
  }
});
