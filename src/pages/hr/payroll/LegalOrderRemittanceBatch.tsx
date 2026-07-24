/**
 * Legal Order Remittance Batch — Milestone 2.
 *
 * Period-scoped view of `legal_order_remittance_lines` joined with the
 * `public.legal_orders` view, grouped by authority + payment method so an
 * HR operator can settle multiple orders in one bank file. Reads-only; the
 * write path (marking as paid / generating bank files) still lives in the
 * existing payroll payments builder. This page is the "what is due this
 * period, by authority + method" projection that was missing from the
 * batch UI.
 *
 * Invariants:
 *  - Reads route through `public.legal_orders` (the view) — never
 *    `legal_orders_records` directly.
 *  - No country-specific branching; all grouping keys come from
 *    pack-seeded authority + payment method rows.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface RemittanceLineJoined {
  id: string;
  garnishment_id: string;
  amount: number;
  payment_date: string;
  reference_number: string | null;
  legal_orders: {
    id: string;
    employee_id: string;
    kind_code: string;
    case_reference: string | null;
    authority_id: string | null;
    authority_name: string | null;
    priority_class: number | null;
    // Recipient display resolved via master (ADR-0093, Phase R4b).
    recipient_id: string | null;
    legal_recipients: { display_name: string | null } | null;
    payee_payment_method_id: string | null;
  } | null;
}

interface AuthorityBucket {
  key: string;
  authority_id: string | null;
  authority_name: string;
  priority_class: number | null;
  method_groups: Array<{
    payment_method_id: string | null;
    payment_method_label: string;
    total: number;
    lines: RemittanceLineJoined[];
  }>;
  total: number;
  order_count: number;
}

function fmtMoney(n: number): string {
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function downloadCsv(filename: string, rows: Record<string, unknown>[]) {
  if (!rows.length) { toast.error("No rows to export"); return; }
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export default function LegalOrderRemittanceBatch() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [periodStart, setPeriodStart] = useState(() => format(startOfMonth(new Date()), "yyyy-MM-dd"));
  const [periodEnd, setPeriodEnd] = useState(() => format(endOfMonth(new Date()), "yyyy-MM-dd"));

  const orgId = currentOrg?.id ?? null;
  const bizId = currentBusiness?.id ?? null;

  const linesQ = useQuery<RemittanceLineJoined[]>({
    queryKey: ["legal-order-remittance-lines", orgId, bizId, periodStart, periodEnd],
    enabled: !!orgId,
    queryFn: async () => {
      let q = (supabase as any)
        .from("legal_order_remittance_lines")
        .select(`
          id, garnishment_id, amount, payment_date, reference_number,
          legal_orders:garnishment_id (
            id, employee_id, kind_code, case_reference,
            authority_id, authority_name, priority_class,
            recipient_id, payee_name, payee_payment_method_id, /* ADR-0093 retired fallback */
            legal_recipients:recipient_id ( display_name )
          )
        `)
        .eq("organization_id", orgId!)
        .gte("payment_date", periodStart)
        .lte("payment_date", periodEnd)
        .order("payment_date", { ascending: true });
      if (bizId) q = q.eq("business_id", bizId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as RemittanceLineJoined[];
    },
  });

  const methodsQ = useQuery({
    queryKey: ["org-payment-methods-for-lo", orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("organization_payment_methods")
        .select("id, name, method_type")
        .eq("organization_id", orgId!);
      if (error) return [];
      return (data ?? []) as Array<{ id: string; name: string; method_type: string | null }>;
    },
  });

  const buckets = useMemo<AuthorityBucket[]>(() => {
    const methodMap = new Map<string, string>();
    for (const m of methodsQ.data ?? []) methodMap.set(m.id, `${m.name}${m.method_type ? ` (${m.method_type})` : ""}`);

    const byAuthority = new Map<string, AuthorityBucket>();
    for (const line of linesQ.data ?? []) {
      const lo = line.legal_orders;
      const authorityKey = lo?.authority_id ?? `__unassigned__${lo?.authority_name ?? ""}`;
      const authorityName = lo?.authority_name ?? (lo?.authority_id ? "Unknown authority" : "Unassigned");
      let bucket = byAuthority.get(authorityKey);
      if (!bucket) {
        bucket = {
          key: authorityKey,
          authority_id: lo?.authority_id ?? null,
          authority_name: authorityName,
          priority_class: lo?.priority_class ?? null,
          method_groups: [],
          total: 0,
          order_count: 0,
        };
        byAuthority.set(authorityKey, bucket);
      }
      const methodId = lo?.payee_payment_method_id ?? null;
      const methodLabel = methodId ? (methodMap.get(methodId) ?? "Configured method") : "No payment method";
      let group = bucket.method_groups.find((g) => g.payment_method_id === methodId);
      if (!group) {
        group = { payment_method_id: methodId, payment_method_label: methodLabel, total: 0, lines: [] };
        bucket.method_groups.push(group);
      }
      group.lines.push(line);
      group.total += Number(line.amount ?? 0);
      bucket.total += Number(line.amount ?? 0);
      bucket.order_count = new Set([
        ...bucket.method_groups.flatMap((g) => g.lines.map((l) => l.garnishment_id)),
      ]).size;
    }
    return Array.from(byAuthority.values()).sort((a, b) => {
      const ap = a.priority_class ?? Number.MAX_SAFE_INTEGER;
      const bp = b.priority_class ?? Number.MAX_SAFE_INTEGER;
      if (ap !== bp) return ap - bp;
      return a.authority_name.localeCompare(b.authority_name);
    });
  }, [linesQ.data, methodsQ.data]);

  const grandTotal = buckets.reduce((s, b) => s + b.total, 0);
  const lineCount = (linesQ.data ?? []).length;

  function exportFlat() {
    const rows = (linesQ.data ?? []).map((l) => ({
      payment_date: l.payment_date,
      authority: l.legal_orders?.authority_name ?? "",
      priority_class: l.legal_orders?.priority_class ?? "",
      kind: l.legal_orders?.kind_code ?? "",
      case_reference: l.legal_orders?.case_reference ?? "",
      // Phase R4b: resolve recipient display via master, fall back to
      // legacy snapshot for pre-master orders.
      recipient: l.legal_orders?.legal_recipients?.display_name
        ?? l.legal_orders?.payee_name
        ?? "",
      payment_method_id: l.legal_orders?.payee_payment_method_id ?? "",
      amount: Number(l.amount ?? 0).toFixed(2),
      reference: l.reference_number ?? "",
    }));
    downloadCsv(`legal-order-remittances-${periodStart}_${periodEnd}.csv`, rows);
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold">Legal order remittance batches</h1>
          <p className="text-sm text-muted-foreground">
            Posted garnishment deductions in the selected period, grouped by authority and payment method.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label className="text-xs">From</Label>
            <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className="w-40" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">To</Label>
            <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="w-40" />
          </div>
          <Button variant="outline" size="sm" onClick={exportFlat}>Export CSV</Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/hr/payroll/legal-orders">Manage orders</Link>
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Summary</CardTitle>
          <div className="text-sm text-muted-foreground">
            {lineCount} line{lineCount === 1 ? "" : "s"} · {buckets.length} authorit{buckets.length === 1 ? "y" : "ies"} ·{" "}
            <span className="font-medium text-foreground">{fmtMoney(grandTotal)}</span> total
          </div>
        </CardHeader>
        <CardContent>
          {linesQ.isLoading ? (
            <p className="text-sm">Loading…</p>
          ) : buckets.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No posted legal-order deductions in this period.
            </p>
          ) : (
            <div className="space-y-6">
              {buckets.map((bucket) => (
                <div key={bucket.key} className="rounded-md border">
                  <div className="flex items-center justify-between px-4 py-2 bg-muted/40">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{bucket.authority_name}</span>
                      {bucket.priority_class !== null && (
                        <Badge variant="outline" className="text-[10px]">priority {bucket.priority_class}</Badge>
                      )}
                      <Badge variant="secondary" className="text-[10px]">{bucket.order_count} order{bucket.order_count === 1 ? "" : "s"}</Badge>
                    </div>
                    <div className="text-sm font-medium">{fmtMoney(bucket.total)}</div>
                  </div>
                  {bucket.method_groups.map((group) => (
                    <div key={`${bucket.key}-${group.payment_method_id ?? "none"}`} className="border-t">
                      <div className="flex items-center justify-between px-4 py-1.5 text-xs bg-muted/20">
                        <span className="text-muted-foreground">{group.payment_method_label}</span>
                        <span className="font-medium">{fmtMoney(group.total)}</span>
                      </div>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-28">Paid on</TableHead>
                            <TableHead>Kind</TableHead>
                            <TableHead>Case ref</TableHead>
                            <TableHead>Payee</TableHead>
                            <TableHead>Reference</TableHead>
                            <TableHead className="text-right">Amount</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {group.lines.map((l) => (
                            <TableRow key={l.id}>
                              <TableCell className="text-xs">{format(new Date(l.payment_date), "yyyy-MM-dd")}</TableCell>
                              <TableCell className="text-xs">{l.legal_orders?.kind_code ?? "—"}</TableCell>
                              <TableCell className="text-xs">{l.legal_orders?.case_reference ?? "—"}</TableCell>
                              <TableCell className="text-xs">{l.legal_orders?.legal_recipients?.display_name ?? l.legal_orders?.payee_name ?? "—"}</TableCell>
                              <TableCell className="text-xs">{l.reference_number ?? "—"}</TableCell>
                              <TableCell className="text-xs text-right">{fmtMoney(Number(l.amount ?? 0))}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}