import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useToast } from "./use-toast";
import { useAuditLog } from "./useAuditLog";
import { usePermissions } from "./usePermissions";
import { triggerAutomation, getChangedFields } from "@/lib/automations/triggerAutomation";
import { normalizeError } from "@/services/resilience";
import { applyPartyScope } from "@/lib/contactAddresses";

export type ContactChildAddressType = "contact" | "invoice" | "delivery" | "other";

export interface Contact {
  id: string;
  organization_id: string;
  business_id: string;
  type: "customer" | "supplier" | "both";
  name: string;
  email: string | null;
  phone: string | null;
  /**
   * Derived (read-only) — name of the parent commercial entity.
   * The legacy `contacts.company` column was removed; this value is hydrated
   * from the joined `parent_contact_id` row so existing downstream readers
   * (statements, reports, search) keep working.
   */
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
  // Credit management fields
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
  // ── Odoo-grade commercial partner model ─────────────────────────────────
  /** True when this record represents a company (can have child contacts). */
  is_company: boolean;
  /** FK to the parent company contact, if this is an individual/sub-contact. */
  parent_contact_id: string | null;
  /**
   * Root of the parent chain (the "commercial entity" used for billing,
   * statements, credit limits). Maintained by trigger — do not write directly.
   */
  commercial_partner_id: string | null;
  /** Role this child plays under its parent (contact / invoice / delivery / other). */
  child_address_type: ContactChildAddressType | null;
  /** Odoo-style role ranks — non-zero ⇒ partner has acted in that role. */
  customer_rank: number;
  supplier_rank: number;
}

export function useContacts() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const { logAction } = useAuditLog();
  const { can } = usePermissions();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchContacts = async () => {
    if (!currentOrg || !currentBusiness) return;

    setIsLoading(true);
    try {
      const { data, error } = await applyPartyScope(
        supabase
          .from("contacts")
          .select("*, parent:contacts!parent_contact_id(name)"),
      )
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("is_sample_data", false)
        .order("name");

      if (error) throw error;
      // Derive `company` from the parent company contact's name so all
      // downstream readers keep working after `contacts.company` is dropped.
      const mapped = (data || []).map((row: any) => ({
        ...row,
        company: row.parent?.name ?? null,
      }));
      setContacts(mapped as unknown as Contact[]);
    } catch (error: any) {
      console.error("Error fetching contacts:", error);
      toast({
        title: "Error loading contacts",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchContacts();
  }, [currentOrg?.id, currentBusiness?.id]);

  const createContact = async (contact: Pick<Contact, "name"> & Partial<Omit<Contact, "id" | "organization_id" | "created_at" | "updated_at" | "name">>) => {
    if (!can("manageContacts")) { toast({ title: "Permission denied", description: "You don't have permission to create contacts", variant: "destructive" }); throw new Error("Permission denied"); }
    if (!currentOrg || !currentBusiness) throw new Error("No business selected");

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

    // Log creation
    logAction({
      action: "created",
      entityType: "contact",
      entityId: data.id,
      entityName: contact.name,
      changesSummary: `Created ${contact.type || "customer"}: ${contact.name}`,
    });

    // Trigger automations (fire-and-forget)
    triggerAutomation({
      event_type: "on_create",
      target_model: "contact",
      record_id: data.id,
      record_data: data,
      organization_id: currentOrg.id,
    });

    // Optimistic update
    setContacts((prev) => [...prev, data as unknown as Contact].sort((a, b) => a.name.localeCompare(b.name)));
    return data;
  };

  const updateContact = async (id: string, updates: Partial<Contact>) => {
    if (!can("manageContacts")) { toast({ title: "Permission denied", description: "You don't have permission to update contacts", variant: "destructive" }); throw new Error("Permission denied"); }
    const contact = contacts.find((c) => c.id === id);
    
    // Optimistic update
    setContacts((prev) => prev.map((c) => (c.id === id ? { ...c, ...updates } : c)));

    try {
      const updateData: any = { ...updates };

      const { error } = await supabase
        .from("contacts")
        .update(updateData)
        .eq("id", id);

      if (error) throw error;

      // Log update
      if (contact) {
        logAction({
          action: "updated",
          entityType: "contact",
          entityId: id,
          entityName: contact.name,
          changesSummary: `Updated contact: ${contact.name}`,
        });

        // Trigger automations (fire-and-forget)
        const changedFields = getChangedFields(contact as unknown as Record<string, unknown>, updates as Record<string, unknown>);
        triggerAutomation({
          event_type: changedFields.length > 0 ? "field_change" : "on_update",
          target_model: "contact",
          record_id: id,
          record_data: { ...contact, ...updates },
          old_data: contact as unknown as Record<string, unknown>,
          changed_fields: changedFields,
          organization_id: currentOrg!.id,
        });
      }
    } catch (error) {
      // Rollback on error
      if (contact) {
        setContacts((prev) => prev.map((c) => (c.id === id ? contact : c)));
      }
      throw error;
    }
  };

  const deleteContact = async (id: string) => {
    if (!can("manageContacts")) { toast({ title: "Permission denied", description: "You don't have permission to delete contacts", variant: "destructive" }); throw new Error("Permission denied"); }
    const contact = contacts.find((c) => c.id === id);
    
    // Optimistic update
    setContacts((prev) => prev.filter((c) => c.id !== id));

    try {
      const { error } = await supabase.from("contacts").delete().eq("id", id);
      if (error) throw error;

      // Log deletion
      if (contact) {
        logAction({
          action: "deleted",
          entityType: "contact",
          entityId: id,
          entityName: contact.name,
          changesSummary: `Deleted contact: ${contact.name}`,
        });

        // Trigger automations (fire-and-forget)
        triggerAutomation({
          event_type: "on_delete",
          target_model: "contact",
          record_id: id,
          record_data: contact as unknown as Record<string, unknown>,
          organization_id: currentOrg!.id,
        });
      }
    } catch (error) {
      // Rollback on error
      if (contact) {
        setContacts((prev) => [...prev, contact]);
      }
      throw error;
    }
  };

  return {
    contacts,
    isLoading,
    createContact,
    updateContact,
    deleteContact,
    refreshContacts: fetchContacts,
  };
}
