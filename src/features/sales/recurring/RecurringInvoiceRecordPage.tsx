/**
 * RecurringInvoiceRecordPage — object-page route for a recurring invoice
 * template. Read-only view built on RecordScaffold. Create/edit still
 * routes through the list-page dialogs until the wizard migration lands
 * (see docs/design-system/audit/sales.md).
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { format } from "date-fns";

import { RecordScaffold } from "@/design-system/records";
import type { LineItemColumn, LineItemRow } from "@/design-system/records";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";
import type { RecurringInvoice, RecurringInvoiceItem } from "@/hooks/useRecurringInvoices";
import { type RecurringInvoiceStatus } from "@/lib/recurringLifecycle";
import { RecurringBillingHistory } from "./RecurringBillingHistory";
import { useRecurringInvoiceActions } from "./useRecurringInvoiceActions";

type Row = RecurringInvoice & {
  items?: RecurringInvoiceItem[];
  contact?: { name: string; email: string | null } | null;
};

function fmt(d?: string | null) {
  if (!d) return "—";
  try { return format(new Date(d), "PP"); } catch { return d; }
}

function calcLineTotal(l: RecurringInvoiceItem) {
  const gross = (l.quantity ?? 0) * (l.unit_price ?? 0);
  const discounted = gross * (1 - (l.discount_percent ?? 0) / 100);
  const taxed = discounted * (1 + (l.tax_rate ?? 0) / 100);
  return taxed;
}

export default function RecurringInvoiceRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { formatCurrency } = useCurrency();
  const navigate = useNavigate();
  const [row, setRow] = useState<Row | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const isNew = id === "new";

  useEffect(() => {
    if (isNew) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      const { data, error: err } = await supabase
        .from("recurring_invoices")
        .select("*, contact:contacts(name, email), items:recurring_invoice_items(*)")
        .eq("id", id)
        .maybeSingle();
      if (cancelled) return;
      if (err) setError(err.message);
      else setRow((data as unknown as Row) ?? null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [id, isNew, nonce]);

  const { actions } = useRecurringInvoiceActions(row, {
    onChanged: () => setNonce((n) => n + 1),
    onDeleted: () => navigate("/sales/recurring"),
  });

  const columns = useMemo<LineItemColumn[]>(() => [
    { id: "description", header: "Description", width: "minmax(0,1fr)" },
    { id: "qty", header: "Qty", width: "80px", numeric: true },
    { id: "unit", header: "Unit price", width: "120px", numeric: true },
    { id: "disc", header: "Disc %", width: "80px", numeric: true, hideOnMobile: true },
    { id: "tax", header: "Tax %", width: "80px", numeric: true, hideOnMobile: true },
    { id: "total", header: "Subtotal", width: "120px", numeric: true },
  ], []);

  const rows = useMemo<LineItemRow[]>(() => {
    const items = row?.items ?? [];
    return items
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((l, i) => ({
        id: l.id ?? String(i),
        cells: [
          { columnId: "description", content: l.description || "—" },
          { columnId: "qty", content: l.quantity },
          { columnId: "unit", content: formatCurrency(l.unit_price ?? 0) },
          { columnId: "disc", content: l.discount_percent ?? 0 },
          { columnId: "tax", content: l.tax_rate ?? 0 },
          { columnId: "total", content: formatCurrency(calcLineTotal(l)) },
        ],
      }));
  }, [row, formatCurrency]);

  const subtotal = useMemo(
    () => (row?.items ?? []).reduce((sum, l) => sum + calcLineTotal(l), 0),
    [row],
  );

  // `status` is the lifecycle truth; `is_active` is only its boolean shadow.
  const lifecycle = (row?.status ?? (row?.is_active ? "active" : "paused")) as RecurringInvoiceStatus;

  return (
    <RecordScaffold
      eyebrow="Recurring Invoice"
      listPath="/sales/recurring"
      id={id}
      loading={loading}
      error={error}
      notFound={!loading && !isNew && !row}
      newLabel="New recurring template"
      title={row?.template_name ?? "Recurring invoice"}
      docNumber={row?.contact?.name}
      kind="recurring_invoice"
      status={row ? lifecycle : undefined}
      meta={row && (
        <>
          <span>Every {row.frequency}</span>
          <span>Next {fmt(row.next_run_date)}</span>
          <span className="tabular-nums">{formatCurrency(subtotal)} {row.currency}</span>
        </>
      )}
      detailFields={row ? [
        { label: "Template name", value: row.template_name },
        { label: "Customer", value: row.contact?.name },
        { label: "Frequency", value: row.frequency },
        { label: "Start date", value: fmt(row.start_date) },
        { label: "End date", value: fmt(row.end_date) },
        { label: "Next run", value: fmt(row.next_run_date) },
        { label: "Last run", value: fmt(row.last_run_date) },
        { label: "Invoices generated", value: row.invoices_generated },
        { label: "Auto-send", value: row.auto_send ? "Yes" : "No" },
        { label: "Auto-confirm", value: row.auto_confirm ? "Yes" : "No" },
        { label: "Days before due", value: row.days_before_due },
        { label: "Currency", value: row.currency },
        { label: "Definition version", value: row.definition_version ?? 1 },
      ] : undefined}
      actions={actions}
      extraSections={row ? <RecurringBillingHistory recurringId={id} /> : undefined}
      lineColumns={columns}
      lineRows={rows}
      totalsRows={row ? [
        { label: "Estimated total per run", value: formatCurrency(subtotal), emphasized: true },
      ] : undefined}
      totalsFooter={row ? `Currency ${row.currency}` : undefined}
      activity={row ? [
        { id: "created", at: fmt(row.created_at), actor: "System", title: `Template ${row.template_name} created` },
        ...(row.last_run_date ? [{ id: "last-run", at: fmt(row.last_run_date), title: "Last invoice generated" }] : []),
        ...(row.next_run_date ? [{ id: "next-run", at: fmt(row.next_run_date), title: "Next scheduled run", tone: "info" as const }] : []),
      ] : undefined}
    />
  );
}
