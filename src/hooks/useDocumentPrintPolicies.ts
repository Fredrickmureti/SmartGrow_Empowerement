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

export type PaperFormat = "a4" | "letter" | "a5" | "80mm" | "58mm" | "40mm" | "custom";
export type RenderMode = "pdf" | "escpos";
export type OutputTrigger = "manual" | "auto" | "preview_only" | "download_only";

export interface PrintPolicy {
  id?: string;
  business_id: string;
  branch_id: string | null;
  document_type: string;
  paper_format: PaperFormat;
  render_mode: RenderMode;
  /** When this document reaches paper. */
  trigger: OutputTrigger;
  /** Semantic printer role kept for policy compatibility. */
  role_code: string | null;
  copies?: number | null;
}

export interface PolicyDocumentType {
  value: string;
  label: string;
  /** Module the document belongs to — drives grouping in the editor. */
  module: "Sales" | "Purchasing" | "Point of Sale";
  /** One-line description so operators can tell near-identical kinds apart. */
  hint?: string;
}

/**
 * Output policy catalogue.
 *
 * Every entry MUST be a document type the render pipeline can actually
 * produce (`templateRenderer.DocumentType`) — a policy row for a kind no
 * renderer serves resolves to nothing and silently never prints. The list is
 * grouped by module because a flat list of thirteen near-identical nouns is
 * why operators could not find the sales payment receipt.
 */
export const DOCUMENT_TYPE_CATALOGUE: PolicyDocumentType[] = [
  { value: "invoice", label: "Invoice", module: "Sales" },
  { value: "proforma", label: "Proforma invoice", module: "Sales" },
  { value: "estimate", label: "Quotation / estimate", module: "Sales" },
  { value: "sales_order", label: "Sales order", module: "Sales" },
  { value: "delivery_note", label: "Delivery note", module: "Sales" },
  {
    value: "receipt",
    label: "Payment receipt (customer)",
    module: "Sales",
    hint: "Issued when a customer pays. Shows which invoices the money was applied to — not a POS sale.",
  },
  { value: "credit_note", label: "Credit note", module: "Sales" },
  { value: "sales_return", label: "Sales return", module: "Sales" },
  {
    value: "customer_statement",
    label: "Customer statement",
    module: "Sales",
    hint: "Multi-page ledger — sheet paper only.",
  },
  { value: "purchase_order", label: "Purchase order", module: "Purchasing" },
  { value: "bill", label: "Vendor bill", module: "Purchasing" },
  {
    value: "vendor_statement",
    label: "Vendor statement",
    module: "Purchasing",
    hint: "Multi-page ledger — sheet paper only.",
  },
  {
    value: "pos_receipt",
    label: "POS sale receipt",
    module: "Point of Sale",
    hint: "Customer copy printed at the register when a sale is committed.",
  },
  {
    value: "kitchen_ticket",
    label: "Kitchen ticket",
    module: "Point of Sale",
    hint: "Preparation ticket — no totals, no tax, routed to the kitchen printer.",
  },
];

/** Module order used by the editor. */
export const DOCUMENT_TYPE_MODULES: PolicyDocumentType["module"][] = [
  "Sales",
  "Purchasing",
  "Point of Sale",
];

/** Flat view kept for existing callers. */
export const DOCUMENT_TYPES: { value: string; label: string }[] =
  DOCUMENT_TYPE_CATALOGUE.map((d) => ({ value: d.value, label: d.label }));

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
        .select("id, business_id, branch_id, document_type, paper_format, render_mode, trigger, role_code, copies")
        .eq("business_id", businessId);
      if (error) throw error;
      setPolicies((data ?? []) as unknown as PrintPolicy[]);
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
 * Settings UI can react to `trigger`, `role_code`, etc.
 * without a network round-trip.
 *
 * Falls back to the system default `{ paper_format: 'a4', render_mode:
 * 'pdf', trigger: 'manual', role_code: null }` when no row
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
        trigger: row.trigger,
        role_code: row.role_code,
        copies: row.copies,
        source: branchHit ? "branch" : "business",
      }
    : {
        document_type: documentType,
        paper_format: "a4",
        render_mode: "pdf",
        trigger: "manual",
        role_code: null,
        copies: 1,
        source: "default",
      };

  return { policy, loading };
}

