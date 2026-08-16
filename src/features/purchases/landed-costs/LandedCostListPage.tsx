/**
 * LandedCostListPage — the landed cost workbench.
 *
 * Buckets mirror the voucher lifecycle a cost accountant actually works:
 * charges still being captured, allocations awaiting a posting decision, and
 * the posted/reversed history. Every row peeks; the peek and the record page
 * render the same descriptor.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Search } from "lucide-react";

import {
  ActionBar,
  EmptyState,
  ErrorState,
  FilterBar,
  LoadingState,
  PageBody,
  PageHeader,
} from "@/design-system";
import { DocumentStatusBadge } from "@/design-system/records";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCurrency } from "@/hooks/useCurrency";
import { useLandedCostVouchers, type LandedCostVoucherRow } from "./useLandedCosts";
import { LandedCostPeekSheet } from "./LandedCostPeekSheet";
import { LandedCostRowActions } from "./LandedCostRowActions";
import {
  useLandedCostClearingExposure,
  useLandedCostWorkspaceSummary,
} from "./useLandedCostReporting";

type BucketId = "capture" | "allocated" | "posted" | "closed" | "all";

const BUCKETS: {
  id: BucketId;
  label: string;
  hint: string;
  match: (r: LandedCostVoucherRow) => boolean;
}[] = [
  {
    id: "capture",
    label: "Capturing charges",
    hint: "Draft vouchers whose charges have not been spread over receipt lines yet.",
    match: (r) => r.status === "draft" || r.status === "pending_approval",
  },
  {
    id: "allocated",
    label: "Awaiting posting",
    hint: "Allocated vouchers holding cost that has not reached the ledger.",
    match: (r) => r.status === "allocated",
  },
  {
    id: "posted",
    label: "Posted",
    hint: "Capitalised onto stock and expensed to cost of sales.",
    match: (r) => r.status === "posted",
  },
  {
    id: "closed",
    label: "Reversed / cancelled",
    hint: "Vouchers unwound or abandoned.",
    match: (r) => r.status === "reversed" || r.status === "cancelled",
  },
  { id: "all", label: "All", hint: "Every voucher in this business.", match: () => true },
];

export default function LandedCostListPage() {
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const { rows, loading, error, refresh } = useLandedCostVouchers();
  const [q, setQ] = useState("");
  const [bucket, setBucket] = useState<BucketId>("capture");
  const [peekId, setPeekId] = useState<string | null>(null);
  const { exposure } = useLandedCostClearingExposure();
  const { summary } = useLandedCostWorkspaceSummary();

  // Counts and money come from the server-side aggregate over every voucher in
  // the business — never from the page of rows this table happens to hold.
  const counts: Record<BucketId, number | null> = {
    capture: summary?.captureCount ?? null,
    allocated: summary?.allocatedCount ?? null,
    posted: summary?.postedCount ?? null,
    closed: summary?.closedCount ?? null,
    all: summary?.totalCount ?? null,
  };

  const active = BUCKETS.find((b) => b.id === bucket) ?? BUCKETS[0];

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (!active.match(r)) return false;
      if (!needle) return true;
      return (
        (r.voucher_number ?? "").toLowerCase().includes(needle) ||
        (r.shipment_reference ?? "").toLowerCase().includes(needle)
      );
    });
  }, [rows, q, active]);

  return (
    <>
      <PageHeader
        eyebrow="Purchases"
        title="Landed costs"
        description="Freight, duty, insurance and handling captured on a voucher, allocated across received stock, then posted to the ledger."
        actions={
          <ActionBar>
            <Button variant="outline" size="sm" onClick={refresh}>
              Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate("/purchases/landed-costs/component-types")}
            >
              Charge types
            </Button>

            <Button size="sm" onClick={() => navigate("/purchases/landed-costs/new")}>
              <Plus className="mr-2 h-4 w-4" /> New voucher
            </Button>
          </ActionBar>
        }
      />
      <PageBody>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: "Capturing charges", value: summary ? String(summary.captureCount) : "—" },
            { label: "Awaiting posting", value: summary ? String(summary.allocatedCount) : "—" },
            {
              label: "Charge value not yet in the ledger",
              value: summary ? formatCurrency(summary.unpostedAmount) : "—",
            },
            {
              label: "Added to stock value",
              value: summary ? formatCurrency(summary.capitalizedAmount) : "—",
            },
          ].map((k) => (
            <div key={k.label} className="rounded-lg border bg-card p-4">
              <p className="text-sm text-muted-foreground">{k.label}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{k.value}</p>
            </div>
          ))}
        </div>

        {exposure && (exposure.clearing_balance !== 0 || exposure.unposted_count > 0) && (
          <div className="rounded-lg border bg-card p-4">
            <p className="text-sm font-medium">Landed cost clearing</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {exposure.clearing_account_id
                ? `Clearing account balance ${formatCurrency(exposure.clearing_balance)}.`
                : "No clearing account is mapped for landed cost yet."}
              {exposure.unposted_count > 0
                ? ` ${formatCurrency(exposure.unposted_amount)} across ${exposure.unposted_count} voucher(s) has been allocated but not posted, so it is not in the ledger.`
                : " Every allocated voucher has reached the ledger."}
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {BUCKETS.map((b) => (
            <button
              key={b.id}
              type="button"
              title={b.hint}
              onClick={() => setBucket(b.id)}
              className={
                "rounded-full border px-3 py-1.5 text-sm transition-colors " +
                (bucket === b.id
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input bg-background hover:bg-muted")
              }
            >
              {b.label}
              <span
                className={
                  "ml-2 tabular-nums " +
                  (bucket === b.id ? "opacity-80" : "text-muted-foreground")
                }
              >
                {counts[b.id] ?? "—"}
              </span>
            </button>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">{active.hint}</p>

        <FilterBar>
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search voucher # or shipment reference…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-8"
            />
          </div>
        </FilterBar>

        {loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState title="Failed to load landed cost vouchers" description={error} />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={rows.length === 0 ? "No landed cost vouchers yet" : "No matches"}
            description={
              rows.length === 0
                ? "Create a voucher to capture freight, duty and handling against completed goods receipts."
                : "Adjust the filters to see more results."
            }
            action={
              rows.length === 0 ? (
                <Button size="sm" onClick={() => navigate("/purchases/landed-costs/new")}>
                  <Plus className="mr-2 h-4 w-4" /> New voucher
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Voucher</TableHead>
                  <TableHead>Shipment</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Charges</TableHead>
                  <TableHead className="text-right">Capitalised</TableHead>
                  <TableHead className="text-right">Expensed</TableHead>
                  <TableHead className="w-12 text-right sr-only">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r) => (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer hover:bg-muted/40"
                    onClick={() => setPeekId(r.id)}
                  >
                    <TableCell className="font-mono text-sm">
                      {r.voucher_number ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.shipment_reference ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {r.voucher_date}
                    </TableCell>
                    <TableCell>
                      <DocumentStatusBadge kind="landed_cost_voucher" status={r.status} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(Number(r.total_amount ?? 0), r.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(Number(r.capitalized_amount ?? 0))}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(Number(r.expensed_amount ?? 0))}
                    </TableCell>
                    <TableCell className="text-right">
                      <LandedCostRowActions
                        voucher={r}
                        onPeek={setPeekId}
                        onChanged={refresh}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </PageBody>

      <LandedCostPeekSheet
        voucherId={peekId}
        onOpenChange={(open) => !open && setPeekId(null)}
        onChanged={refresh}
      />
    </>
  );
}
