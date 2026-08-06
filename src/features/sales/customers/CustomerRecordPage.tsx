/**
 * CustomerRecordPage — object-page route for a customer (contact scoped
 * to the customer role). Read-only view built on RecordScaffold.
 * The 360-degree profile lives at `/contacts-app/profile?id=<id>`; this
 * page is the enterprise-grade Sales-scoped record surface — deep-linkable
 * from the Sales list, wired to the same navigation model as Invoices,
 * Estimates, SOs, Proforma, Delivery/Credit Notes and Sales Returns.
 * Create/edit still routes through the list-page dialog until the wizard
 * migration lands (see docs/design-system/audit/sales.md).
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { format } from "date-fns";

import { StatusBadge } from "@/design-system";
import { RecordScaffold } from "@/design-system/records";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";
import { Button } from "@/components/ui/button";
import { ExternalLink, ScrollText } from "lucide-react";
import type { Contact } from "@/hooks/useContactsPaginated";

interface Aggregates {
  outstanding: number;
  openInvoices: number;
  totalRevenue: number;
  invoiceCount: number;
  lastPayment: string | null;
}

function fmt(d?: string | null) {
  if (!d) return "—";
  try { return format(new Date(d), "PP"); } catch { return d; }
}

export default function CustomerRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency, baseCurrency } = useCurrency();
  const [row, setRow] = useState<Contact | null>(null);
  const [agg, setAgg] = useState<Aggregates | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isNew = id === "new";

  useEffect(() => {
    if (isNew) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      const contactQ = supabase
        .from("contacts")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      const invoicesQ = supabase
        .from("invoices")
        .select("id, total, balance_due, status, payment_date")
        .eq("contact_id", id);
      const [{ data: contact, error: cErr }, { data: invoices }] = await Promise.all([contactQ, invoicesQ]);
      if (cancelled) return;
      if (cErr) { setError(cErr.message); setLoading(false); return; }
      setRow((contact as unknown as Contact) ?? null);
      if (invoices) {
        const list = invoices as Array<{ total?: number | null; balance_due?: number | null; status?: string | null; payment_date?: string | null }>;
        const outstanding = list.reduce((s, i) => s + (Number(i.balance_due) || 0), 0);
        const openInvoices = list.filter((i) => (i.status ?? "").toLowerCase() !== "paid" && (i.status ?? "").toLowerCase() !== "void").length;
        const totalRevenue = list.reduce((s, i) => s + (Number(i.total) || 0), 0);
        const lastPayment = list
          .map((i) => i.payment_date)
          .filter(Boolean)
          .sort()
          .pop() ?? null;
        setAgg({ outstanding, openInvoices, totalRevenue, invoiceCount: list.length, lastPayment });
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [id, isNew]);

  const address = useMemo(() => {
    if (!row) return "—";
    const parts = [row.address_line1, row.address_line2, row.city, row.state, row.postal_code, row.country].filter(Boolean);
    return parts.length ? parts.join(", ") : "—";
  }, [row]);

  const statusLabel = row ? (row.credit_hold ? "Credit hold" : row.is_active ? "Active" : "Inactive") : "";
  const statusTone: "success" | "warning" | "neutral" = row?.credit_hold
    ? "warning"
    : row?.is_active
      ? "success"
      : "neutral";

  const headerActions = row ? (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => navigate(`/sales/customers/${row.id}/ledger`)}
      >
        <ScrollText className="mr-2 h-4 w-4" /> Ledger
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => navigate(`/contacts-app/profile?id=${row.id}`)}
      >
        <ExternalLink className="mr-2 h-4 w-4" /> 360° profile
      </Button>
    </div>
  ) : undefined;

  return (
    <RecordScaffold
      eyebrow="Customer"
      listPath="/sales/customers"
      id={id}
      loading={loading}
      error={error}
      notFound={!loading && !isNew && !row}
      newLabel="New customer"
      title={row?.name ?? "Customer"}
      docNumber={row?.company || undefined}
      status={row ? <StatusBadge tone={statusTone}>{statusLabel}</StatusBadge> : undefined}
      meta={row && (
        <>
          {row.email && <span>{row.email}</span>}
          {row.phone && <span>{row.phone}</span>}
          {agg && <span className="tabular-nums">Outstanding {formatCurrency(agg.outstanding, baseCurrency)}</span>}
        </>
      )}
      headerActions={headerActions}
      detailFields={row ? [
        { label: "Name", value: row.name },
        { label: "Company", value: row.company },
        { label: "Type", value: row.type },
        { label: "Email", value: row.email },
        { label: "Phone", value: row.phone },
        { label: "Tax ID", value: row.tax_id },
        { label: "Address", value: address },
        { label: "Credit limit", value: row.credit_limit != null ? formatCurrency(row.credit_limit, baseCurrency) : "—" },
        { label: "Credit hold", value: row.credit_hold ? "Yes" : "No" },
        { label: "Customer rank", value: row.customer_rank },
        { label: "Notes", value: row.notes },
      ] : undefined}
      detailsTitle="Customer details"
      totalsRows={agg ? [
        { label: "Outstanding", value: formatCurrency(agg.outstanding, baseCurrency), emphasized: true },
        { label: "Open invoices", value: agg.openInvoices },
        { label: "Total revenue", value: formatCurrency(agg.totalRevenue, baseCurrency), muted: true },
        { label: "Invoice count", value: agg.invoiceCount, muted: true },
      ] : undefined}
      totalsFooter={agg?.lastPayment ? `Last payment ${fmt(agg.lastPayment)}` : undefined}
      activity={row ? [
        { id: "created", at: fmt(row.created_at), actor: "System", title: `Customer ${row.name} created` },
        ...(row.updated_at && row.updated_at !== row.created_at
          ? [{ id: "updated", at: fmt(row.updated_at), title: "Customer record updated" }]
          : []),
      ] : undefined}
    />
  );
}
