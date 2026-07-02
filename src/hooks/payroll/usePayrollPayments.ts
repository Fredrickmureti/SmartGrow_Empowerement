import { normalizeError } from "@/services/resilience";
/**
 * Payroll payment lifecycle actions.
 *
 * - createBatch: take a posted payroll run, create a payroll_payment_batch
 *   + one item per payslip. Captures the bank account the disbursement will
 *   come from. Idempotent against an existing non-cancelled batch.
 * - markBatchPaid: delegated to the `post-payroll-payment-gl` edge function
 *   which atomically marks items paid, stamps payslips, and posts the
 *   cash-side journal entry (DR Net Salary Payable / CR Bank). Idempotent.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { usePermissions } from "@/hooks/usePermissions";
import { toast } from "sonner";

export function usePayrollPayments() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { canPayPayroll } = usePermissions();
  const qc = useQueryClient();

  const createBatch = useMutation({
    mutationFn: async (params: { payroll_run_id: string; bank_account_id: string; source_batch_id?: string | null }) => {
      // SoD: only treasury role (`payPayroll`) can create disbursement batches.
      if (!canPayPayroll) throw new Error("You don't have permission to disburse payroll");
      if (!currentOrg?.id || !currentBusiness?.id) throw new Error("Select a company first");
      if (!params.bank_account_id) throw new Error("Pick a bank account for the disbursement");

      // Idempotency
      const { data: existing } = await supabase
        .from("payroll_payment_batches")
        .select("id, status")
        .eq("payroll_run_id", params.payroll_run_id)
        .neq("status", "cancelled" as any)
        .maybeSingle();
      if (existing) throw new Error(`A batch already exists for this run (${existing.status}).`);

      // Pull the run's payslips
      const { data: payslips, error: psErr } = await supabase
        .from("payslips")
        .select("id, employee_id, net_pay")
        .eq("payroll_run_id", params.payroll_run_id);
      if (psErr) throw psErr;
      if (!payslips || payslips.length === 0) throw new Error("Run has no payslips");

      const total = payslips.reduce((s, p) => s + Number(p.net_pay || 0), 0);
      const batchNumber = `PB-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${params.payroll_run_id.slice(0, 4)}`;

      const { data: batch, error: bErr } = await supabase
        .from("payroll_payment_batches")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          payroll_run_id: params.payroll_run_id,
          batch_number: batchNumber,
          status: "draft" as any,
          total_amount: total,
          bank_account_id: params.bank_account_id,
          source_batch_id: params.source_batch_id ?? null,
        } as any)
        .select("id")
        .single();
      if (bErr) throw bErr;

      const items = payslips.map((p) => ({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        batch_id: batch!.id,
        payslip_id: p.id,
        employee_id: p.employee_id,
        amount: p.net_pay,
        status: "pending" as any,
      }));
      const { error: iErr } = await supabase.from("payroll_payment_batch_items").insert(items as any);
      if (iErr) throw iErr;

      return batch!.id;
    },
    onSuccess: () => {
      toast.success("Payment batch created");
      qc.invalidateQueries({ queryKey: ["payroll-payment-batches"] });
    },
    onError: (e: any) => toast.error(normalizeError(e).message || "Could not create batch"),
  });

  const markBatchPaid = useMutation({
    mutationFn: async (params: { batch_id: string; payment_reference?: string; payment_date?: string }) => {
      // SoD: only treasury role (`payPayroll`) can confirm a disbursement.
      if (!canPayPayroll) throw new Error("You don't have permission to mark batches paid");
      // All side effects (mark items paid, stamp payslips, post cash JE) run
      // server-side under service role for atomicity + status guards.
      const { data, error } = await supabase.functions.invoke("post-payroll-payment-gl", {
        body: {
          batch_id: params.batch_id,
          payment_reference: params.payment_reference || null,
          payment_date: params.payment_date || null,
        },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      return (data as any)?.payslip_count ?? 0;
    },
    onSuccess: (n) => {
      toast.success(`${n} payslip(s) marked paid · cash JE posted`);
      qc.invalidateQueries({ queryKey: ["payroll-payment-batches"] });
      qc.invalidateQueries({ queryKey: ["all-payslips"] });
      qc.invalidateQueries({ queryKey: ["journal-entries"] });
    },
    onError: (e: any) => toast.error(normalizeError(e).message || "Could not mark paid"),
  });

  // ─── Phase A — batch lifecycle RPCs (server-enforced state machine) ─────
  // Every transition routes through the matching SECURITY DEFINER RPC so
  // sod_payroll_payment_batches_guard fires and the business_event_outbox
  // emits a `payroll_payment_batch.*` event. Never call .update() directly.
  function invalidateBatches() {
    qc.invalidateQueries({ queryKey: ["payroll-payment-batches"] });
    qc.invalidateQueries({ queryKey: ["payroll-payment-reconciliation"] });
  }

  const approveBatch = useMutation({
    mutationFn: async (p: { batch_id: string; note?: string }) => {
      if (!canPayPayroll) throw new Error("You don't have permission to approve batches");
      const { error } = await supabase.rpc("payroll_payment_batch_approve" as any, {
        p_batch_id: p.batch_id, p_note: p.note ?? null,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Batch approved"); invalidateBatches(); },
    onError: (e: any) => toast.error(normalizeError(e).message || "Approve failed"),
  });

  const lockBatch = useMutation({
    mutationFn: async (p: { batch_id: string }) => {
      if (!canPayPayroll) throw new Error("You don't have permission to lock batches");
      const { error } = await supabase.rpc("payroll_payment_batch_lock" as any, {
        p_batch_id: p.batch_id,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Batch locked"); invalidateBatches(); },
    onError: (e: any) => toast.error(normalizeError(e).message || "Lock failed"),
  });

  const markBatchExported = useMutation({
    mutationFn: async (p: { batch_id: string; template_code: string }) => {
      if (!canPayPayroll) throw new Error("You don't have permission");
      const { error } = await supabase.rpc("payroll_payment_batch_mark_exported" as any, {
        p_batch_id: p.batch_id, p_template_code: p.template_code,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Batch marked exported"); invalidateBatches(); },
    onError: (e: any) => toast.error(normalizeError(e).message || "Mark exported failed"),
  });

  const markBatchTransmitted = useMutation({
    mutationFn: async (p: { batch_id: string; reference?: string }) => {
      if (!canPayPayroll) throw new Error("You don't have permission");
      const { error } = await supabase.rpc("payroll_payment_batch_mark_transmitted" as any, {
        p_batch_id: p.batch_id, p_reference: p.reference ?? null,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Batch marked transmitted"); invalidateBatches(); },
    onError: (e: any) => toast.error(normalizeError(e).message || "Mark transmitted failed"),
  });

  const cancelBatch = useMutation({
    mutationFn: async (p: { batch_id: string; reason: string }) => {
      if (!canPayPayroll) throw new Error("You don't have permission to cancel batches");
      if (!p.reason || p.reason.trim().length < 3) throw new Error("Cancel reason required (min 3 chars)");
      const { error } = await supabase.rpc("payroll_payment_batch_cancel" as any, {
        p_batch_id: p.batch_id, p_reason: p.reason,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Batch cancelled"); invalidateBatches(); },
    onError: (e: any) => toast.error(normalizeError(e).message || "Cancel failed"),
  });

  const reverseBatch = useMutation({
    mutationFn: async (p: { batch_id: string; reason: string }) => {
      if (!canPayPayroll) throw new Error("You don't have permission to reverse batches");
      if (!p.reason || p.reason.trim().length < 3) throw new Error("Reverse reason required (min 3 chars)");
      const { error } = await supabase.rpc("payroll_payment_batch_reverse" as any, {
        p_batch_id: p.batch_id, p_reason: p.reason,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Batch reversed");
      invalidateBatches();
      qc.invalidateQueries({ queryKey: ["all-payslips"] });
      qc.invalidateQueries({ queryKey: ["journal-entries"] });
    },
    onError: (e: any) => toast.error(normalizeError(e).message || "Reverse failed"),
  });

  // ─── Phase B — per-item lifecycle RPCs ──────────────────────────────────
  // All transitions go through SECURITY DEFINER RPCs so the per-item
  // lifecycle trigger fires and audit columns (held_by/cancelled_by/etc.)
  // are stamped from auth.uid(). Never call .update() directly on items.
  function invalidateItems() {
    qc.invalidateQueries({ queryKey: ["payroll-payment-batches"] });
    qc.invalidateQueries({ queryKey: ["payroll-failed-items"] });
    qc.invalidateQueries({ queryKey: ["payroll-payment-batch-items"] });
  }

  const holdItem = useMutation({
    mutationFn: async (p: { item_id: string; reason: string }) => {
      if (!canPayPayroll) throw new Error("You don't have permission");
      if (!p.reason || p.reason.trim().length < 3) throw new Error("Hold reason required (min 3 chars)");
      const { error } = await supabase.rpc("payroll_payment_item_hold" as any, {
        _item_id: p.item_id, _reason: p.reason,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Item held"); invalidateItems(); },
    onError: (e: any) => toast.error(normalizeError(e).message || "Hold failed"),
  });

  const releaseItem = useMutation({
    mutationFn: async (p: { item_id: string }) => {
      if (!canPayPayroll) throw new Error("You don't have permission");
      const { error } = await supabase.rpc("payroll_payment_item_release" as any, {
        _item_id: p.item_id,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Item released"); invalidateItems(); },
    onError: (e: any) => toast.error(normalizeError(e).message || "Release failed"),
  });

  const retryItem = useMutation({
    mutationFn: async (p: { item_id: string }) => {
      if (!canPayPayroll) throw new Error("You don't have permission");
      const { error } = await supabase.rpc("payroll_payment_item_retry" as any, {
        _item_id: p.item_id,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Item queued for retry"); invalidateItems(); },
    onError: (e: any) => toast.error(normalizeError(e).message || "Retry failed"),
  });

  const markItemFailed = useMutation({
    mutationFn: async (p: { item_id: string; failure_reason: string }) => {
      if (!canPayPayroll) throw new Error("You don't have permission");
      if (!p.failure_reason || p.failure_reason.trim().length < 3) throw new Error("Failure reason required (min 3 chars)");
      const { error } = await supabase.rpc("payroll_payment_item_mark_failed" as any, {
        _item_id: p.item_id, _failure_reason: p.failure_reason,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Item marked failed"); invalidateItems(); },
    onError: (e: any) => toast.error(normalizeError(e).message || "Mark failed failed"),
  });

  const cancelItem = useMutation({
    mutationFn: async (p: { item_id: string; reason: string }) => {
      if (!canPayPayroll) throw new Error("You don't have permission");
      if (!p.reason || p.reason.trim().length < 3) throw new Error("Cancel reason required (min 3 chars)");
      const { error } = await supabase.rpc("payroll_payment_item_cancel" as any, {
        _item_id: p.item_id, _reason: p.reason,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Item cancelled"); invalidateItems(); },
    onError: (e: any) => toast.error(normalizeError(e).message || "Cancel failed"),
  });

  const markItemPaid = useMutation({
    mutationFn: async (p: { item_id: string; payment_reference?: string; paid_amount?: number }) => {
      if (!canPayPayroll) throw new Error("You don't have permission");
      const { error } = await supabase.rpc("payroll_payment_item_mark_paid" as any, {
        _item_id: p.item_id,
        _payment_reference: p.payment_reference ?? null,
        _paid_amount: p.paid_amount ?? null,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Item marked paid"); invalidateItems(); },
    onError: (e: any) => toast.error(normalizeError(e).message || "Mark paid failed"),
  });

  return {
    createBatch, markBatchPaid,
    approveBatch, lockBatch, markBatchExported, markBatchTransmitted,
    cancelBatch, reverseBatch,
    holdItem, releaseItem, retryItem, markItemFailed, cancelItem, markItemPaid,
  };
}
