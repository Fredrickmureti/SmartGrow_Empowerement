/**
 * Legal Recipients — Phase 3 enterprise workspace tab.
 *
 * Read-only, recipient-first projection of the garnishment financial
 * lifecycle. Answers the operator's daily questions:
 *
 *   • Which third parties are owed money right now, and how much?
 *   • Since when? Across how many employees and orders?
 *   • Which recipients are still unlinked to a Contact and therefore
 *     block bank-file generation?
 *
 * Writers stay in the payroll payment builder — this page only
 * surfaces balances and opens the per-recipient statement drill-down.
 *
 * Backed by:
 *   - view `public.legal_recipient_outstanding`
 *   - fn   `public.legal_recipient_statement(recipient_id, from, to)`
 */
import { useMemo, useState } from "react";
import { format, startOfMonth, endOfMonth, subMonths } from "date-fns";
import {
  useLegalRecipientOutstanding,
  useLegalRecipientStatement,
  type LegalRecipientOutstanding,
} from "@/hooks/useLegalRecipients";
import { LinkRecipientDialog } from "@/components/hr/payroll/LinkRecipientDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { supabase } from "@/integrations/supabase/client";

function fmtMoney(n: number): string {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/**
 * Opens a printable recipient statement in a new window.
 * The user's browser Print dialog can Save as PDF — no server-side
 * PDF generation is needed for a text-only reconciliation report.
 */
async function printRecipientStatement(args: {
  recipient: LegalRecipientOutstanding;
  from: string;
  to: string;
}) {
  const { recipient, from, to } = args;
  const { data, error } = await (supabase as any).rpc("legal_recipient_statement", {
    p_recipient_id: recipient.recipient_id,
    p_from: from,
    p_to: to,
  });
  if (error) {
    // eslint-disable-next-line no-alert
    alert(`Could not load statement: ${error.message}`);
    return;
  }
  const rows = (data ?? []) as Array<{
    entry_date: string;
    entry_kind: "accrual" | "remittance";
    reference: string | null;
    amount: number;
  }>;
  let running = 0;
  const bodyRows = rows
    .map((r) => {
      running += Number(r.amount ?? 0);
      return `<tr>
        <td>${r.entry_date}</td>
        <td>${r.entry_kind}</td>
        <td>${(r.reference ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" } as Record<string, string>)[c])}</td>
        <td style="text-align:right">${fmtMoney(Number(r.amount ?? 0))}</td>
        <td style="text-align:right"><strong>${fmtMoney(running)}</strong></td>
      </tr>`;
    })
    .join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"/>
    <title>Recipient Statement — ${recipient.display_name}</title>
    <style>
      body{font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;padding:32px;color:#111}
      h1{font-size:18px;margin:0 0 4px}
      h2{font-size:12px;color:#555;margin:0 0 24px;font-weight:normal}
      table{width:100%;border-collapse:collapse;font-size:12px}
      th,td{border-bottom:1px solid #e5e5e5;padding:6px 8px;text-align:left}
      th{background:#fafafa;font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:.05em}
      .totals{margin-top:24px;display:flex;justify-content:flex-end;gap:24px;font-size:12px}
      .totals strong{font-size:14px}
      .footer{margin-top:32px;font-size:10px;color:#888}
      @media print { .no-print{display:none} }
    </style></head><body>
    <h1>Recipient Statement — ${recipient.display_name}</h1>
    <h2>Period ${from} → ${to} · Generated ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC</h2>
    <table>
      <thead><tr><th>Date</th><th>Type</th><th>Reference</th><th style="text-align:right">Amount</th><th style="text-align:right">Running</th></tr></thead>
      <tbody>${bodyRows || `<tr><td colspan="5" style="text-align:center;color:#888;padding:24px">No activity in this period.</td></tr>`}</tbody>
    </table>
    <div class="totals"><span>Outstanding balance:</span> <strong>${fmtMoney(Number(recipient.outstanding_balance ?? 0))}</strong></div>
    <div class="footer">Garnishment Payable is unrelated to PAYE (income tax withholding). See ADR-0092.</div>
    <script>window.onload=()=>{window.focus();window.print();}</script>
    </body></html>`;
  const win = window.open("", "_blank", "width=900,height=1000");
  if (!win) {
    // eslint-disable-next-line no-alert
    alert("Please allow pop-ups to print the statement.");
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
}

export default function LegalRecipients() {
  const { data: recipients, isLoading } = useLegalRecipientOutstanding();
  const [linkTarget, setLinkTarget] = useState<LegalRecipientOutstanding | null>(null);
  const [selected, setSelected] = useState<LegalRecipientOutstanding | null>(null);
  const [from, setFrom] = useState(() =>
    format(startOfMonth(subMonths(new Date(), 2)), "yyyy-MM-dd"),
  );
  const [to, setTo] = useState(() => format(endOfMonth(new Date()), "yyyy-MM-dd"));

  const totals = useMemo(() => {
    const rows = recipients ?? [];
    return {
      outstanding: rows.reduce((s, r) => s + Number(r.outstanding_balance ?? 0), 0),
      unlinked: rows.filter((r) => !r.is_linked_to_contact).length,
      overdue: rows.filter(
        (r) =>
          Number(r.outstanding_balance ?? 0) > 0 &&
          r.oldest_accrual_date &&
          (!r.last_remittance_date || r.last_remittance_date < r.oldest_accrual_date),
      ).length,
    };
  }, [recipients]);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Legal Recipients</h1>
        <p className="text-muted-foreground text-sm">
          Third parties (courts, agencies, creditors) receiving money on
          behalf of employees through legal orders. Outstanding balance =
          accrued through payroll minus remitted to the recipient.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total outstanding
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {fmtMoney(totals.outstanding)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Recipients with balance older than last remittance
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{totals.overdue}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Recipients not linked to a Contact
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{totals.unlinked}</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recipients</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !recipients?.length ? (
            <p className="text-sm text-muted-foreground">
              No legal recipients yet. Recipients are created automatically
              from Contacts the first time a legal order is linked to one.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Recipient</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Jurisdiction</TableHead>
                  <TableHead className="text-right">Orders</TableHead>
                  <TableHead className="text-right">Employees</TableHead>
                  <TableHead className="text-right">Accrued</TableHead>
                  <TableHead className="text-right">Remitted</TableHead>
                  <TableHead className="text-right">Outstanding</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {recipients.map((r) => (
                  <TableRow key={r.recipient_id}>
                    <TableCell className="font-medium">{r.display_name}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {r.recipient_type_code}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {[r.jurisdiction_country, r.jurisdiction_region]
                        .filter(Boolean)
                        .join(" / ") || "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.order_count}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.employee_count}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmtMoney(Number(r.accrued_total ?? 0))}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmtMoney(Number(r.paid_total ?? 0))}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {fmtMoney(Number(r.outstanding_balance ?? 0))}
                    </TableCell>
                    <TableCell>
                      {!r.is_linked_to_contact ? (
                        <Badge variant="destructive">Recipient not linked</Badge>
                      ) : Number(r.outstanding_balance ?? 0) > 0 ? (
                        <Badge variant="secondary">Balance due</Badge>
                      ) : (
                        <Badge variant="outline">Settled</Badge>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {!r.is_linked_to_contact && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setLinkTarget(r)}
                          title="Attach this recipient to a Contact so bank-file generation and remittance can proceed."
                        >
                          Link Contact
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setSelected(r)}>
                        Statement
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{selected?.display_name}</SheetTitle>
            <SheetDescription>
              Reconciliation statement — accruals from payroll vs. remittances
              to this recipient. Unrelated to PAYE tax (see ADR-0092).
            </SheetDescription>
          </SheetHeader>

          {selected && (
            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>From</Label>
                  <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </div>
                <div>
                  <Label>To</Label>
                  <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                </div>
              </div>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    printRecipientStatement({
                      recipient: selected,
                      from,
                      to,
                    })
                  }
                >
                  Print / Save PDF
                </Button>
              </div>
              <StatementTable
                recipientId={selected.recipient_id}
                from={from}
                to={to}
              />
            </div>
          )}
        </SheetContent>
      </Sheet>

      <LinkRecipientDialog
        open={!!linkTarget}
        onOpenChange={(o) => !o && setLinkTarget(null)}
        mode={
          linkTarget
            ? {
                kind: "recipient",
                recipientId: linkTarget.recipient_id,
                recipientName: linkTarget.display_name,
              }
            : null
        }
      />
    </div>
  );
}

function StatementTable({
  recipientId,
  from,
  to,
}: {
  recipientId: string;
  from: string;
  to: string;
}) {
  const { data, isLoading } = useLegalRecipientStatement({
    recipientId,
    from,
    to,
  });

  const rows = data ?? [];
  let running = 0;
  const withRunning = rows.map((r) => {
    running += Number(r.amount ?? 0);
    return { ...r, running };
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!rows.length)
    return (
      <p className="text-sm text-muted-foreground">
        No accruals or remittances in this range.
      </p>
    );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Reference</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-right">Running</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {withRunning.map((r, i) => (
          <TableRow key={i}>
            <TableCell className="text-xs">{r.entry_date}</TableCell>
            <TableCell className="text-xs">
              <Badge variant={r.entry_kind === "accrual" ? "secondary" : "outline"}>
                {r.entry_kind}
              </Badge>
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {r.reference ?? "—"}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {fmtMoney(Number(r.amount ?? 0))}
            </TableCell>
            <TableCell className="text-right tabular-nums font-medium">
              {fmtMoney(r.running)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
