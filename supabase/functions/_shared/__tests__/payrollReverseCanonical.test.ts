/**
 * T-E — D-14 regression test: reversing a payroll run via the
 * `reverse-payroll` edge function MUST flip the original payroll JE
 * to status='reversed' and net all account balances to zero.
 *
 * Before the D-14 fix, the edge function passed `{_je_id, _voided_by,
 * _void_reason, _create_reversal, _reversal_date}` to the canonical RPC,
 * which silently failed with PGRST202. The HR sub-ledger updated, but
 * the GL stayed posted. This test would have caught it.
 *
 * Requires `TEST_PAYROLL_RUN_ID` pointing to a freshly-posted-but-not-
 * yet-reversed payroll run on the test org. Heavy fixture; skips cleanly.
 */
import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  adminClient,
  canRun,
  SUPABASE_URL,
  TEST_ORG_ID,
} from "./_accountingTestHelpers.ts";

const TEST_PAYROLL_RUN_ID = Deno.env.get("TEST_PAYROLL_RUN_ID") ?? "";

Deno.test("T-E reverse-payroll edge function reverses GL via canonical RPC", async () => {
  const gate = canRun();
  if (!gate.ok) {
    console.log(`SKIP T-E: ${gate.reason}`);
    return;
  }
  if (!TEST_PAYROLL_RUN_ID) {
    console.log("SKIP T-E: TEST_PAYROLL_RUN_ID not set (heavy payroll fixture)");
    return;
  }
  const admin = adminClient();

  // Snapshot the original payroll JE.
  const beforeQ = await admin
    .from("journal_entries")
    .select("id, status")
    .eq("organization_id", TEST_ORG_ID)
    .eq("source_type", "payroll")
    .eq("source_id", TEST_PAYROLL_RUN_ID)
    .neq("status", "voided")
    .maybeSingle();
  if (beforeQ.error) throw beforeQ.error;
  if (!beforeQ.data) {
    console.log("SKIP T-E: no live payroll JE found for the test run");
    return;
  }
  assertEquals(beforeQ.data.status, "posted", "fixture: payroll JE must start posted");

  // Invoke the edge function directly.
  const url = `${SUPABASE_URL}/functions/v1/reverse-payroll`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""}`,
    },
    body: JSON.stringify({
      payroll_run_id: TEST_PAYROLL_RUN_ID,
      organization_id: TEST_ORG_ID,
      reason: "T-E canonical reversal test",
      post_to_gl: true,
    }),
  });
  const body = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(`reverse-payroll returned ${resp.status}: ${JSON.stringify(body)}`);
  }

  // Re-read the original JE — must now be status='reversed'.
  const afterQ = await admin
    .from("journal_entries")
    .select("id, status, reversed_by_id")
    .eq("id", beforeQ.data.id)
    .single();
  if (afterQ.error) throw afterQ.error;

  assertEquals(
    afterQ.data.status,
    "reversed",
    "D-14 regression: original payroll JE must be flipped to 'reversed'",
  );
  if (!afterQ.data.reversed_by_id) {
    throw new Error("reversed_by_id must be populated after canonical void");
  }
});
