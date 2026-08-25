/**
 * ProjectSalesTab — sales orders and invoices linked to this project.
 *
 * Reads sales_orders + invoices filtered by project_id. Buttons open the
 * existing CreateSalesOrderDialog / CreateInvoiceDialog with project_id
 * + customer (contact_id) preset so the new doc is born linked.
 */
import { formatCurrency } from "@/lib/utils";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, FileText, ShoppingCart } from "lucide-react";
import { format } from "date-fns";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useProjectWorkspace } from "./ProjectDetailLayout";
import { Skeleton } from "@/components/ui/skeleton";
import { useNavigate } from "react-router-dom";
// CreateInvoiceDialog retired — /sales/invoices/new hosts the create form.
import { useContacts } from "@/hooks/useContacts";
import { useInvoices } from "@/hooks/useInvoices";
import { BillTimesheetsButton } from "@/components/projects/BillTimesheetsButton";

interface InvoiceRow {
  id: string;
  invoice_number: string;
  status: string;
  issue_date: string | null;
  due_date: string | null;
  total: number;
  currency: string | null;
}

interface SoRow {
  id: string;
  so_number: string;
  status: string;
  order_date: string | null;
  expected_date: string | null;
  total: number;
  currency: string | null;
}

// No currency on the record means no figure — an unconverted number must
// never be shown wearing a currency it was not denominated in (ADR 0136).
const fmtMoney = (n: number, c?: string | null) =>
  c ? formatCurrency(n || 0, c) : "—";

export default function SalesTab() {
  const { project } = useProjectWorkspace();
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [sos, setSos] = useState<SoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const openCreateSo = () => {
    const qs = new URLSearchParams({ project_id: project.id });
    if (project.customer_id) qs.set("contact_id", project.customer_id);
    navigate(`/sales/orders/new?${qs.toString()}`);
  };
  const { contacts } = useContacts();
  const { createInvoice } = useInvoices();
  const customers = contacts.filter((c) => c.type === "customer" || c.type === "both");

  const refresh = async () => {
    setLoading(true);
    const [{ data: inv }, { data: so }] = await Promise.all([
      supabase
        .from("invoices")
        .select("id, invoice_number, status, issue_date, due_date, total, currency")
        .eq("project_id", project.id)
        .order("issue_date", { ascending: false })
        .limit(200),
      supabase
        .from("sales_orders")
        .select("id, so_number, status, order_date, expected_date, total, currency")
        .eq("project_id", project.id)
        .order("order_date", { ascending: false })
        .limit(200),
    ]);
    setInvoices((inv ?? []) as InvoiceRow[]);
    setSos((so ?? []) as SoRow[]);
    setLoading(false);
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [project.id]);

  const invTotal = invoices.reduce((s, r) => s + Number(r.total || 0), 0);
  const soTotal = sos.reduce((s, r) => s + Number(r.total || 0), 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        {/* Sales Orders */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <ShoppingCart className="h-4 w-4" /> Sales Orders
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                {sos.length} order{sos.length === 1 ? "" : "s"} · {fmtMoney(soTotal, project.currency)}
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={openCreateSo}>
              <Plus className="h-3.5 w-3.5 mr-1" /> New SO
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="p-4 space-y-2"><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
            ) : sos.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                No sales orders linked to this project yet.
              </div>
            ) : (
              <div className="divide-y">
                {sos.map((s) => (
                  <Link
                    key={s.id}
                    to={`/sales/orders/${s.id}`}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-muted/50"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{s.so_number}</div>
                      <div className="text-xs text-muted-foreground">
                        {s.order_date ? format(new Date(s.order_date), "MMM d, yyyy") : "—"}
                      </div>
                    </div>
                    <Badge variant="outline" className="capitalize">{s.status}</Badge>
                    <div className="text-sm font-semibold tabular-nums">
                      {fmtMoney(Number(s.total || 0), s.currency)}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Invoices */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="h-4 w-4" /> Invoices
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                {invoices.length} invoice{invoices.length === 1 ? "" : "s"} · {fmtMoney(invTotal, project.currency)}
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => navigate(`/sales/invoices/new?project_id=${project.id}${project.customer_id ? `&contact_id=${project.customer_id}` : ""}`)}>
              <Plus className="h-3.5 w-3.5 mr-1" /> New Invoice
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="p-4 space-y-2"><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
            ) : invoices.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                No invoices linked to this project yet.
              </div>
            ) : (
              <div className="divide-y">
                {invoices.map((i) => (
                  <Link
                    key={i.id}
                    to={`/invoices/${i.id}`}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-muted/50"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{i.invoice_number}</div>
                      <div className="text-xs text-muted-foreground">
                        {i.issue_date ? format(new Date(i.issue_date), "MMM d, yyyy") : "—"}
                        {i.due_date ? ` · due ${format(new Date(i.due_date), "MMM d")}` : ""}
                      </div>
                    </div>
                    <Badge variant="outline" className="capitalize">{i.status}</Badge>
                    <div className="text-sm font-semibold tabular-nums">
                      {fmtMoney(Number(i.total || 0), i.currency)}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center justify-end gap-2">
        <BillTimesheetsButton projectId={project.id} onInvoiced={refresh} />
      </div>

      {/* Create Sales Order moved to /sales/orders/new route (Phase 3). */}
      {/* Create Invoice moved to /sales/invoices/new route (Phase 3). */}
    </div>
  );
}
