import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "./use-toast";
import { queryKeys } from "@/lib/queryKeys";
import { applyBranchFilter } from "@/lib/branchScope";
import type { RecurringInvoiceStatus } from "@/lib/recurringLifecycle";

export interface RecurringInvoiceItem {
  id?: string;
  recurring_invoice_id?: string;
  product_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  discount_percent: number;
  sort_order: number;
}

export interface RecurringInvoice {
  id: string;
  organization_id: string;
  contact_id: string | null;
  template_name: string;
  notes: string | null;
  terms: string | null;
  currency: string;
  frequency: "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";
  start_date: string;
  end_date: string | null;
  next_run_date: string;
  last_run_date: string | null;
  /** Derived from `status` by the database; read-only for the client. */
  is_active: boolean;
  status: RecurringInvoiceStatus;
  status_changed_at?: string;
  definition_version?: number;
  auto_send: boolean;
  auto_confirm?: boolean;
  days_before_due: number;
  invoices_generated: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  contact?: { name: string; email: string | null } | null;
  items?: RecurringInvoiceItem[];
}

async function fetchRecurringFn(orgId: string, businessId?: string | null, branchId?: string | null) {
  let query = supabase
    .from("recurring_invoices")
    .select(`
      *,
      contact:contacts(name, email),
      items:recurring_invoice_items(*)
    `)
    .eq("organization_id", orgId);

  if (businessId) {
    query = query.eq("business_id", businessId);
  }
  // Sales audit Phase A: enforce branch isolation.
  query = applyBranchFilter(query, branchId ?? null);

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw error;
  return (data as unknown as RecurringInvoice[]) || [];
}

export function useRecurringInvoices() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const branchId = currentBranch?.id ?? null;

  const { data: recurringInvoices = [], isLoading } = useQuery({
    queryKey: [...queryKeys.recurringInvoices.list(orgId!, businessId), branchId],
    queryFn: () => fetchRecurringFn(orgId!, businessId, branchId),
    enabled: !!orgId,
  });

  const invalidate = useCallback(() => {
    if (!orgId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.recurringInvoices.all(orgId) });
  }, [queryClient, orgId]);

  const createRecurringInvoice = async (
    recurringInvoice: Omit<
      RecurringInvoice,
      "id" | "organization_id" | "created_at" | "updated_at" | "created_by" | "contact" | "items" | "invoices_generated" | "last_run_date" | "status" | "status_changed_at" | "definition_version"
    >,
    items: Omit<RecurringInvoiceItem, "id" | "recurring_invoice_id">[]
  ) => {
    if (!currentOrg || !user) throw new Error("No organization selected");

    // `is_active` is a derived mirror of `status`; a new template is born
    // active or paused, never in a terminal state.
    const { is_active: startsActive, ...templateFields } = recurringInvoice;

    const { data: created, error: riError } = await supabase
      .from("recurring_invoices")
      .insert({
        ...templateFields,
        status: startsActive === false ? "paused" : "active",
        is_active: startsActive !== false,
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id || null,
        branch_id: currentBranch?.id ?? null,
        created_by: user.id,
      })
      .select()
      .single();

    if (riError) throw riError;

    if (items.length > 0) {
      const itemsToInsert = items.map((item, index) => ({
        ...item,
        recurring_invoice_id: created.id,
        sort_order: index,
      }));
      const { error: itemsError } = await supabase.from("recurring_invoice_items").insert(itemsToInsert);
      if (itemsError) throw itemsError;
    }

    invalidate();
    return created;
  };

  const updateRecurringInvoice = async (
    id: string,
    updates: Partial<RecurringInvoice>,
    items?: Omit<RecurringInvoiceItem, "id" | "recurring_invoice_id">[]
  ) => {
    if (items !== undefined) {
      await supabase.from("recurring_invoice_items").delete().eq("recurring_invoice_id", id);

      if (items.length > 0) {
        const itemsToInsert = items.map((item, index) => ({
          ...item,
          recurring_invoice_id: id,
          sort_order: index,
        }));
        const { error: itemsError } = await supabase.from("recurring_invoice_items").insert(itemsToInsert);
        if (itemsError) throw itemsError;
      }
    }

    const { contact, items: _i, ...dbUpdates } = updates as any;
    const { error } = await supabase.from("recurring_invoices").update(dbUpdates).eq("id", id);
    if (error) throw error;
    invalidate();
  };

  const deleteRecurringInvoice = async (id: string) => {
    const { error } = await supabase.from("recurring_invoices").delete().eq("id", id);
    if (error) throw error;
    invalidate();
  };

  /**
   * The template lifecycle is owned by the database
   * (`set_recurring_status_atomic`); a trigger rejects any direct `status`
   * write and derives the legacy `is_active` flag from it. The client may
   * only ask for a transition.
   */
  const setRecurringStatus = async (
    id: string,
    status: RecurringInvoiceStatus,
    reason?: string,
  ) => {
    const { error } = await supabase.rpc("set_recurring_status_atomic" as never, {
      p_recurring_id: id,
      p_status: status,
      p_user_id: user?.id ?? null,
      p_reason: reason ?? null,
    } as never);
    if (error) throw error;
    invalidate();
  };

  const toggleActive = async (id: string, isActive: boolean) =>
    setRecurringStatus(id, isActive ? "active" : "paused");

  /**
   * "Generate now" runs the SAME database engine the scheduler uses
   * (`generate_recurring_invoice_occurrence`, via a permission-checked
   * wrapper). The client no longer builds invoices, lines or journal
   * entries: doing so produced a second, divergent billing engine.
   *
   * The call is idempotent — pressing the button twice, or pressing it while
   * the nightly sweep is running, cannot mint two invoices for one period.
   */
  const generateInvoiceNow = async (recurringInvoiceId: string) => {
    const { data, error } = await supabase.rpc("generate_recurring_invoice_now" as never, {
      _recurring_id: recurringInvoiceId,
    } as never);
    if (error) throw error;

    const result = data as unknown as {
      status: "generated" | "posted" | "failed" | "skipped";
      duplicate: boolean;
      invoice_id: string | null;
      invoice_number: string | null;
      period_start: string;
      period_end: string;
      error?: string;
    };

    if (result?.status === "failed") {
      throw new Error(result.error || "Invoice generation failed");
    }

    invalidate();
    queryClient.invalidateQueries({ queryKey: ["invoices"] });
    queryClient.invalidateQueries({ queryKey: ["recurring-invoice-runs"] });

    if (result?.duplicate) {
      toast({
        title: "Already billed",
        description: `This billing period was already invoiced as ${result.invoice_number}.`,
      });
    }

    return result;
  };


  return {
    recurringInvoices,
    activeRecurringInvoices: recurringInvoices.filter((ri) => ri.is_active),
    isLoading,
    createRecurringInvoice,
    updateRecurringInvoice,
    deleteRecurringInvoice,
    toggleActive,
    setRecurringStatus,
    generateInvoiceNow,
    refreshRecurringInvoices: invalidate,
  };
}
