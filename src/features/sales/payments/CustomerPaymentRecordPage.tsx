/**
 * CustomerPaymentRecordPage — object-page route for a customer payment
 * (AR receipt). Read-only view built on RecordScaffold; allocations
 * are rendered inline via the shared LineItemsGrid. Record/edit still
 * routes through the list-page dialogs until the wizard migration lands
 * (see docs/design-system/audit/sales.md).
 */

import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { format } from "date-fns";

import { StatusBadge } from "@/design-system";
import { RecordScaffold } from "@/features/sales/record";
import type { LineItemColumn, LineItemRow } from "@/features/sales/record";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";
import { DocumentVersionsSection } from "@/components/documents/DocumentVersionsSection";

interface AllocationRow {
  id: string;
  invoice_id: string | null;
  amount_applied: number;
  invoice?: { id: string; invoice_number: string | null; total: number | null } | null;
}

interface PaymentRow {
  id: string;
  organization_id: string;
  contact_id: string | null;
  amount: number;
  payment_date: string;
  payment_method: string;
  reference: string | null;
  notes: string | null;
  receipt_number: string | null;
  deposit_account_id: string | null;
  status?: "applied" | "voided" | "unreconciled" | null;
  created_at: string;
  contact?: { name: string; email: string | null; phone: string | null } | null;
  payment_allocations?: AllocationRow[];
}

function fmt(d?: string | null) {
  if (!d) return "—";
  try { return format(new Date(d), "PP"); } catch { return d; }
}

const TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  applied: "success",
  voided: "danger",
  unreconciled: "warning",
};

export default function CustomerPaymentRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { formatCurrency, baseCurrency } = useCurrency();
  const [row, setRow] = useState<PaymentRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isNew = id === "new";

  useEffect(() => {
    if (isNew) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      const { data, error: err } = await supabase
        .from("payments")
        .select(
          "*, contact:contacts(name, email, phone), payment_allocations(id, invoice_id, amount_applied, invoice:invoices(id, invoice_number, total))",
        )
        .eq("id", id)
        .maybeSingle();
      if (cancelled) return;
      if (err) setError(err.message);
      else setRow((data as unknown as PaymentRow) ?? null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [id, isNew]);

  const columns = useMemo<LineItemColumn[]>(() => [
    { id: "invoice", header: "Invoice", width: "minmax(0,1fr)" },
    { id: "invoiceTotal", header: "Invoice total", width: "140px", numeric: true, hideOnMobile: true },
    { id: "applied", header: "Amount applied", width: "160px", numeric: true },
  ], []);

  const rows = useMemo<LineItemRow[]>(() => {
    const allocs = row?.payment_allocations ?? [];
    return allocs.map((a, i) => ({
      id: a.id ?? String(i),
      cells: [
        { columnId: "invoice", content: a.invoice?.invoice_number ?? a.invoice_id ?? "—" },
        { columnId: "invoiceTotal", content: formatCurrency(a.invoice?.total ?? 0) },
        { columnId: "applied", content: formatCurrency(a.amount_applied ?? 0) },
      ],
    }));
  }, [row, formatCurrency]);

  const applied = useMemo(
    () => (row?.payment_allocations ?? []).reduce((s, a) => s + (a.amount_applied ?? 0), 0),
    [row],
  );
  const unapplied = Math.max((row?.amount ?? 0) - applied, 0);
  const status = row?.status || (unapplied > 0.005 ? "unreconciled" : "applied");

  return (
    <RecordScaffold
      eyebrow="Customer Payment"
      listPath="/sales/payments"
      id={id}
      loading={loading}
      error={error}
      notFound={!loading && !isNew && !row}
      newLabel="Record customer payment"
      title={row?.contact?.name ?? "Customer"}
      docNumber={row?.receipt_number ?? undefined}
      status={row ? <StatusBadge tone={TONE[status] ?? "neutral"}>{status}</StatusBadge> : undefined}
      meta={row && (
        <>
          <span>Paid {fmt(row.payment_date)}</span>
          <span>{row.payment_method.replace(/_/g, " ")}</span>
          <span className="tabular-nums">{formatCurrency(row.amount, baseCurrency)}</span>
        </>
      )}
      detailFields={row ? [
        { label: "Customer", value: row.contact?.name },
        { label: "Email", value: row.contact?.email },
        { label: "Phone", value: row.contact?.phone },
        { label: "Payment date", value: fmt(row.payment_date) },
        { label: "Method", value: row.payment_method.replace(/_/g, " ") },
        { label: "Reference", value: row.reference },
        { label: "Receipt #", value: row.receipt_number },
        { label: "Notes", value: row.notes },
      ] : undefined}
      detailsTitle="Payment details"
      lineColumns={columns}
      lineRows={rows}
      lineEmpty="Customer deposit — not yet applied to any invoice."
      totalsRows={row ? [
        { label: "Amount received", value: formatCurrency(row.amount, baseCurrency) },
        { label: "Applied to invoices", value: formatCurrency(applied, baseCurrency), muted: true },
        { label: "Unapplied", value: formatCurrency(unapplied, baseCurrency), emphasized: unapplied > 0.005 },
      ] : undefined}
      activity={row ? [
        { id: "created", at: fmt(row.created_at), actor: "System", title: `Payment ${row.receipt_number ?? id.slice(0, 8)} recorded` },
      ] : undefined}
      extraSections={row ? <DocumentVersionsSection documentType="receipt" documentId={row.id} /> : undefined}
    />
  );
}
