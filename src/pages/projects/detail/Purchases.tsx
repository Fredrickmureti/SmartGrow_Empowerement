/**
 * ProjectPurchasesTab — purchase orders, vendor bills, and expenses
 * linked to this project.
 */
import { formatCurrency } from "@/lib/utils";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Receipt, ShoppingBag, Wallet, Plus } from "lucide-react";
import { format } from "date-fns";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useProjectWorkspace } from "./ProjectDetailLayout";
import { Skeleton } from "@/components/ui/skeleton";
import { PermissionGate } from "@/components/common/PermissionGate";

interface PoRow { id: string; po_number: string; status: string; order_date: string | null; total: number; currency: string | null; }
interface BillRow { id: string; bill_number: string; status: string; bill_date: string | null; due_date: string | null; total: number; currency: string | null; }
interface ExpRow { id: string; reference: string | null; status: string; expense_date: string | null; amount: number; currency: string | null; description: string | null; }

// No currency on the record means no figure — an unconverted number must
// never be shown wearing a currency it was not denominated in (ADR 0136).
const fmtMoney = (n: number, c?: string | null) =>
  c ? formatCurrency(n || 0, c) : "—";

export default function PurchasesTab() {
  const { project } = useProjectWorkspace();
  const [pos, setPos] = useState<PoRow[]>([]);
  const [bills, setBills] = useState<BillRow[]>([]);
  const [expenses, setExpenses] = useState<ExpRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [{ data: po }, { data: bl }, { data: ex }] = await Promise.all([
        supabase.from("purchase_orders")
          .select("id, po_number, status, order_date, total, currency")
          .eq("project_id", project.id)
          .order("order_date", { ascending: false }).limit(200),
        supabase.from("bills")
          .select("id, bill_number, status, bill_date, due_date, total, currency")
          .eq("project_id", project.id)
          .order("bill_date", { ascending: false }).limit(200),
        supabase.from("expenses")
          .select("id, reference, status, expense_date, amount, currency, description")
          .eq("project_id", project.id)
          .order("expense_date", { ascending: false }).limit(200),
      ]);
      if (!cancelled) {
        setPos((po ?? []) as PoRow[]);
        setBills((bl ?? []) as BillRow[]);
        setExpenses((ex ?? []) as ExpRow[]);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [project.id]);

  const sum = <T,>(rows: T[], key: keyof T) =>
    rows.reduce((s, r) => s + Number((r[key] as unknown as number) || 0), 0);

  const pid = project.id;
  return (
    <div className="space-y-4">
      <PermissionGate permission="manageProjects">
        <div className="flex items-center justify-end gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to={`/purchases/orders?action=create&project_id=${pid}`}>
              <Plus className="h-4 w-4 mr-1" /> New PO
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to={`/purchases/bills?action=create&project_id=${pid}`}>
              <Plus className="h-4 w-4 mr-1" /> New Bill
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to={`/purchases/expenses?action=create&project_id=${pid}`}>
              <Plus className="h-4 w-4 mr-1" /> New Expense
            </Link>
          </Button>
        </div>
      </PermissionGate>
      <div className="grid gap-4 md:grid-cols-3">
        {/* POs */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ShoppingBag className="h-4 w-4" /> Purchase Orders
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              {pos.length} · {fmtMoney(sum(pos, "total"), project.currency)}
            </p>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? <div className="p-4"><Skeleton className="h-16" /></div>
              : pos.length === 0 ? <div className="p-6 text-center text-sm text-muted-foreground">No POs linked.</div>
              : <div className="divide-y">
                  {pos.map((p) => (
                    <Link key={p.id} to={`/purchases/orders/${p.id}`} className="flex items-center justify-between gap-2 px-4 py-2.5 hover:bg-muted/50">
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{p.po_number}</div>
                        <div className="text-xs text-muted-foreground">{p.order_date ? format(new Date(p.order_date), "MMM d, yyyy") : "—"}</div>
                      </div>
                      <Badge variant="outline" className="capitalize text-xs">{p.status}</Badge>
                      <div className="text-sm font-semibold tabular-nums">{fmtMoney(Number(p.total || 0), p.currency)}</div>
                    </Link>
                  ))}
                </div>}
          </CardContent>
        </Card>

        {/* Bills */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Receipt className="h-4 w-4" /> Vendor Bills
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              {bills.length} · {fmtMoney(sum(bills, "total"), project.currency)}
            </p>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? <div className="p-4"><Skeleton className="h-16" /></div>
              : bills.length === 0 ? <div className="p-6 text-center text-sm text-muted-foreground">No bills linked.</div>
              : <div className="divide-y">
                  {bills.map((b) => (
                    <Link key={b.id} to={`/purchases/bills/${b.id}`} className="flex items-center justify-between gap-2 px-4 py-2.5 hover:bg-muted/50">
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{b.bill_number}</div>
                        <div className="text-xs text-muted-foreground">{b.bill_date ? format(new Date(b.bill_date), "MMM d, yyyy") : "—"}</div>
                      </div>
                      <Badge variant="outline" className="capitalize text-xs">{b.status}</Badge>
                      <div className="text-sm font-semibold tabular-nums">{fmtMoney(Number(b.total || 0), b.currency)}</div>
                    </Link>
                  ))}
                </div>}
          </CardContent>
        </Card>

        {/* Expenses */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Wallet className="h-4 w-4" /> Expenses
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              {expenses.length} · {fmtMoney(sum(expenses, "amount"), project.currency)}
            </p>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? <div className="p-4"><Skeleton className="h-16" /></div>
              : expenses.length === 0 ? <div className="p-6 text-center text-sm text-muted-foreground">No expenses linked.</div>
              : <div className="divide-y">
                  {expenses.map((e) => (
                    <Link key={e.id} to={`/purchases/expenses?id=${e.id}`} className="flex items-center justify-between gap-2 px-4 py-2.5 hover:bg-muted/50">
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{e.reference || e.description || "Expense"}</div>
                        <div className="text-xs text-muted-foreground">{e.expense_date ? format(new Date(e.expense_date), "MMM d, yyyy") : "—"}</div>
                      </div>
                      <Badge variant="outline" className="capitalize text-xs">{e.status}</Badge>
                      <div className="text-sm font-semibold tabular-nums">{fmtMoney(Number(e.amount || 0), e.currency)}</div>
                    </Link>
                  ))}
                </div>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
