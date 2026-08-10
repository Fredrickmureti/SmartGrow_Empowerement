/**
 * Customer Ledger directory — /sales/ledger
 *
 * A first-class entry point to the canonical customer ledger (ADR 0027).
 * The ledger itself lives at /sales/customers/:id/ledger; this page only
 * lists customers (position read from `finance_ar_net_position`) so the
 * ledger is reachable without going through Collections.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import {
  fetchCustomerLedgerIndex,
  fetchLedgerSearchableCustomers,
  type CustomerLedgerIndexRow,
} from "@/services/finance/customerLedgerIndex";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ArrowUpRight, ScrollText, Search } from "lucide-react";

type Row = CustomerLedgerIndexRow & { hasPosition: boolean };

export default function CustomerLedgerIndex() {
  const { currentBusiness } = useBusinesses();
  const { formatCurrency } = useCurrency();
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const orgId = currentBusiness?.organization_id;
  const businessId = currentBusiness?.id ?? null;

  useEffect(() => {
    if (!orgId) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    Promise.all([
      fetchCustomerLedgerIndex(orgId, businessId),
      fetchLedgerSearchableCustomers(orgId, businessId),
    ])
      .then(([positions, customers]) => {
        if (cancelled) return;
        const seen = new Set(positions.map((p) => p.contactId));
        const zero: Row[] = customers
          .filter((c) => !seen.has(c.id))
          .map((c) => ({
            contactId: c.id,
            contactName: c.name,
            netAmount: 0,
            openAmount: 0,
            creditAmount: 0,
            openDocumentCount: 0,
            maxDaysOverdue: 0,
            hasPosition: false,
          }));
        setRows([
          ...positions.map((p) => ({ ...p, hasPosition: true })),
          ...zero,
        ]);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message ?? "Failed to load customers");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, businessId]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((r) => r.contactName.toLowerCase().includes(term));
  }, [rows, search]);

  const totals = useMemo(
    () => ({
      customers: rows.filter((r) => r.hasPosition).length,
      net: rows.reduce((s, r) => s + r.netAmount, 0),
      credit: rows.reduce((s, r) => s + r.creditAmount, 0),
    }),
    [rows],
  );

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <ScrollText className="h-6 w-6 text-muted-foreground" />
            Customer ledger
          </h1>
          <p className="text-sm text-muted-foreground">
            Pick a customer to open their chronological ledger — invoices,
            payments, deposits, credit notes and refunds in one running balance.
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link to="/sales/collections">Collections workspace</Link>
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <div className="text-xs uppercase text-muted-foreground">
            Customers with open items
          </div>
          <div className="text-2xl font-semibold tabular-nums">
            {totals.customers}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase text-muted-foreground">
            Net receivable
          </div>
          <div className="text-2xl font-semibold tabular-nums">
            {formatCurrency(totals.net)}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase text-muted-foreground">
            Unapplied credit
          </div>
          <div className="text-2xl font-semibold tabular-nums">
            {formatCurrency(totals.credit)}
          </div>
        </Card>
      </div>

      <Card className="p-4">
        <div className="relative mb-4 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search customers…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {error && (
          <div className="text-sm text-destructive mb-3">{error}</div>
        )}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead className="text-right">Open items</TableHead>
              <TableHead className="text-right">Credit</TableHead>
              <TableHead className="text-right">Days overdue</TableHead>
              <TableHead className="text-right">Net balance</TableHead>
              <TableHead className="text-right">Ledger</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-8 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-muted-foreground py-8"
                >
                  No customers match “{search}”.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((row) => (
                <TableRow key={row.contactId} className="hover:bg-muted/40">
                  <TableCell className="font-medium">
                    <Link
                      to={`/sales/customers/${row.contactId}/ledger`}
                      className="hover:underline"
                    >
                      {row.contactName}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.openDocumentCount || "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {row.creditAmount > 0.01 ? formatCurrency(row.creditAmount) : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.maxDaysOverdue > 0 ? (
                      <Badge variant={row.maxDaysOverdue > 60 ? "destructive" : "secondary"}>
                        {row.maxDaysOverdue}d
                      </Badge>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-semibold">
                    {formatCurrency(row.netAmount)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" asChild>
                      <Link to={`/sales/customers/${row.contactId}/ledger`}>
                        Open <ArrowUpRight className="ml-1 h-4 w-4" />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
