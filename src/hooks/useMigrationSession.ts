import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "./use-toast";
import {
  MigrationSession,
  MigrationStep,
  MigrationBatch,
  StepKey,
  StepStatus,
  MIGRATION_STEPS_CONFIG,
  RollbackableStepKey,
  STEP_ROLLBACK_CONFIG,
} from "@/lib/migration/types";
import { normalizeError } from "@/services/resilience";

export function useMigrationSession() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const repairAttemptedRef = useRef<string | null>(null);

  // Fetch active session
  const {
    data: session,
    isLoading: sessionLoading,
  } = useQuery({
    queryKey: ["migration-session", orgId, businessId],
    queryFn: async () => {
      if (!orgId) return null;
      const query = supabase
        .from("migration_sessions")
        .select("*")
        .eq("organization_id", orgId)
        .in("status", ["draft", "in_progress", "validating"])
        .order("created_at", { ascending: false })
        .limit(1);

      if (businessId) {
        query.eq("business_id", businessId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data?.[0] as unknown as MigrationSession) || null;
    },
    enabled: !!orgId,
  });

  // Fetch steps for session
  const { data: steps = [], isLoading: stepsLoading } = useQuery({
    queryKey: ["migration-steps", session?.id],
    queryFn: async () => {
      if (!session?.id) return [];
      const { data, error } = await supabase
        .from("migration_steps")
        .select("*")
        .eq("session_id", session.id)
        .order("step_order", { ascending: true });
      if (error) throw error;
      return data as unknown as MigrationStep[];
    },
    enabled: !!session?.id,
  });

  // Fetch batches for session
  const { data: batches = [] } = useQuery({
    queryKey: ["migration-batches", session?.id],
    queryFn: async () => {
      if (!session?.id) return [];
      const { data, error } = await supabase
        .from("migration_batches")
        .select("*")
        .eq("session_id", session.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as unknown as MigrationBatch[];
    },
    enabled: !!session?.id,
  });

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["migration-session"] });
    queryClient.invalidateQueries({ queryKey: ["migration-steps"] });
    queryClient.invalidateQueries({ queryKey: ["migration-batches"] });
  }, [queryClient]);

  // ─── SELF-HEALING: Re-create missing steps ──────────────────────
  useEffect(() => {
    if (!session?.id || steps.length > 0) return;
    if (repairAttemptedRef.current === session.id) return; // already tried for this session

    repairAttemptedRef.current = session.id;

    const repairSteps = async () => {
      console.log("[Migration] Self-healing: session exists but 0 steps found. Re-creating steps for", session.id);
      const stepInserts = MIGRATION_STEPS_CONFIG.map((s) => ({
        session_id: session.id,
        step_key: s.key,
        step_order: s.order,
        status: "pending" as StepStatus,
      }));

      const { error } = await supabase
        .from("migration_steps")
        .upsert(stepInserts, { onConflict: "session_id,step_key", ignoreDuplicates: true });

      if (error) {
        console.error("[Migration] Self-healing insert failed:", error);
        toast({
          title: "Migration recovery failed",
          description: `Error: ${normalizeError(error).message || error.code || 'Unknown'}. Try abandoning this session and starting fresh.`,
          variant: "destructive",
        });
      } else {
        console.log("[Migration] Self-healing: steps re-created successfully");
        invalidate();
      }
    };

    repairSteps();
  }, [session?.id, steps.length, invalidate, toast]);

  // Create new session
  const createSession = useMutation({
    mutationFn: async (params: { cutoverDate?: string; sourceSystem?: string; notes?: string; migrationStrategy?: string }) => {
      if (!orgId || !user) throw new Error("Organization or user not available");

      const { data: sessionData, error: sessionError } = await supabase
        .from("migration_sessions")
        .insert({
          organization_id: orgId,
          business_id: businessId || null,
          status: "draft",
          cutover_date: params.cutoverDate || null,
          source_system: params.sourceSystem || null,
          notes: params.notes || null,
          created_by: user.id,
          migration_strategy: params.migrationStrategy || "summary",
        } as any)
        .select()
        .single();

      if (sessionError) throw sessionError;

      // Create all steps
      const stepInserts = MIGRATION_STEPS_CONFIG.map((s) => ({
        session_id: sessionData.id,
        step_key: s.key,
        step_order: s.order,
        status: "pending" as StepStatus,
      }));

      const { error: stepsError } = await supabase
        .from("migration_steps")
        .insert(stepInserts);

      if (stepsError) {
        console.error("[Migration] Step creation failed:", stepsError);
        throw stepsError;
      }

      // Verify steps were actually created (RLS can silently block)
      const { count } = await supabase
        .from("migration_steps")
        .select("id", { count: "exact", head: true })
        .eq("session_id", sessionData.id);

      if (!count || count === 0) {
        console.warn("[Migration] Steps insert returned no error but 0 rows created. Retrying...");
        // Retry once
        const { error: retryError } = await supabase
          .from("migration_steps")
          .insert(stepInserts);

        if (retryError) {
          console.error("[Migration] Retry also failed:", retryError);
        }

        // Check again
        const { count: retryCount } = await supabase
          .from("migration_steps")
          .select("id", { count: "exact", head: true })
          .eq("session_id", sessionData.id);

        if (!retryCount || retryCount === 0) {
          throw new Error("Failed to create migration steps. This may be a permissions issue. Please refresh and try again.");
        }
      }

      return sessionData;
    },
    onSuccess: () => {
      toast({ title: "Migration session created" });
      invalidate();
    },
    onError: (err: any) => {
      toast({ title: "Error creating session", description: normalizeError(err).message, variant: "destructive" });
    },
  });

  // Update step status
  const updateStepStatus = useCallback(
    async (stepKey: StepKey, status: StepStatus, extra?: { record_count?: number; error_count?: number; error_log?: any[] }) => {
      if (!session?.id) return;

      const updates: any = {
        status,
        updated_at: new Date().toISOString(),
      };

      if (status === "in_progress") updates.started_at = new Date().toISOString();
      if (status === "completed" || status === "failed") updates.completed_at = new Date().toISOString();
      if (extra?.record_count !== undefined) updates.record_count = extra.record_count;
      if (extra?.error_count !== undefined) updates.error_count = extra.error_count;
      if (extra?.error_log !== undefined) updates.error_log = extra.error_log;

      const { error } = await supabase
        .from("migration_steps")
        .update(updates)
        .eq("session_id", session.id)
        .eq("step_key", stepKey);

      if (error) throw error;
      invalidate();
    },
    [session?.id, invalidate]
  );

  // Update session status
  const updateSessionStatus = useCallback(
    async (status: MigrationSession["status"]) => {
      if (!session?.id) return;

      const updates: any = { status, updated_at: new Date().toISOString() };
      if (status === "in_progress") updates.started_at = new Date().toISOString();
      if (status === "completed") updates.completed_at = new Date().toISOString();

      const { error } = await supabase
        .from("migration_sessions")
        .update(updates)
        .eq("id", session.id);

      if (error) throw error;
      invalidate();
    },
    [session?.id, invalidate]
  );

  // Check if a step's prerequisites are met
  const canProceedToStep = useCallback(
    (stepKey: StepKey): boolean => {
      const config = MIGRATION_STEPS_CONFIG.find((s) => s.key === stepKey);
      if (!config) return false;
      if (config.prerequisites.length === 0) return true;

      return config.prerequisites.every((prereq) => {
        const prereqStep = steps.find((s) => s.step_key === prereq);
        return prereqStep?.status === "completed" || prereqStep?.status === "skipped";
      });
    },
    [steps]
  );

  // Record a batch import
  const recordBatch = useCallback(
    async (params: {
      stepKey: StepKey;
      batchHash: string;
      sourceFileName?: string;
      recordsTotal: number;
      recordsImported: number;
      recordsFailed: number;
      errorDetails?: any[];
    }) => {
      if (!session?.id) return;

      const { error } = await supabase.from("migration_batches").insert({
        session_id: session.id,
        step_key: params.stepKey,
        batch_hash: params.batchHash,
        source_file_name: params.sourceFileName || null,
        records_total: params.recordsTotal,
        records_imported: params.recordsImported,
        records_failed: params.recordsFailed,
        error_details: params.errorDetails || [],
      });

      if (error) {
        if (error.code === "23505") {
          toast({
            title: "Duplicate import detected",
            description: "This file has already been imported in this session.",
            variant: "destructive",
          });
        }
        throw error;
      }
      invalidate();
    },
    [session?.id, invalidate, toast]
  );

  // Check if batch hash already exists (idempotency)
  const isBatchDuplicate = useCallback(
    async (batchHash: string): Promise<boolean> => {
      if (!session?.id) return false;
      const { data } = await supabase
        .from("migration_batches")
        .select("id")
        .eq("session_id", session.id)
        .eq("batch_hash", batchHash)
        .limit(1);
      return (data?.length ?? 0) > 0;
    },
    [session?.id]
  );

  // ─── ROLLBACK STEP ───────────────────────────────────────────────
  const rollbackStep = useCallback(
    async (stepKey: RollbackableStepKey): Promise<{ deleted: Record<string, number> }> => {
      if (!session?.id || !orgId) throw new Error("No active session");

      const config = STEP_ROLLBACK_CONFIG[stepKey];
      const deleted: Record<string, number> = {};

      // Delete invoices created by this migration session
      if (config.deleteInvoices) {
        // First, find the invoices to get their IDs for JE cleanup
        const { data: invoices } = await supabase
          .from("invoices")
          .select("id, journal_entry_id")
          .eq("migration_session_id", session.id);

        // Delete per-invoice JEs (full_transaction mode creates individual JEs with source_type="invoice")
        if (invoices) {
          const jeIds = invoices.map(i => i.journal_entry_id).filter(Boolean) as string[];
          if (jeIds.length > 0) {
            await supabase.from("journal_entry_lines").delete().in("journal_entry_id", jeIds);
            await supabase.from("journal_entries").delete().in("id", jeIds);
            deleted.invoice_journal_entries = jeIds.length;
          }
        }

        const { data } = await supabase
          .from("invoices")
          .delete()
          .eq("migration_session_id", session.id)
          .select("id");
        deleted.invoices = data?.length || 0;
      }

      // Delete bills created by this migration session
      if (config.deleteBills) {
        const { data: bills } = await supabase
          .from("bills")
          .select("id, journal_entry_id")
          .eq("migration_session_id", session.id);

        // Delete per-bill JEs (full_transaction mode)
        if (bills) {
          const jeIds = bills.map(b => b.journal_entry_id).filter(Boolean) as string[];
          if (jeIds.length > 0) {
            await supabase.from("journal_entry_lines").delete().in("journal_entry_id", jeIds);
            await supabase.from("journal_entries").delete().in("id", jeIds);
            deleted.bill_journal_entries = jeIds.length;
          }
        }

        const { data } = await supabase
          .from("bills")
          .delete()
          .eq("migration_session_id", session.id)
          .select("id");
        deleted.bills = data?.length || 0;
      }

      // Delete payments linked to this migration session
      if (config.deletePayments) {
        // Primary: find payments by migration_session_id (new approach)
        const { data: payments } = await supabase
          .from("payments")
          .select("id, journal_entry_id")
          .eq("migration_session_id", session.id);

        let paymentsList = payments || [];

        // Fallback: if no payments found by session ID, try via migrated invoices (legacy)
        if (paymentsList.length === 0) {
          const { data: migratedInvoices } = await supabase
            .from("invoices")
            .select("id")
            .eq("migration_session_id", session.id);

          if (migratedInvoices && migratedInvoices.length > 0) {
            const invoiceIds = migratedInvoices.map(i => i.id);
            // Payments link to invoices via payment_allocations, not directly.
            const { data: allocs } = await supabase
              .from("payment_allocations")
              .select("payment_id")
              .in("invoice_id", invoiceIds);
            const payIds = Array.from(new Set(((allocs ?? []) as Array<{ payment_id: string | null }>).map(a => a.payment_id).filter(Boolean) as string[]));
            if (payIds.length > 0) {
              const { data: legacyPayments } = await (supabase as any)
                .from("payments")
                .select("id, journal_entry_id")
                .in("id", payIds);
              paymentsList = legacyPayments || [];
            }
          }
        }

        if (paymentsList.length > 0) {
          const jeIds = paymentsList.map(p => p.journal_entry_id).filter(Boolean) as string[];
          if (jeIds.length > 0) {
            await supabase.from("journal_entry_lines").delete().in("journal_entry_id", jeIds);
            await supabase.from("journal_entries").delete().in("id", jeIds);
            deleted.payment_journal_entries = jeIds.length;
          }

          const paymentIds = paymentsList.map(p => p.id);
          await supabase.from("payments").delete().in("id", paymentIds);
          deleted.payments = paymentsList.length;
        }
      }

      // Delete stock movements created by this migration session
      if (config.deleteStockMovements) {
        const { data } = await supabase
          .from("stock_movements")
          .delete()
          .eq("migration_session_id", session.id)
          .select("id");
        deleted.stock_movements = data?.length || 0;
      }

      // Delete migration journal entries (source_type = 'migration')
      if (config.deleteJournalEntries) {
        const { data: entries } = await supabase
          .from("journal_entries")
          .select("id")
          .eq("organization_id", orgId)
          .eq("business_id", currentBusiness.id)
          .eq("source_type", "migration")
          .like("source_id", `migration-ob-${session.id}%`);

        if (entries && entries.length > 0) {
          const entryIds = entries.map((e) => e.id);
          await supabase
            .from("journal_entry_lines")
            .delete()
            .in("journal_entry_id", entryIds);
          await supabase
            .from("journal_entries")
            .delete()
            .in("id", entryIds);
          deleted.journal_entries = entryIds.length;
        }
      }

      // Reset opening balances on accounts — scoped to accounts modified by this migration
      if (config.resetOpeningBalances) {
        // Look up which account IDs were modified by reading batch metadata
        const { data: batchData } = await supabase
          .from("migration_batches")
          .select("error_details")
          .eq("session_id", session.id)
          .eq("step_key", stepKey);

        // Extract affected account IDs stored during trial balance import
        const affectedAccountIds: string[] = [];
        for (const batch of (batchData || [])) {
          const details = batch.error_details as any;
          if (details?.affected_account_ids && Array.isArray(details.affected_account_ids)) {
            affectedAccountIds.push(...details.affected_account_ids);
          }
        }

        if (affectedAccountIds.length > 0) {
          // Scoped reset — only reset accounts modified by this migration
          await supabase
            .from("accounts")
            .update({ opening_balance: 0 })
            .in("id", affectedAccountIds);
          deleted.opening_balances_reset = affectedAccountIds.length;
        } else {
          // Fallback: reset all non-zero opening balances (legacy sessions without metadata)
          await supabase
            .from("accounts")
            .update({ opening_balance: 0 })
            .eq("organization_id", orgId)
            .eq("business_id", currentBusiness.id)
            .neq("opening_balance", 0);
          deleted.opening_balances_reset = 1;
        }
      }

      // Reset bank account opening balances
      if (config.resetBankBalances) {
        // Wave 1: the server reverses any posted opening-balance journal entry
        // before clearing the figure, so the ledger never keeps an orphan.
        const { data } = await supabase.rpc("bank_account_reset_opening_balances", {
          _business_id: currentBusiness.id,
        });
        deleted.bank_balances = (data as number | null) ?? 0;
      }


      // Delete batches for this step
      await supabase
        .from("migration_batches")
        .delete()
        .eq("session_id", session.id)
        .eq("step_key", stepKey);

      // Reset step status to pending
      await updateStepStatus(stepKey, "pending", { record_count: 0, error_count: 0, error_log: [] });

      toast({
        title: `Step "${stepKey}" rolled back`,
        description: `Deleted: ${Object.entries(deleted).map(([k, v]) => `${v} ${k}`).join(", ")}`,
      });

      invalidate();
      return { deleted };
    },
    [session?.id, orgId, updateStepStatus, invalidate, toast]
  );

  // ─── FINALIZATION: Lock fiscal periods at/before cutover ────────
  const finalizeMigration = useCallback(
    async () => {
      if (!session?.id || !orgId || !user) throw new Error("No active session");

      const cutoverDate = session.cutover_date;

      // Lock fiscal periods that end on or before the cutover date
      if (cutoverDate) {
        await supabase
          .from("fiscal_periods")
          .update({
            status: "closed",
            locked_at: new Date().toISOString(),
            locked_by: user.id,
          })
          .eq("organization_id", orgId)
          .eq("business_id", currentBusiness.id)
          .lte("end_date", cutoverDate)
          .neq("status", "closed");
      }

      // Mark session completed
      await updateSessionStatus("completed");
      await updateStepStatus("finalization", "completed");
    },
    [session?.id, session?.cutover_date, orgId, user, updateSessionStatus, updateStepStatus]
  );

  // Update migration strategy (only allowed in draft state with no data-import steps completed)
  const updateStrategy = useMutation({
    mutationFn: async (newStrategy: string) => {
      if (!session?.id) throw new Error("No active session");
      if (session.status !== "draft" && session.status !== "in_progress") {
        throw new Error("Cannot change strategy after migration is complete");
      }

      // Check that no data-import steps have been completed
      const dataSteps: StepKey[] = ["trial_balance", "open_ar", "open_ap", "payments", "bank_balances", "inventory"];
      const completedDataSteps = steps.filter(
        (s) => dataSteps.includes(s.step_key as StepKey) && (s.status === "completed")
      );
      if (completedDataSteps.length > 0) {
        throw new Error("Cannot change strategy after data import steps have been completed. Roll back completed import steps first.");
      }

      const { error } = await supabase
        .from("migration_sessions")
        .update({ migration_strategy: newStrategy, updated_at: new Date().toISOString() } as any)
        .eq("id", session.id);

      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Migration strategy updated" });
      invalidate();
    },
    onError: (err: any) => {
      toast({ title: "Cannot change strategy", description: normalizeError(err).message, variant: "destructive" });
    },
  });

  // Check if strategy can be changed
  const canChangeStrategy = (() => {
    if (!session) return false;
    if (session.status !== "draft" && session.status !== "in_progress") return false;
    const dataSteps: StepKey[] = ["trial_balance", "open_ar", "open_ap", "payments", "bank_balances", "inventory"];
    return !steps.some(
      (s) => dataSteps.includes(s.step_key as StepKey) && s.status === "completed"
    );
  })();

  // ─── ABANDON SESSION ─────────────────────────────────────────────
  const abandonSession = useMutation({
    mutationFn: async () => {
      if (!session?.id) throw new Error("No active session");

      // Delete batches first (FK dependency)
      await supabase
        .from("migration_batches")
        .delete()
        .eq("session_id", session.id);

      // Delete steps
      await supabase
        .from("migration_steps")
        .delete()
        .eq("session_id", session.id);

      // Delete the session itself
      const { error } = await supabase
        .from("migration_sessions")
        .delete()
        .eq("id", session.id);

      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Migration abandoned", description: "You can start a fresh migration." });
      repairAttemptedRef.current = null;
      invalidate();
    },
    onError: (err: any) => {
      toast({ title: "Failed to abandon migration", description: normalizeError(err).message, variant: "destructive" });
    },
  });

  return {
    session,
    steps,
    batches,
    isLoading: sessionLoading || stepsLoading,
    createSession,
    updateStepStatus,
    updateSessionStatus,
    canProceedToStep,
    recordBatch,
    isBatchDuplicate,
    rollbackStep,
    finalizeMigration,
    invalidate,
    updateStrategy,
    canChangeStrategy,
    abandonSession,
  };
}
