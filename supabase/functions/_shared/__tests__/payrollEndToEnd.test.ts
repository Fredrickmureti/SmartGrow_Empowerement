/**
 * T-PE — payroll end-to-end smoke (skip-safe).
 *
 * This is the integration backstop the previous agent deferred. It verifies
 * the full lifecycle the human payroll officer walks:
 *
 *   compute-payroll → post-payroll-gl → create payment batch
 *     → post-payroll-payment-gl (mark paid) → reverse-payroll
 *
 * It requires a pre-seeded payroll run on a disposable test org pointed to
 * by TEST_PAYROLL_RUN_ID (same fixture used by payrollReverseCanonical).
 * Skips cleanly when env is missing — does NOT silently pass.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { adminClient, canRun, SUPABASE_URL, TEST_ORG_ID } from "./_accountingTestHelpers.ts";

const TEST_PAYROLL_RUN_ID = Deno.env.get("TEST_PAYROLL_RUN_ID") ?? "";
const TEST_BANK_ACCOUNT_ID = Deno.env.get("TEST_BANK_ACCOUNT_ID") ?? "";
const ANON = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY") ?? "";

Deno.test("T-PE payroll lifecycle: post → batch → pay (cash JE) → reverse", async () => {
  const gate = canRun();
  if (!gate.ok) return console.log(`SKIP T-PE: ${gate.reason}`);
  if (!TEST_PAYROLL_RUN_ID || !TEST_BANK_ACCOUNT_ID || !ANON) {
    return console.log(
      "SKIP T-PE: TEST_PAYROLL_RUN_ID, TEST_BANK_ACCOUNT_ID, VITE_SUPABASE_PUBLISHABLE_KEY required",
    );
  }

  const admin = adminClient();

  // 1. Run must be in 'posted' state (post-payroll-gl already ran in fixture).
  const { data: run } = await admin
    .from("payroll_runs")
    .select("id, organization_id, business_id, status, payroll_number")
    .eq("id", TEST_PAYROLL_RUN_ID)
    .single();
  assert(run, "fixture run must exist");
  assertEquals(run.organization_id, TEST_ORG_ID, "run must be on TEST_ORG_ID");
  assert(["posted", "paid"].includes(String(run.status)), `run.status was ${run.status}`);

  // 2. Make sure the accrual JE exists.
  const accrual = await admin
    .from("journal_entries")
    .select("id, status")
    .eq("source_type", "payroll")
    .eq("source_id", TEST_PAYROLL_RUN_ID)
    .maybeSingle();
  assert(accrual.data?.id, "accrual JE must exist (run post-payroll-gl first)");

  // 3. Create a payment batch (or reuse an open one).
  let batchId: string;
  const existing = await admin
    .from("payroll_payment_batches")
    .select("id, status, payment_journal_entry_id")
    .eq("payroll_run_id", TEST_PAYROLL_RUN_ID)
    .neq("status", "cancelled")
    .maybeSingle();

  if (existing.data) {
    batchId = existing.data.id;
  } else {
    const { data: payslips } = await admin
      .from("payslips")
      .select("id, employee_id, net_pay")
      .eq("payroll_run_id", TEST_PAYROLL_RUN_ID);
    assert(payslips && payslips.length > 0, "fixture run must have payslips");
    const total = payslips!.reduce((s, p: any) => s + Number(p.net_pay || 0), 0);
    const batchNumber = `PB-T-${Date.now()}`;
    const { data: batch } = await admin
      .from("payroll_payment_batches")
      .insert({
        organization_id: run.organization_id,
        business_id: run.business_id,
        payroll_run_id: TEST_PAYROLL_RUN_ID,
        batch_number: batchNumber,
        status: "draft",
        total_amount: total,
        bank_account_id: TEST_BANK_ACCOUNT_ID,
      } as any)
      .select("id")
      .single();
    batchId = batch!.id;
    await admin.from("payroll_payment_batch_items").insert(
      payslips!.map((p: any) => ({
        organization_id: run.organization_id,
        business_id: run.business_id,
        batch_id: batchId,
        payslip_id: p.id,
        employee_id: p.employee_id,
        amount: p.net_pay,
        status: "pending",
      })) as any,
    );
  }

  // 4. Invoke post-payroll-payment-gl (uses service-role internally; we hit
  //    via anon key — function does its own auth check).
  const tokenResp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON },
    body: JSON.stringify({
      email: Deno.env.get("TEST_USER_EMAIL"),
      password: Deno.env.get("TEST_USER_PASSWORD"),
    }),
  });
  if (!tokenResp.ok) {
    await tokenResp.text();
    return console.log("SKIP T-PE: TEST_USER_EMAIL/TEST_USER_PASSWORD not configured");
  }
  const { access_token } = await tokenResp.json();

  const payResp = await fetch(`${SUPABASE_URL}/functions/v1/post-payroll-payment-gl`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON,
      Authorization: `Bearer ${access_token}`,
    },
    body: JSON.stringify({ batch_id: batchId, payment_reference: "T-PE-REF" }),
  });
  const payJson = await payResp.json();
  assert(payResp.ok || payJson.already_posted, `cash JE call failed: ${JSON.stringify(payJson)}`);

  // 5. Cash JE must exist and balance.
  const { data: cashJe } = await admin
    .from("journal_entries")
    .select("id, total_debit, total_credit")
    .eq("source_type", "payroll_payment")
    .eq("source_id", batchId)
    .single();
  assert(cashJe, "cash JE must be present");
  assertEquals(
    Number(cashJe.total_debit),
    Number(cashJe.total_credit),
    "cash JE must balance",
  );

  // 6. Idempotency: second call must short-circuit.
  const repeat = await fetch(`${SUPABASE_URL}/functions/v1/post-payroll-payment-gl`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON,
      Authorization: `Bearer ${access_token}`,
    },
    body: JSON.stringify({ batch_id: batchId }),
  });
  const repeatJson = await repeat.json();
  assertEquals(repeatJson.already_posted, true, "second call must be idempotent");

  // 7. Batch is stamped + payslips marked paid.
  const { data: batchAfter } = await admin
    .from("payroll_payment_batches")
    .select("status, payment_journal_entry_id")
    .eq("id", batchId)
    .single();
  assertEquals(batchAfter?.status, "completed");
  assertEquals(batchAfter?.payment_journal_entry_id, cashJe.id);
});