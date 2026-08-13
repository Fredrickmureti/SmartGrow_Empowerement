/**
 * vendorStatementView — the one description of a Vendor Statement.
 *
 * Mirrors `billView`: the record page and the list peek both consume this
 * builder, so "what a vendor statement looks like" — header facts, status,
 * the balance ladder, the activity feed — is decided in exactly one place.
 * The body keeps reusing `VendorStatementPreview`, which the PDF pipeline
 * also renders, so peek / full page / print stay byte-identical.
 */
import { useCallback, useMemo, useState } from "react";
import { format } from "date-fns";
import { toast } from "sonner";

import type {
  DocumentRecordView,
  DocumentActivityEntry,
} from "@/design-system/records";
import { Section } from "@/design-system";
import { VendorStatementPreview } from "@/components/purchases/VendorStatementPreview";
import { DocumentVersionsSection } from "@/components/documents/DocumentVersionsSection";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOrganization } from "@/hooks/useOrganization";
import { useBranches } from "@/hooks/useBranches";
import { normalizeError } from "@/services/resilience";
import {
  useVendorStatementRecord,
  type VendorStatementRecord,
} from "./useVendorStatementRecord";
import { dispatchVendorStatement } from "./dispatchVendorStatement";

function fmtDate(v: string | null | undefined) {
  if (!v) return "—";
  try {
    return format(new Date(v), "PP");
  } catch {
    return v;
  }
}

interface Result {
  record: VendorStatementRecord | null;
  loading: boolean;
  error: string | null;
  view: DocumentRecordView;
}

export function useVendorStatementView(
  id: string | null | undefined,
  formatCurrency: (v: number) => string,
): Result {
  const { record, loading, error } = useVendorStatementRecord(id);
  const { currentBusiness } = useBusinesses();
  const currency = currentBusiness?.base_currency ?? "";

  const view = useMemo<DocumentRecordView>(() => {
    const header = record?.header;
    const data = record?.data;

    // Statement dispatch is not an audited mutation, so it is merged into
    // the audit-backed feed rather than replacing it.
    const activityExtra: DocumentActivityEntry[] = header?.sent_at
      ? [
          {
            id: "sent",
            at: fmtDate(header.sent_at),
            actor: "User",
            title: `Sent to ${header.sent_to ?? "vendor"}`,
          },
        ]
      : [];

    return {
      kind: "vendor_statement",
      documentId: header?.id,
      eyebrow: "Vendor Statement",
      listPath: "/purchases/statements",
      title: data?.contact.name ?? "Vendor",
      docNumber: header ? fmtDate(header.statement_date) : undefined,
      status: header ? (header.sent_at ? "sent" : "draft") : undefined,
      loading,
      error,
      notFound: !loading && !error && !!id && !record,
      meta: header ? (
        <>
          <span>
            Period {fmtDate(header.period_start)} – {fmtDate(header.period_end)}
          </span>
          <span className="tabular-nums">
            {formatCurrency(header.closing_balance ?? 0)} {currency}
          </span>
        </>
      ) : undefined,
      // A statement is a balance roll-forward, not an invoice totals
      // ladder — it declares its own rows rather than `money`.
      totalsRows: header
        ? [
            {
              label: "Opening balance",
              value: formatCurrency(header.opening_balance ?? 0),
            },
            {
              label: "Billed in period",
              value: formatCurrency(header.total_billed ?? 0),
            },
            {
              label: "Payments",
              value: `- ${formatCurrency(header.total_payments ?? 0)}`,
              muted: true,
            },
            {
              label: "Closing balance",
              value: formatCurrency(header.closing_balance ?? 0),
              emphasized: true,
            },
          ]
        : undefined,
      totalsFooter: header ? `Currency ${currency}` : undefined,
      activityExtra,
      extraSections:
        record && data ? (
          <>
            <Section title="Statement">
              <VendorStatementPreview data={data} />
            </Section>
            <DocumentVersionsSection
              documentType="vendor_statement"
              documentId={record.header.id}
            />
          </>
        ) : undefined,
    };
  }, [record, loading, error, id, formatCurrency, currency]);

  return { record, loading, error, view };
}

/**
 * Dispatch + send wiring shared by both projections, so the PDF action and
 * the e-mail payload are built once rather than once per surface.
 */
export function useVendorStatementActions(record: VendorStatementRecord | null) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const [dispatching, setDispatching] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);

  // DOWNLOAD — bytes to the browser. No targets, no print job, ever.
  const download = useCallback(async () => {
    if (!record || dispatching) return;
    setDispatching(true);
    try {
      const res = await downloadVendorStatement({
        statementId: record.header.id,
        format: "pdf",
        contactName: record.data.contact.name,
        dateLabel: record.header.period_start ?? record.header.statement_date,
        periodEndLabel: record.header.period_end ?? null,
      });
      if (!res.ok) throw new Error(res.error ?? "Download failed");
      toast.success("Statement downloaded.");
    } catch (err) {
      toast.error(`Failed to download statement: ${normalizeError(err).message}`);
    } finally {
      setDispatching(false);
    }
  }, [record, dispatching]);

  // PRINT — the explicit output-intent path, only when an operator prints.
  const print = useCallback(async () => {
    if (!record || dispatching) return;
    setDispatching(true);
    try {
      const result = await dispatchVendorStatement({
        statementId: record.header.id,
        organizationId: currentOrg?.id ?? null,
        businessId: currentBusiness?.id ?? null,
        branchId: currentBranch?.id ?? null,
      });
      toast.success(`Statement sent to ${result.targetCount} target(s).`);
    } catch (err) {
      toast.error(`Failed to print statement: ${normalizeError(err).message}`);
    } finally {
      setDispatching(false);
    }
  }, [record, dispatching, currentOrg?.id, currentBusiness?.id, currentBranch?.id]);

  const sendDocument = record
    ? {
        documentType: "vendor_statement" as const,
        documentId: record.header.id,
        documentNumber: `Vendor_Statement_${format(
          new Date(record.header.statement_date),
          "yyyy-MM-dd",
        )}`,
        recipientEmail: record.data.contact.email || "",
        recipientName: record.data.contact.name,
        total: record.data.closingBalance,
        currency: currentBusiness?.base_currency,
      }
    : null;

  return { dispatching, download, emailOpen, setEmailOpen, sendDocument };
}
