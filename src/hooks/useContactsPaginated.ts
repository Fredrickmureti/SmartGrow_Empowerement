import { usePaginatedQuery } from "./usePaginatedQuery";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useToast } from "./use-toast";
import { useAuditLog } from "./useAuditLog";
import { useQueryClient } from "@tanstack/react-query";
import { applyPartyScope } from "@/lib/contactAddresses";

export interface Contact {
  id: string;
  organization_id: string;
  type: "customer" | "supplier" | "both";
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  tax_id: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  credit_limit: number | null;
  credit_hold: boolean | null;
  payment_term_id: string | null;
  price_list_id: string | null;
  customer_group_id: string | null;
  // Accounting configuration fields
  default_expense_account_id: string | null;
  default_payable_account_id: string | null;
  default_receivable_account_id: string | null;
  default_tax_rate_id: string | null;
  withholding_tax_rate: number | null;
  tax_exemption_number: string | null;
  // Phase A — Odoo-grade hierarchy & role rank fields
  parent_contact_id: string | null;
  is_company: boolean;
  child_address_type: "contact" | "invoice" | "delivery" | "other" | null;
  customer_rank: number;
  supplier_rank: number;
  commercial_partner_id: string | null;
}

export interface UseContactsPaginatedOptions {
  typeFilter?: string;
  search?: string;
  showCompaniesOnly?: boolean;
  includeArchived?: boolean;
  pageSize?: number;
}

export function useContactsPaginated(options: UseContactsPaginatedOptions = {}) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const { logAction } = useAuditLog();
  const queryClient = useQueryClient();

  const { typeFilter, search, showCompaniesOnly, includeArchived, pageSize = 50 } = options;

  const queryKey = ["contacts", currentOrg?.id, currentBusiness?.id, typeFilter, search, showCompaniesOnly, includeArchived];

  const result = usePaginatedQuery<Contact>({
    queryKey,
    queryFn: async ({ from, to }) => {
      if (!currentOrg || !currentBusiness) return { data: [], count: 0 };

      let query = applyPartyScope(
        supabase
          .from("contacts")
          .select("*, parent:contacts!parent_contact_id(name)", { count: "exact" }),
      )
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("is_sample_data", false)
        .order("name", { ascending: true });

      // Filter archived contacts by default
      if (!includeArchived) {
        query = query.eq("is_active", true);
      }

      // Apply role filter. Prefer rank columns (the new source of truth);
      // fall back to the legacy `type` enum so pre-rank rows still surface.
      if (typeFilter && typeFilter !== "all") {
        const normalizedType = typeFilter === "vendor" ? "supplier" : typeFilter;
        if (normalizedType === "customer") {
          query = query.or("customer_rank.gt.0,type.eq.customer,type.eq.both");
        } else if (normalizedType === "supplier") {
          query = query.or("supplier_rank.gt.0,type.eq.supplier,type.eq.both");
        } else if (normalizedType === "both") {
          query = query.or("and(customer_rank.gt.0,supplier_rank.gt.0),type.eq.both");
        }
      }

      // Apply companies-only filter via the canonical is_company flag.
      if (showCompaniesOnly) {
        query = query.eq("is_company", true);
      }

      // Apply search filter (server-side). The legacy `company` text column
      // has been dropped — searching by parent company name is not yet
      // supported server-side. Fall back to name + email until we add a
      // computed search column.
      if (search) {
        query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
      }

      // Apply pagination
      query = query.range(from, to);

      const { data, count, error } = await query;

      if (error) throw error;

      const mapped = (data || []).map((row: any) => ({
        ...row,
        company: row.parent?.name ?? null,
      }));
      return { data: mapped as unknown as Contact[], count: count || 0 };
    },
    pageSize,
    enabled: !!currentOrg && !!currentBusiness,
  });

  const createContact = async (
    contact: Pick<Contact, "name"> &
      Partial<Omit<Contact, "id" | "organization_id" | "created_at" | "updated_at" | "name">>
  ) => {
    if (!currentOrg || !currentBusiness) throw new Error("No organization or business selected");

    const insertData: any = {
      ...contact,
      organization_id: currentOrg.id,
      business_id: currentBusiness.id,
    };

    const { data, error } = await supabase
      .from("contacts")
      .insert(insertData)
      .select()
      .single();

    if (error) throw error;

    logAction({
      action: "created",
      entityType: "contact",
      entityId: data.id,
      entityName: contact.name,
      changesSummary: `Created ${contact.type || "customer"}: ${contact.name}`,
    });

    queryClient.invalidateQueries({ queryKey: ["contacts"] });
    return data;
  };

  const updateContact = async (id: string, updates: Partial<Contact>) => {
    const updateData: any = { ...updates };
    const { error } = await supabase.from("contacts").update(updateData).eq("id", id);

    if (error) throw error;

    logAction({
      action: "updated",
      entityType: "contact",
      entityId: id,
      changesSummary: `Updated contact`,
    });

    queryClient.invalidateQueries({ queryKey: ["contacts"] });
  };

  const deleteContact = async (id: string) => {
    const { error } = await supabase.from("contacts").delete().eq("id", id);
    if (error) throw error;

    logAction({
      action: "deleted",
      entityType: "contact",
      entityId: id,
      changesSummary: `Deleted contact`,
    });

    queryClient.invalidateQueries({ queryKey: ["contacts"] });
  };

  const archiveContact = async (id: string) => {
    const { error } = await supabase
      .from("contacts")
      .update({ is_active: false })
      .eq("id", id);

    if (error) throw error;

    logAction({
      action: "updated",
      entityType: "contact",
      entityId: id,
      changesSummary: `Archived contact`,
    });

    queryClient.invalidateQueries({ queryKey: ["contacts"] });
  };

  const restoreContact = async (id: string) => {
    const { error } = await supabase
      .from("contacts")
      .update({ is_active: true })
      .eq("id", id);

    if (error) throw error;

    logAction({
      action: "updated",
      entityType: "contact",
      entityId: id,
      changesSummary: `Restored contact`,
    });

    queryClient.invalidateQueries({ queryKey: ["contacts"] });
  };

  return {
    ...result,
    contacts: result.data,
    createContact,
    updateContact,
    deleteContact,
    archiveContact,
    restoreContact,
  };
}
