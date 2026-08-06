/**
 * ProformaRecordPage — object-page route for a Proforma Invoice.
 * Read-only view built on RecordScaffold. Create/edit still routes
 * through the list-page dialogs until the wizard migration lands
 * (see docs/design-system/audit/sales.md).
 */

import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { format } from "date-fns";

import { StatusBadge } from "@/design-system";
import { RecordScaffold } from "@/design-system/records";
import type { LineItemColumn, LineItemRow } from "@/design-system/records";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";
import type { ProformaInvoice, ProformaInvoiceItem } from "@/hooks/useProformaInvoices";
import { DocumentVersionsSection } from "@/components/documents/DocumentVersionsSection";

type Row = ProformaInvoice & {
  contact?: { name: string; email: string | null; phone: string | null } | null;
  proforma_invoice_items?: ProformaInvoiceItem[];
};

function fmt(d?: string | null) {
  if (!d) return "—";
  try { return format(new Date(d), "PP"); } catch { return d; }
}

export default function ProformaRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { formatCurrency } = useCurrency();
  const [row, setRow] = useState<Row | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isNew = id === "new";

  useEffect(() => {
    if (isNew) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      const { data, error: err } = await supabase
        .from("proforma_invoices")
        .select("*, contact:contacts(name, email, phone), proforma_invoice_items(*)")
        .eq("id", id)
        .maybeSingle();
      if (cancelled) return;
      if (err) setError(err.message);
      else setRow((data as unknown as Row) ?? null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [id, isNew]);

  const columns = useMemo<LineItemColumn[]>(() => [
    { id: "description", header: "Description", width: "minmax(0,1fr)" },
    { id: "qty", header: "Qty", width: "80px", numeric: true },
    { id: "unit", header: "Unit price", width: "120px", numeric: true },
    { id: "disc", header: "Disc %", width: "80px", numeric: true, hideOnMobile: true },
    { id: "tax", header: "Tax %", width: "80px", numeric: true, hideOnMobile: true },
    { id: "total", header: "Subtotal", width: "120px", numeric: true },
  ], []);

  const rows = useMemo<LineItemRow[]>(() => {
    const items = row?.proforma_invoice_items ?? [];
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
          { columnId: "total", content: formatCurrency(l.line_total ?? 0) },
        ],
      }));
  }, [row, formatCurrency]);

  return (
    <RecordScaffold
      eyebrow="Proforma Invoice"
      listPath="/sales/proforma"
      id={id}
      loading={loading}
      error={error}
      notFound={!loading && !isNew && !row}
      newLabel="New proforma"
      title={row?.contact?.name ?? "Customer"}
      docNumber={row?.proforma_number}
      kind="proforma"
      status={row?.status}
      meta={row && (
        <>
          <span>Issued {fmt(row.issue_date)}</span>
          <span>Expires {fmt(row.expiry_date)}</span>
          <span className="tabular-nums">{formatCurrency(row.total ?? 0)} {row.currency}</span>
        </>
      )}
      detailFields={row ? [
        { label: "Customer", value: row.contact?.name },
        { label: "Email", value: row.contact?.email },
        { label: "Phone", value: row.contact?.phone },
        { label: "Issue date", value: fmt(row.issue_date) },
        { label: "Expiry date", value: fmt(row.expiry_date) },
        { label: "Currency", value: row.currency },
        { label: "Converted invoice", value: row.converted_invoice_id ?? "—" },
        { label: "Converted at", value: fmt(row.converted_at) },
      ] : undefined}
      lineColumns={columns}
      lineRows={rows}
      totalsRows={row ? [
        { label: "Subtotal", value: formatCurrency(row.subtotal ?? 0) },
        { label: "Discount", value: `- ${formatCurrency(row.discount_amount ?? 0)}`, muted: true },
        { label: "Tax", value: formatCurrency(row.tax_amount ?? 0) },
        { label: "Total", value: formatCurrency(row.total ?? 0), emphasized: true },
      ] : undefined}
      totalsFooter={row ? `Currency ${row.currency}` : undefined}
      activity={row ? [
        { id: "created", at: fmt(row.created_at), actor: "System", title: `Proforma ${row.proforma_number} created` },
        ...(row.converted_at ? [{ id: "converted", at: fmt(row.converted_at), title: "Converted to invoice", tone: "success" as const }] : []),
      ] : undefined}
      extraSections={row ? <DocumentVersionsSection documentType="proforma" documentId={row.id} /> : undefined}
    />
  );
}