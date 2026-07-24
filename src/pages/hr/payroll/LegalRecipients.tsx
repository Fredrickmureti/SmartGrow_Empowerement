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

function fmtMoney(n: number): string {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export default function LegalRecipients() {
  const { data: recipients, isLoading } = useLegalRecipientOutstanding();
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
                    <TableCell>
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
              <StatementTable
                recipientId={selected.recipient_id}
                from={from}
                to={to}
              />
            </div>
          )}
        </SheetContent>
      </Sheet>
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
