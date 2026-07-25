/**
 * Legal Orders — Reports tab. Phase R7.
 *
 * Two-pane surface:
 *   1. Catalog of statutory report definitions
 *      (`legal_order_statutory_report_definitions`, platform + tenant scope).
 *   2. On-demand recipient statement runner powered by the
 *      `legal_order_recipient_statement(org, recipient, from, to)` RPC.
 *
 * Read-only by design — this surface does not mutate any legal-order
 * state. All writes flow through the FSM RPCs on the Orders tab.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useLegalRecipients } from "@/hooks/useLegalRecipients";
import { useEmployees } from "@/hooks/useEmployees";
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { FileText, Download, Calendar, Building2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

type StatutoryDef = {
  id: string;
  organization_id: string | null;
  jurisdiction_code: string;
  report_code: string;
  name: string;
  description: string | null;
  frequency: string;
  is_active: boolean;
};

type StatementOrder = {
  legal_order_id: string;
  order_reference: string | null;
  status: string;
  employee_id: string;
  total_owed: number | null;
  accrued_period: number | null;
  paid_period: number | null;
  accrued_to_date: number | null;
  paid_to_date: number | null;
  outstanding: number | null;
};

type StatementBatch = {
  batch_id: string;
  batch_number: string | null;
  status: string;
  period_from: string;
  period_to: string;
  planned_total: number | null;
  settled_at: string | null;
  settled_payment_date: string | null;
  settled_reference: string | null;
  bank_file_format: string | null;
  bank_file_checksum: string | null;
};

type RecipientStatement = {
  recipient: Record<string, any> | null;
  period_from: string;
  period_to: string;
  totals: {
    accrued_period?: number;
    paid_period?: number;
    outstanding?: number;
    accrued_to_date?: number;
    paid_to_date?: number;
  };
  orders: StatementOrder[];
  batches: StatementBatch[];
};

const fmt = (n: number | null | undefined) =>
  new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    Number(n ?? 0),
  );

function todayIso(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(filename: string, rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) {
    toast.info("No rows to export");
    return;
  }
  const headers = Object.keys(rows[0]);
  const body = rows
    .map((r) => headers.map((h) => csvEscape(r[h])).join(","))
    .join("\n");
  const blob = new Blob([headers.join(",") + "\n" + body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function LegalOrdersReports() {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id ?? null;
  const { data: recipients = [] } = useLegalRecipients();
  const { employees } = useEmployees();
  const employeeById = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of employees ?? []) {
      const label =
        [(e as any).first_name, (e as any).last_name].filter(Boolean).join(" ").trim() ||
        (e as any).full_name || (e as any).employee_number || "Employee";
      m.set(e.id, label);
    }
    return m;
  }, [employees]);

  const [recipientId, setRecipientId] = useState<string>("");
  const [from, setFrom] = useState<string>(todayIso(-30));
  const [to, setTo] = useState<string>(todayIso(0));
  const [runToken, setRunToken] = useState(0);

  const defs = useQuery<StatutoryDef[]>({
    queryKey: ["legal-order-statutory-defs", orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("legal_order_statutory_report_definitions")
        .select(
          "id, organization_id, jurisdiction_code, report_code, name, description, frequency, is_active",
        )
        .eq("is_active", true)
        .order("jurisdiction_code", { ascending: true })
        .order("report_code", { ascending: true });
      if (error) throw error;
      return (data ?? []) as StatutoryDef[];
    },
  });

  const statement = useQuery<RecipientStatement>({
    queryKey: ["legal-order-recipient-statement", orgId, recipientId, from, to, runToken],
    enabled: !!orgId && !!recipientId && runToken > 0,
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("legal_order_recipient_statement", {
        _organization_id: orgId,
        _recipient_id: recipientId,
        _from: from,
        _to: to,
      });
      if (error) throw error;
      return data as RecipientStatement;
    },
  });

  const selectedRecipient = useMemo(
    () => recipients.find((r) => r.id === recipientId) ?? null,
    [recipients, recipientId],
  );

  const canRun = !!orgId && !!recipientId && !!from && !!to && from <= to;

  return (
    <div className="p-6 space-y-6">
      {/* Statutory report catalog */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" /> Statutory report catalog
          </CardTitle>
          <CardDescription>
            Jurisdiction-specific report definitions available for this tenant.
            Platform defaults apply everywhere; tenant-scoped overrides take precedence.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {defs.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : (defs.data ?? []).length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No statutory report definitions available.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Report</TableHead>
                  <TableHead>Jurisdiction</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Frequency</TableHead>
                  <TableHead>Scope</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(defs.data ?? []).map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <div className="font-medium">{d.name}</div>
                      {d.description && (
                        <div className="text-xs text-muted-foreground">{d.description}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{d.jurisdiction_code}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{d.report_code}</TableCell>
                    <TableCell className="capitalize">{d.frequency}</TableCell>
                    <TableCell>
                      <Badge variant={d.organization_id ? "default" : "secondary"}>
                        {d.organization_id ? "Tenant" : "Platform"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Recipient statement runner */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" /> Recipient statement
          </CardTitle>
          <CardDescription>
            Per-recipient reconciliation across all their legal orders — accrued
            vs remitted, with the underlying orders and remittance batches for
            the selected period.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div className="md:col-span-2 space-y-1">
              <Label>Recipient</Label>
              <Select value={recipientId} onValueChange={setRecipientId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a recipient…" />
                </SelectTrigger>
                <SelectContent>
                  {recipients.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.display_name}
                      {r.jurisdiction_country ? ` · ${r.jurisdiction_country}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>From</Label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>To</Label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              onClick={() => setRunToken((t) => t + 1)}
              disabled={!canRun || statement.isFetching}
            >
              <RefreshCw
                className={`h-4 w-4 mr-2 ${statement.isFetching ? "animate-spin" : ""}`}
              />
              Run statement
            </Button>
            {selectedRecipient && (
              <span className="text-xs text-muted-foreground">
                <Calendar className="inline h-3 w-3 mr-1" />
                {from} → {to}
              </span>
            )}
          </div>

          {statement.error && (
            <div className="text-sm text-destructive">
              {(statement.error as any)?.message ?? "Failed to run statement"}
            </div>
          )}

          {statement.data && (
            <StatementResult
              data={statement.data}
              employeeById={employeeById}
              onExportOrders={() =>
                downloadCsv(
                  `recipient-statement-orders-${from}_${to}.csv`,
                  (statement.data!.orders ?? []).map((o) => ({
                    order_reference: o.order_reference ?? "",
                    employee: employeeById.get(o.employee_id) ?? o.employee_id,
                    status: o.status,
                    total_owed: o.total_owed ?? 0,
                    accrued_in_period: o.accrued_period ?? 0,
                    paid_in_period: o.paid_period ?? 0,
                    accrued_to_date: o.accrued_to_date ?? 0,
                    paid_to_date: o.paid_to_date ?? 0,
                    outstanding: o.outstanding ?? 0,
                  })),
                )
              }
              onExportBatches={() =>
                downloadCsv(
                  `recipient-statement-batches-${from}_${to}.csv`,
                  (statement.data!.batches ?? []).map((b) => ({
                    batch_number: b.batch_number ?? "",
                    period_from: b.period_from,
                    period_to: b.period_to,
                    status: b.status,
                    planned_total: b.planned_total ?? 0,
                    settled_payment_date: b.settled_payment_date ?? "",
                    settled_reference: b.settled_reference ?? "",
                    bank_file_format: b.bank_file_format ?? "",
                  })),
                )
              }
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatementResult({
  data,
  employeeById,
  onExportOrders,
  onExportBatches,
}: {
  data: RecipientStatement;
  employeeById: Map<string, string>;
  onExportOrders: () => void;
  onExportBatches: () => void;
}) {
  const t = data.totals ?? {};
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <TotalTile label="Orders" value={String((data.orders ?? []).length)} />
        <TotalTile label="Accrued in period" value={fmt(t.accrued_period)} />
        <TotalTile label="Paid in period" value={fmt(t.paid_period)} />
        <TotalTile label="Paid to date" value={fmt(t.paid_to_date)} />
        <TotalTile label="Outstanding" value={fmt(t.outstanding)} accent />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="font-medium text-sm">Orders in period</div>
          <Button size="sm" variant="outline" onClick={onExportOrders}>
            <Download className="h-3 w-3 mr-1" /> CSV
          </Button>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Case reference</TableHead>
              <TableHead>Employee</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Owed</TableHead>
              <TableHead className="text-right">Accrued (period)</TableHead>
              <TableHead className="text-right">Paid (period)</TableHead>
              <TableHead className="text-right">Outstanding</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data.orders ?? []).map((o) => (
              <TableRow key={o.legal_order_id}>
                <TableCell className="font-medium">
                  {o.order_reference ?? <span className="text-muted-foreground italic">No case reference</span>}
                </TableCell>
                <TableCell>
                  {employeeById.get(o.employee_id) ?? <span className="text-muted-foreground italic">Unknown employee</span>}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="capitalize">{o.status.replace(/_/g, " ")}</Badge>
                </TableCell>
                <TableCell className="text-right">{fmt(o.total_owed)}</TableCell>
                <TableCell className="text-right">{fmt(o.accrued_period)}</TableCell>
                <TableCell className="text-right">{fmt(o.paid_period)}</TableCell>
                <TableCell className="text-right font-medium">{fmt(o.outstanding)}</TableCell>
              </TableRow>
            ))}
            {(data.orders ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground text-sm">
                  No orders for this recipient
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="font-medium text-sm">Remittance batches</div>
          <Button size="sm" variant="outline" onClick={onExportBatches}>
            <Download className="h-3 w-3 mr-1" /> CSV
          </Button>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Batch</TableHead>
              <TableHead>Period</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Bank reference</TableHead>
              <TableHead>Settled on</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data.batches ?? []).map((b) => (
              <TableRow key={b.batch_id}>
                <TableCell className="font-medium">
                  {b.batch_number ?? <span className="text-muted-foreground italic">Unnumbered</span>}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {b.period_from} → {b.period_to}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="capitalize">{b.status}</Badge>
                </TableCell>
                <TableCell>
                  {b.settled_reference ?? <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell>{b.settled_payment_date ?? "—"}</TableCell>
                <TableCell className="text-right font-medium">{fmt(b.planned_total)}</TableCell>
              </TableRow>
            ))}
            {(data.batches ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground text-sm">
                  No remittance batches in period
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function TotalTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-md border p-3 ${
        accent ? "bg-primary/5 border-primary/30" : "bg-muted/30"
      }`}
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
