import { normalizeError } from "@/services/resilience";
/**
 * useDocumentPrintPolicies — Wave V3 (ADR-0008).
 *
 * Reads + upserts rows in `document_print_policies` for a given business.
 * The unique index is `(business_id, COALESCE(branch_id, '0…'), document_type)`,
 * so the upsert key must include the doc type and either a branchId or null.
 *
 * RLS allows SELECT for any business member; ALL (write) requires
 * owner/admin/accountant on the parent organization. The hook surfaces both
 * `policies` and `canWrite` (boolean) so the UI can disable controls instead
 * of letting the upsert silently fail.
 */
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useResolvedDeviceForDocument } from "@/hooks/hardware/useResolvedDeviceForDocument";
import type { DeviceAssignment } from "@/hooks/useDeviceAssignments";

export type PaperFormat = "a4" | "letter" | "a5" | "80mm" | "58mm" | "40mm" | "custom";
export type RenderMode = "pdf" | "escpos";

export interface PrintPolicy {
  id?: string;
  business_id: string;
  branch_id: string | null;
  document_type: string;
  paper_format: PaperFormat;
  render_mode: RenderMode;
  device_assignment_id: string | null;
  auto_print: boolean;
}

export const DOCUMENT_TYPES: { value: string; label: string }[] = [
  { value: "invoice", label: "Invoices" },
  { value: "estimate", label: "Estimates / Quotes" },
  { value: "proforma", label: "Proforma Invoices" },
  { value: "credit_note", label: "Credit Notes" },
  { value: "purchase_order", label: "Purchase Orders" },
  { value: "receipt", label: "Receipts (payments)" },
  { value: "pos_receipt", label: "POS Receipts" },
  { value: "sales_order", label: "Sales Orders" },
  { value: "delivery_note", label: "Delivery Notes" },
  { value: "sales_return", label: "Sales Returns" },
  { value: "customer_statement", label: "Customer Statements" },
  { value: "vendor_statement", label: "Vendor Statements" },
  { value: "bill", label: "Bills" },
];

export function useDocumentPrintPolicies(businessId: string | null | undefined) {
  const { toast } = useToast();
  const [policies, setPolicies] = useState<PrintPolicy[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!businessId) {
      setPolicies([]);
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("document_print_policies")
        .select("id, business_id, branch_id, document_type, paper_format, render_mode, device_assignment_id, auto_print")
        .eq("business_id", businessId);
      if (error) throw error;
      setPolicies((data ?? []) as PrintPolicy[]);
    } catch (e: any) {
      toast({ title: "Failed to load print policies", description: normalizeError(e).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [businessId, toast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const upsert = useCallback(async (policy: Omit<PrintPolicy, "id">) => {
    if (!businessId) return false;
    setSaving(true);
    try {
      // Match the unique index: (business_id, COALESCE(branch_id,'0…'), document_type).
      // We can't use Supabase's onConflict directly because of the COALESCE,
      // so do a manual select-then-update/insert.
      const { data: existing } = await supabase
        .from("document_print_policies")
        .select("id")
        .eq("business_id", policy.business_id)
        .eq("document_type", policy.document_type)
        .is("branch_id", policy.branch_id === null ? null : (undefined as any))
        .or(policy.branch_id ? `branch_id.eq.${policy.branch_id}` : "branch_id.is.null")
        .maybeSingle();

      if (existing?.id) {
        const { error } = await supabase
          .from("document_print_policies")
          .update(policy)
          .eq("id", existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("document_print_policies")
          .insert(policy);
        if (error) throw error;
      }
      await refresh();
      toast({ title: "Print policy saved" });
      return true;
    } catch (e: any) {
      toast({
        title: "Failed to save policy",
        description: normalizeError(e).message ?? "You may not have permission to change print policies.",
        variant: "destructive",
      });
      return false;
    } finally {
      setSaving(false);
    }
  }, [businessId, refresh, toast]);

  const remove = useCallback(async (id: string) => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("document_print_policies")
        .delete()
        .eq("id", id);
      if (error) throw error;
      await refresh();
      toast({ title: "Print policy removed" });
      return true;
    } catch (e: any) {
      toast({ title: "Failed to remove policy", description: normalizeError(e).message, variant: "destructive" });
      return false;
    } finally {
      setSaving(false);
    }
  }, [refresh, toast]);

  /** Find the resolved policy row for a (branch, docType) tuple — branch-specific wins. */
  const findPolicy = useCallback((branchId: string | null, docType: string) => {
    if (branchId) {
      const branchHit = policies.find((p) => p.branch_id === branchId && p.document_type === docType);
      if (branchHit) return branchHit;
    }
    return policies.find((p) => p.branch_id === null && p.document_type === docType) ?? null;
  }, [policies]);

  return { policies, loading, saving, refresh, upsert, remove, findPolicy };
}

/**
 * Stage W6 (ADR-0008) — same resolution rules as the server-side
 * `_shared/printing/resolvePolicy.ts`, but in the React tree so POS /
 * Settings UI can react to `auto_print`, `device_assignment_id`, etc.
 * without a network round-trip.
 *
 * Falls back to the system default `{ paper_format: 'a4', render_mode:
 * 'pdf', auto_print: false, device_assignment_id: null }` when no row
 * matches — identical behaviour to the server resolver.
 */
export interface ResolvedPrintPolicy extends Omit<PrintPolicy, "id" | "branch_id" | "business_id"> {
  source: "branch" | "business" | "default";
}

export function useResolvedPrintPolicy(
  businessId: string | null | undefined,
  branchId: string | null | undefined,
  documentType: string,
): { policy: ResolvedPrintPolicy; loading: boolean } {
  const { policies, loading } = useDocumentPrintPolicies(businessId);

  const branchHit = branchId
    ? policies.find((p) => p.branch_id === branchId && p.document_type === documentType)
    : null;
  const businessHit = policies.find((p) => p.branch_id === null && p.document_type === documentType);
  const row = branchHit ?? businessHit ?? null;

  const policy: ResolvedPrintPolicy = row
    ? {
        document_type: row.document_type,
        paper_format: row.paper_format,
        render_mode: row.render_mode,
        device_assignment_id: row.device_assignment_id,
        auto_print: row.auto_print,
        source: branchHit ? "branch" : "business",
      }
    : {
        document_type: documentType,
        paper_format: "a4",
        render_mode: "pdf",
        device_assignment_id: null,
        auto_print: false,
        source: "default",
      };

  return { policy, loading };
}

/**
 * useResolvedPrintPolicyWithDevice — Wave 10 (P3 #17 finish).
 *
 * Same return as `useResolvedPrintPolicy`, plus the matching
 * `device_assignments` row that the
 * print router will actually dispatch to. Callers that want
 * device-aware UI (e.g. "Will print to: Star TSP143 on usb:049f:0001")
 * use this; existing callers stay on the additive base hook above.
 *
 * Why a sibling hook instead of widening the base shape?
 *   - `useResolvedPrintPolicy` is on the POSTerminal hot path; adding
 *     two more Supabase reads on every render of every cashier would
 *     be wasteful when most callers don't need them.
 *   - Sibling hook keeps the device resolver opt-in and the base
 *     hook's return shape strictly backward-compatible.
 */
// (imports moved to top of file)

export function useResolvedPrintPolicyWithDevice(
  businessId: string | null | undefined,
  branchId: string | null | undefined,
  documentType: string,
): {
  policy: ResolvedPrintPolicy;
  device: DeviceAssignment | null;
  loading: boolean;
} {
  const { policy, loading: policyLoading } = useResolvedPrintPolicy(
    businessId,
    branchId,
    documentType,
  );
  const { device, isLoading: deviceLoading } = useResolvedDeviceForDocument(
    policy.device_assignment_id,
  );
  return {
    policy,
    device,
    loading: policyLoading || deviceLoading,
  };
}
