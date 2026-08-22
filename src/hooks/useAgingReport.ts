import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import {
  AGING_BUCKET_KEYS,
  bucketForDaysOverdue,
  emptyAgingBuckets,
  type AgingBucketKey,
} from "@/services/finance/aging";
// `differenceInDays` import removed with processAgingData (2026-06-02).
// Client-side bucket configuration (`DEFAULT_AGING_BUCKETS`) was removed
// 2026-08-10: bucket boundaries live in SQL only, mirrored once in
// `src/services/finance/aging.ts`. See ADR-0027 / ADR-0038.


export interface AgingBucket {
  current: number;
  days30: number;
  days60: number;
  days90: number;
  total: number;
  // Dynamic buckets keyed by label for custom configurations
  [key: string]: number;
}

export interface AgingContactDetail {
  contact_id: string;
  contact_name: string;
  company: string | null;
  email: string | null;
  buckets: AgingBucket;
  documents: AgingDocument[];
  /**
   * ADR 0136: documents whose base-currency residual the engine could not
   * state (no rate on file). They are NOT summed into `buckets`; the count
   * exists so the surface can say the total is incomplete instead of
   * presenting an understated figure as complete.
   */
  unconvertibleDocumentCount: number;
}

export interface AgingDocument {
  id: string;
  document_number: string;
  document_date: string;
  due_date: string;
  total: number;
  amount_paid: number;
  /** NULL when no rate is on file — never coerce to 0. */
  balance_due: number | null;
  days_overdue: number;
  bucket: string; // Dynamic bucket label (e.g., "current", "days30", "days60", "days90")
  source?: string | null; // "migration" for migrated documents
}

export interface AgingReportData {
  contacts: AgingContactDetail[];
  summary: AgingBucket;
  asOfDate: string;
  reportType: "ar" | "ap";
  /** Total documents excluded from `summary` because no rate is on file. */
  unconvertibleDocumentCount: number;
}

interface UseAgingReportParams {
  reportType: "ar" | "ap";
  asOfDate?: string;
  // Custom client bucket overrides are deliberately NOT supported: boundaries
  // are owned by SQL so every AR/AP surface ages identically.

  /**
   * Optional explicit branch override (typically `filters.branchId` from
   * `ReportFilterContext`). When omitted, falls back to the active
   * `currentBranch` so legacy callers keep working. NULL = consolidated.
   */
  branchId?: string | null;
  /**
   * When true, contacts that share a `commercial_partner_id` are merged
   * under the parent commercial partner row. Buckets and documents from
   * every child are summed into the parent. The parent row's contact_id
   * becomes `commercial_partner_id`, so drill-down (statements, contact
   * preview) opens the parent company.
   *
   * Default `false` for list-view safety (no silent double-count). The
   * AR/AP pages expose a header toggle that flips this on per ADR-0038
   * §"Reporting rollup".
   */
  rollupToCommercialPartner?: boolean;
}

export function useAgingReport(params: UseAgingReportParams) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const asOfDate = params.asOfDate || new Date().toISOString().split("T")[0];
  const effectiveBranchId =
    params.branchId !== undefined ? params.branchId : currentBranch?.id ?? null;

  return useQuery({
    queryKey: [
      "aging-report",
      currentOrg?.id,
      currentBusiness?.id,
      effectiveBranchId ?? "all",
      params.reportType,
      asOfDate,
      params.rollupToCommercialPartner ? "rollup" : "flat",
    ],
    queryFn: async (): Promise<AgingReportData> => {
      if (!currentOrg?.id || !currentBusiness?.id) {
        return {
          contacts: [],
          summary: { not_due: 0, current: 0, days30: 0, days60: 0, days90: 0, total: 0 },
          asOfDate,
          reportType: params.reportType,
          unconvertibleDocumentCount: 0,
        };
      }

      const { data, error } = await (supabase as any).rpc("get_ar_ap_aging_from_ledger", {
        _org_id: currentOrg.id,
        _business_id: currentBusiness.id,
        _report_type: params.reportType,
        _as_of_date: asOfDate,
        _branch_id: effectiveBranchId,
      });

      if (error) throw error;
      const flat = processLedgerAgingRows(data || [], params.reportType, asOfDate);
      if (!params.rollupToCommercialPartner) return flat;
      return rollupContactsToCommercialPartner(flat, {
        organizationId: currentOrg.id,
        businessId: currentBusiness.id,
      });
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });
}

/**
 * Merge aging contacts that share a `commercial_partner_id` into the
 * parent commercial partner. Documents and bucket totals from every
 * child are summed into the parent row; the parent row's `contact_id`
 * is set to the commercial partner so drill-down opens the parent.
 *
 * See ADR-0038 §"Reporting rollup" — this is the single read-side
 * rollup helper for AR/AP balances. Posting paths must not call this.
 */
async function rollupContactsToCommercialPartner(
  flat: AgingReportData,
  scope: { organizationId: string; businessId: string },
): Promise<AgingReportData> {
  const contactIds = flat.contacts.map((c) => c.contact_id).filter((id) => id && id !== "unknown");
  if (contactIds.length === 0) return flat;

  const { data: rows, error } = await supabase
    .from("contacts")
    .select("id, name, commercial_partner_id")
    .eq("organization_id", scope.organizationId)
    .eq("business_id", scope.businessId)
    .in("id", contactIds);
  if (error || !rows) return flat;

  const partnerByChild = new Map<string, { id: string; name: string }>();
  const childMap = new Map(rows.map((r: any) => [r.id as string, r]));
  const partnerIdsToFetch = new Set<string>();
  for (const r of rows as any[]) {
    const partnerId = (r.commercial_partner_id as string | null) || (r.id as string);
    if (!childMap.has(partnerId)) partnerIdsToFetch.add(partnerId);
    partnerByChild.set(r.id as string, { id: partnerId, name: r.name as string });
  }

  // Fetch parent names that weren't already in the result set.
  if (partnerIdsToFetch.size > 0) {
    const { data: parents } = await supabase
      .from("contacts")
      .select("id, name")
      .eq("organization_id", scope.organizationId)
      .eq("business_id", scope.businessId)
      .in("id", Array.from(partnerIdsToFetch));
    for (const p of (parents || []) as any[]) {
      childMap.set(p.id as string, { id: p.id, name: p.name, commercial_partner_id: p.id });
    }
  }

  const merged = new Map<string, AgingContactDetail>();
  for (const c of flat.contacts) {
    const partner = partnerByChild.get(c.contact_id);
    const partnerId = partner?.id ?? c.contact_id;
    const partnerName = partner ? (childMap.get(partnerId) as any)?.name ?? c.contact_name : c.contact_name;
    let target = merged.get(partnerId);
    if (!target) {
      target = {
        contact_id: partnerId,
        contact_name: partnerName,
        company: c.company,
        email: c.email,
        buckets: { not_due: 0, current: 0, days30: 0, days60: 0, days90: 0, total: 0 },
        documents: [],
      };
      merged.set(partnerId, target);
    }
    for (const [k, v] of Object.entries(c.buckets)) {
      target.buckets[k] = (target.buckets[k] || 0) + (v as number);
    }
    target.documents.push(...c.documents);
  }

  return {
    ...flat,
    contacts: Array.from(merged.values()).sort((a, b) => b.buckets.total - a.buckets.total),
  };
}

function processLedgerAgingRows(
  rows: any[],
  reportType: "ar" | "ap",
  asOfDateStr: string,
): AgingReportData {
  const contactMap = new Map<string, AgingContactDetail>();
  const summary: AgingBucket = { ...emptyAgingBuckets() };

  for (const row of rows) {
    const residual = Number(row.residual_amount) || 0;
    // Negative residuals are unapplied customer credits (credit positions).
    // They must reduce the contact's net position, not be dropped.
    if (Math.abs(residual) <= 0.005) continue;
    const daysOverdue = Number(row.days_overdue) || 0;
    // The bucket is assigned by SQL (`get_ar_ap_aging_from_ledger`). It is the
    // single boundary definition; the client only falls back if the RPC ever
    // omits it, using the mirrored helper — never a second inline copy.
    const bucketLabel: AgingBucketKey =
      AGING_BUCKET_KEYS.includes(row.bucket) ? (row.bucket as AgingBucketKey) : bucketForDaysOverdue(daysOverdue, residual);

    summary[bucketLabel] = (summary[bucketLabel] || 0) + residual;
    summary.total += residual;

    const contactId = row.contact_id || "unknown";
    let contactDetail = contactMap.get(contactId);
    if (!contactDetail) {
      contactDetail = {
        contact_id: contactId,
        contact_name: row.contact_name || "Unassigned",
        company: row.company || null,
        email: row.email || null,
        buckets: { ...emptyAgingBuckets() },
        documents: [],
      };
      contactMap.set(contactId, contactDetail);
    }

    contactDetail.buckets[bucketLabel] = (contactDetail.buckets[bucketLabel] || 0) + residual;
    contactDetail.buckets.total += residual;
    contactDetail.documents.push({
      id: row.document_id,
      document_number: row.document_number,
      document_date: row.document_date,
      due_date: row.due_date,
      total: Number(row.document_total) || 0,
      amount_paid: Number(row.applied_amount) || 0,
      balance_due: residual,
      days_overdue: daysOverdue,
      bucket: bucketLabel,
      source: residual < 0 ? "customer_credit" : "ledger_residual",
    });
  }

  return { contacts: Array.from(contactMap.values()).sort((a, b) => b.buckets.total - a.buckets.total), summary, asOfDate: asOfDateStr, reportType };
}


// `processAgingData` (legacy client-side aging from raw invoices/bills) was
// removed 2026-06-02. Aging is now sourced exclusively from
// `get_ar_ap_aging_from_ledger`, which respects allocation-first truth.

