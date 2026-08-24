// @ts-nocheck
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "../useOrganization";
import { useBusinesses } from "../useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

export interface Lead {
  id: string;
  organization_id: string;
  business_id: string | null;
  /**
   * Branch dimension (CRM domain audit · Phase 4). Server-owned: set on
   * create, then only movable through `crm_transfer_lead_branch`.
   */
  branch_id: string | null;
  lead_number: string;
  name: string;
  type: string | null;
  stage_id: string | null;
  contact_id: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  /**
   * FK to contacts.id where is_company=true. The legacy text mirror
   * `crm_leads.company_name` has been dropped — display via `company_contact.name`.
   */
  company_contact_id: string | null;
  expected_revenue: number | null;
  probability: number | null;
  expected_close_date: string | null;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  assigned_to: string | null;
  team_id: string | null;
  priority: number | null;
  tags: string[] | null;
  description: string | null;
  internal_notes: string | null;
  lost_reason_id: string | null;
  lost_notes: string | null;
  won_at: string | null;
  lost_at: string | null;
  is_active: boolean | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  stage?: {
    id: string;
    name: string;
    color: string | null;
    is_won: boolean | null;
    is_lost: boolean | null;
  };
  /** Joined company contact (canonical company display). */
  company_contact?: { id: string; name: string } | null;
  /** Joined lost reason (when lead is in a Lost stage). */
  lost_reason?: { id: string; name: string } | null;
  /** Joined branch (owning branch of the opportunity). */
  branch?: { id: string; name: string } | null;
}

/** Display helper: returns the joined company contact's name (or null). */
export function leadCompanyDisplay(lead: Pick<Lead, "company_contact">): string | null {
  return lead.company_contact?.name ?? null;
}

export function useLeads(filters?: { stageId?: string; type?: string; branchId?: string | null }) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { user } = useAuth();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchLeads = useCallback(async () => {
    if (!currentOrg || !currentBusiness) {
      setLeads([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);

    try {
      let query = supabase
        .from("crm_leads")
        .select(`
          *,
          stage:crm_stages(id, name, color, is_won, is_lost),
          company_contact:contacts!company_contact_id(id, name),
          lost_reason:crm_lost_reasons(id, name)
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("is_active", true)
        .order("created_at", { ascending: false });

      if (filters?.stageId) {
        query = query.eq("stage_id", filters.stageId);
      }

      if (filters?.type) {
        query = query.eq("type", filters.type);
      }

      const { data, error } = await query;
      if (error) throw error;
      setLeads((data || []) as unknown as Lead[]);
    } catch (error) {
      console.error("Error fetching leads:", error);
      toast.error("Failed to fetch leads");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, filters?.stageId, filters?.type]);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  const createLead = async (lead: Partial<Lead>) => {
    if (!currentOrg || !user) throw new Error("No organization selected");
    if (!currentBusiness?.id) {
      throw new Error("Select a Company before creating a lead");
    }

    // Numbering is server-side and atomic (shared document numbering engine).
    // Never fall back to a client-invented number: that reintroduces the
    // duplicate/non-monotonic lead numbers the engine exists to prevent.
    const { data: numberData, error: numberError } = await supabase.rpc("get_next_lead_number", {
      p_org_id: currentOrg.id,
      p_business_id: currentBusiness.id,
    });
    if (numberError) throw numberError;
    if (!numberData) throw new Error("Could not allocate a lead number");

    const insertData = {
      name: lead.name || "New Lead",
      organization_id: currentOrg.id,
      business_id: currentBusiness.id,
      lead_number: numberData,

      type: lead.type || "lead",
      stage_id: lead.stage_id || null,
      contact_id: lead.contact_id || null,
      contact_name: lead.contact_name || null,
      email: lead.email || null,
      phone: lead.phone || null,
      company_contact_id: lead.company_contact_id || null,
      expected_revenue: lead.expected_revenue || null,
      probability: lead.probability || null,
      expected_close_date: lead.expected_close_date || null,
      source: lead.source || null,
      medium: lead.medium || null,
      campaign: lead.campaign || null,
      assigned_to: lead.assigned_to || null,
      priority: lead.priority || 1,
      tags: lead.tags || null,
      description: lead.description || null,
      internal_notes: lead.internal_notes || null,
      is_active: true,
      created_by: user.id,
    };

    const { data, error } = await supabase
      .from("crm_leads")
      .insert(insertData)
      .select()
      .single();

    if (error) throw error;

    toast.success("Lead created");
    // Optimistic update
    setLeads((prev) => [data as unknown as Lead, ...prev]);
    return data;
  };

  /**
   * Descriptive-field update only.
   *
   * Lifecycle fields (`status`, `stage_id`, `won_at`, `lost_at`,
   * `probability`, `is_active`, `type`, `assigned_to`, `lost_reason_id`)
   * are guarded in the database by `_crm_lead_lifecycle_write_guard` and
   * may only move through the `crm_*` transition RPCs below. Expected
   * revenue goes through `crm_revalue_lead` so the change is audited and
   * refused on a closed opportunity.
   */
  const LIFECYCLE_FIELDS = [
    "status",
    "stage_id",
    "won_at",
    "lost_at",
    "probability",
    "is_active",
    "type",
    "assigned_to",
    "lost_reason_id",
    "expected_revenue",
  ] as const;

  const updateLead = async (id: string, updates: Partial<Lead>) => {
    const descriptive: Record<string, any> = { ...updates };
    const lifecycle = LIFECYCLE_FIELDS.filter((f) => f in descriptive);
    for (const f of lifecycle) delete descriptive[f];

    // Expected revenue / close date are audited value changes.
    if ("expected_revenue" in (updates as Record<string, unknown>)) {
      const { error } = await supabase.rpc("crm_revalue_lead", {
        p_lead_id: id,
        p_expected_revenue: (updates as any).expected_revenue ?? null,
        p_expected_close_date: (updates as any).expected_close_date ?? null,
      });
      if (error) throw error;
      delete descriptive.expected_close_date;
    }

    if ((updates as any).assigned_to !== undefined) {
      const { error } = await supabase.rpc("crm_reassign_lead", {
        p_lead_id: id,
        p_assignee: (updates as any).assigned_to ?? null,
      });
      if (error) throw error;
    }

    if (Object.keys(descriptive).length > 0) {
      const { error } = await supabase.from("crm_leads").update(descriptive).eq("id", id);
      if (error) throw error;
    }

    toast.success("Lead updated");
    await fetchLeads();
  };

  /** Qualify a raw lead into an opportunity (authoritative transition). */
  const qualifyLead = async (leadId: string) => {
    const { error } = await supabase.rpc("crm_qualify_lead", { p_lead_id: leadId });
    if (error) throw error;
    toast.success("Lead qualified");
    await fetchLeads();
  };

  /**
   * Stage move. The server resolves the stage's default probability and
   * refuses terminal stages (won/lost go through their own operations),
   * closed opportunities, and stages from another business.
   */
  const moveToStage = async (leadId: string, stageId: string) => {
    const { error } = await supabase.rpc("crm_change_stage", {
      p_lead_id: leadId,
      p_stage_id: stageId,
    });
    if (error) throw error;
    await fetchLeads();
  };

  const markAsWon = async (
    leadId: string,
    options?: {
      createContact?: boolean;
      /** Legacy single-pick (kept for back-compat with existing callers). */
      createDocument?: "none" | "estimate" | "sales_order" | "project";
      /** Preferred: pick any combination. SO + project are auto cross-linked. */
      create?: { estimate?: boolean; salesOrder?: boolean; project?: boolean };
    }
  ): Promise<{ estimateId?: string; salesOrderId?: string; contactId?: string; projectId?: string }> => {
    // Authoritative transition: validates the source state, resolves the
    // business's Won stage, pins probability to 100 and logs a system activity.
    const { error } = await supabase.rpc("crm_mark_won", { p_lead_id: leadId });
    if (error) throw error;

    const result: { estimateId?: string; salesOrderId?: string; contactId?: string; projectId?: string } = {};

    // Normalize the create-set (legacy single-pick → multi-pick).
    const want = {
      estimate: !!options?.create?.estimate || options?.createDocument === "estimate",
      salesOrder: !!options?.create?.salesOrder || options?.createDocument === "sales_order",
      project: !!options?.create?.project || options?.createDocument === "project",
    };

    if (options?.createContact) {
      try {
        const contact = await convertToContact(leadId);
        result.contactId = contact?.id || undefined;
      } catch (e) {
        console.error("Failed to create contact:", e);
      }
    }

    // Estimate first (independent).
    if (want.estimate) {
      const est = await convertToEstimate(leadId);
      result.estimateId = est?.id;
    }

    // Sales order before project so we can pass SO id into project conversion;
    // the project RPC will then close the loop by writing project_id back onto the SO.
    if (want.salesOrder && !want.project) {
      const so = await convertToSalesOrder(leadId);
      result.salesOrderId = so?.id;
    } else if (want.salesOrder && want.project) {
      const so = await convertToSalesOrder(leadId);
      result.salesOrderId = so?.id;
      const project = await convertToProject(leadId, so?.id ?? null);
      result.projectId = project?.id;
    } else if (want.project) {
      const project = await convertToProject(leadId);
      result.projectId = project?.id;
    }

    toast.success("Lead marked as won! 🎉");
    await fetchLeads();
    return result;
  };

  const markAsLost = async (leadId: string, reasonId?: string, notes?: string) => {
    const { error } = await supabase.rpc("crm_mark_lost", {
      p_lead_id: leadId,
      p_reason_id: reasonId || null,
      p_notes: notes || null,
    });
    if (error) throw error;
    toast.success("Lead marked as lost");
    await fetchLeads();
  };

  /** Controlled reopen of a won/lost opportunity — reason is mandatory. */
  const reopenLead = async (leadId: string, reason: string) => {
    const { error } = await supabase.rpc("crm_reopen_lead", {
      p_lead_id: leadId,
      p_reason: reason,
    });
    if (error) throw error;
    toast.success("Opportunity reopened");
    await fetchLeads();
  };

  const deleteLead = async (id: string, reason = "Removed by user") => {
    const { error } = await supabase.rpc("crm_archive_lead", {
      p_lead_id: id,
      p_reason: reason,
    });
    if (error) throw error;
    toast.success("Lead deleted");
    await fetchLeads();

  };

  // Convert lead to contact
  const convertToContact = async (leadId: string): Promise<{ id: string; name: string } | null> => {
    if (!currentOrg || !user) throw new Error("No organization selected");

    // Server-side RPC: row-locked + idempotent. Safe against double-clicks
    // and retries — never creates duplicate contacts for the same lead.
    const { data, error } = await supabase
      .rpc("convert_lead_to_contact", { p_lead_id: leadId })
      .single();

    if (error) throw error;
    if (!data) throw new Error("Lead conversion returned no result");

    const row = data as unknown as { id: string; name: string; was_existing: boolean };
    if (row.was_existing) {
      toast.success(`Contact "${row.name}" already linked to this lead`);
    } else {
      toast.success(`Contact "${row.name}" created from lead`);
    }
    await fetchLeads();
    return { id: row.id, name: row.name };
  };

  // Convert lead to estimate (server-side, idempotent)
  const convertToEstimate = async (
    leadId: string
  ): Promise<{ id: string; estimate_number: string } | null> => {
    if (!currentOrg) throw new Error("No organization selected");
    const { data, error } = await supabase
      .rpc("convert_lead_to_estimate", { p_lead_id: leadId })
      .single();
    if (error) throw error;
    const row = data as unknown as { id: string; estimate_number: string; was_existing: boolean };
    toast.success(
      row.was_existing
        ? `Estimate "${row.estimate_number}" already exists for this lead`
        : `Estimate "${row.estimate_number}" created from lead`
    );
    await fetchLeads();
    return { id: row.id, estimate_number: row.estimate_number };
  };

  // Convert lead to sales order (optionally pre-linked to a project)
  const convertToSalesOrder = async (
    leadId: string,
    projectId: string | null = null
  ): Promise<{ id: string; so_number: string } | null> => {
    if (!currentOrg) throw new Error("No organization selected");
    const { data, error } = await supabase
      .rpc("convert_lead_to_sales_order", { p_lead_id: leadId, p_project_id: projectId })
      .single();
    if (error) throw error;
    const row = data as unknown as { id: string; so_number: string; was_existing: boolean };
    toast.success(
      row.was_existing
        ? `Sales Order "${row.so_number}" already exists for this lead`
        : `Sales Order "${row.so_number}" created from lead`
    );
    await fetchLeads();
    return { id: row.id, so_number: row.so_number };
  };

  // Convert lead to project (optionally pre-linked to a sales order;
  // the RPC closes the loop by setting sales_orders.project_id too)
  const convertToProject = async (
    leadId: string,
    salesOrderId: string | null = null
  ): Promise<{ id: string; project_number: string } | null> => {
    if (!currentOrg) throw new Error("No organization selected");
    const { data, error } = await supabase
      .rpc("convert_lead_to_project", { p_lead_id: leadId, p_sales_order_id: salesOrderId })
      .single();
    if (error) throw error;
    const row = data as unknown as { id: string; project_number: string; was_existing: boolean };
    toast.success(
      row.was_existing
        ? `Project "${row.project_number}" already exists for this lead`
        : `Project "${row.project_number}" created from lead`
    );
    await fetchLeads();
    return { id: row.id, project_number: row.project_number };
  };

  return {
    leads,
    isLoading,
    createLead,
    updateLead,
    moveToStage,
    qualifyLead,
    reopenLead,

    markAsWon,
    markAsLost,
    deleteLead,
    convertToContact,
    convertToEstimate,
    convertToSalesOrder,
    convertToProject,
    refreshLeads: fetchLeads,
  };
}

