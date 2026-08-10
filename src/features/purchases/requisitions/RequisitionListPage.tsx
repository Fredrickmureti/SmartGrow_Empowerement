/**
 * RequisitionListPage — P3 Requisitions Workbench entry.
 *
 * Reads `purchase_requisitions` scoped to the active org/business.
 * State transitions happen from the record page via lifecycle RPCs.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Search } from "lucide-react";

import {
  PageBody,
  PageHeader,
  ActionBar,
  StatusBadge,
  FilterBar,
  LoadingState,
  ErrorState,
  EmptyState,
} from "@/design-system";
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
import { useRequisitions } from "./useRequisitions";

const STATUS_TONE: Record<
  string,
  "neutral" | "info" | "success" | "warning" | "danger"
> = {
  draft: "neutral",
  submitted: "info",
  approved: "success",
  sourcing: "info",
  partially_procured: "warning",
  procured: "info",
  ordered: "info",
  partially_fulfilled: "warning",
  fulfilled: "success",
  rejected: "danger",
  cancelled: "warning",
  closed: "neutral",
};

const PRIORITY_TONE: Record<string, "neutral" | "info" | "warning" | "danger"> = {
  low: "neutral",
  normal: "info",
  high: "warning",
  urgent: "danger",
};

function fmt(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function money(n: number | null | undefined, cur?: string | null) {
  if (n == null) return "—";
  return `${cur ?? ""} ${Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`.trim();
}

/**
 * Operational buckets. A requisition workbench is a work queue, not a status
 * dump: buyers ask "what needs approving / sourcing / chasing", never "show
 * me rows whose status column equals `partially_procured`". Each bucket maps
 * to the server-owned status vocabulary plus outstanding demand, so the UI
 * never invents a state the database cannot justify.
 */
type BucketId =
  | "action"
  | "drafts"
  | "approval"
  | "sourcing"
  | "on_order"
  | "overdue"
  | "settled"
  | "all";

const TERMINAL = ["fulfilled", "cancelled", "rejected", "closed"];

function isOverdue(r: RequisitionRow, today: string) {
  return (
    !TERMINAL.includes(r.status) &&
    !!r.need_by_date &&
    r.need_by_date < today &&
    (r.outstanding_quantity ?? 0) > 0
  );
}

const BUCKETS: {
  id: BucketId;
  label: string;
  hint: string;
  match: (r: RequisitionRow, today: string) => boolean;
}[] = [
  {
    id: "action",
    label: "Needs action",
    hint: "Awaiting approval, or approved with demand nobody has sourced yet.",
    match: (r) =>
      r.status === "submitted" ||
      (r.status === "approved" && (r.outstanding_quantity ?? 0) > 0),
  },
  { id: "drafts", label: "Drafts", hint: "Not submitted yet.", match: (r) => r.status === "draft" },
  {
    id: "approval",
    label: "Awaiting approval",
    hint: "Routed to the approvals inbox.",
    match: (r) => r.status === "submitted",
  },
  {
    id: "sourcing",
    label: "In sourcing",
    hint: "Approved demand being converted into RFQs and purchase orders.",
    match: (r) => ["approved", "sourcing", "partially_procured"].includes(r.status),
  },
  {
    id: "on_order",
    label: "On order",
    hint: "Fully or partly on a purchase order, awaiting receipt.",
    match: (r) => ["procured", "ordered", "partially_fulfilled"].includes(r.status),
  },
  {
    id: "overdue",
    label: "Overdue",
    hint: "Past the need-by date with demand still outstanding.",
    match: isOverdue,
  },
  {
    id: "settled",
    label: "Settled",
    hint: "Fulfilled, short-closed, cancelled or rejected.",
    match: (r) => TERMINAL.includes(r.status),
  },
  { id: "all", label: "All", hint: "Every requisition in this business.", match: () => true },
];

export default function RequisitionListPage() {
  const navigate = useNavigate();
  const { rows, loading, error, refresh } = useRequisitions();
  const [q, setQ] = useState("");
  const [bucket, setBucket] = useState<BucketId>("action");

  const today = new Date().toISOString().slice(0, 10);

  const counts = useMemo(() => {
    const map = {} as Record<BucketId, number>;
    for (const b of BUCKETS) map[b.id] = rows.filter((r) => b.match(r, today)).length;
    return map;
  }, [rows, today]);

  const active = BUCKETS.find((b) => b.id === bucket) ?? BUCKETS[0];

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (!active.match(r, today)) return false;
      if (!needle) return true;
      return (
        r.requisition_number?.toLowerCase().includes(needle) ||
        r.cost_center?.toLowerCase().includes(needle) ||
        r.requester?.full_name?.toLowerCase().includes(needle) ||
        r.requester?.email?.toLowerCase().includes(needle)
      );
    });
  }, [rows, q, active, today]);


  return (
    <>
      <PageHeader
        eyebrow="Purchases"
        title="Requisitions"
        description="Internal purchase requests that flow through approval routing before becoming purchase orders."
        actions={
          <ActionBar>
            <Button variant="outline" size="sm" onClick={refresh}>
              Refresh
            </Button>
            <Button size="sm" onClick={() => navigate("/purchases/requisitions/new")}>
              <Plus className="mr-2 h-4 w-4" /> New requisition
            </Button>
          </ActionBar>
        }
      />
      <PageBody>
        {/* Bucket rail — the buyer's work queue, counts included. */}
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
                {counts[b.id] ?? 0}
              </span>
            </button>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">{active.hint}</p>

        <FilterBar>
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search PR#, cost centre, requester…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-8"
            />
          </div>
        </FilterBar>


        {loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState title="Failed to load requisitions" description={error} />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={rows.length === 0 ? "No requisitions yet" : "No matches"}
            description={
              rows.length === 0
                ? "Create a requisition to route a purchase need through approval."
                : "Adjust the filters to see more results."
            }
            action={
              rows.length === 0 ? (
                <Button size="sm" onClick={() => navigate("/purchases/requisitions/new")}>
                  <Plus className="mr-2 h-4 w-4" /> New requisition
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Requester</TableHead>
                  <TableHead>Cost centre</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Need by</TableHead>
                  <TableHead className="text-right">Lines</TableHead>
                  <TableHead className="text-right">Open lines</TableHead>
                  <TableHead className="text-right">Outstanding qty</TableHead>
                  <TableHead className="text-right">Estimated</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {filtered.map((r) => (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer hover:bg-muted/40"
                    onClick={() => navigate(`/purchases/requisitions/${r.id}`)}
                  >
                    <TableCell className="font-mono text-sm">
                      {r.requisition_number}
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.requester?.full_name ?? r.requester?.email ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {r.cost_center ?? "—"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={PRIORITY_TONE[r.priority] ?? "neutral"}>
                        {fmt(r.priority)}
                      </StatusBadge>
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={STATUS_TONE[r.status] ?? "neutral"}>
                        {fmt(r.status)}
                      </StatusBadge>
                    </TableCell>
                    <TableCell
                      className={
                        "text-sm " +
                        (isOverdue(r, today)
                          ? "font-medium text-destructive"
                          : "text-muted-foreground")
                      }
                    >
                      {r.need_by_date ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-sm">{r.item_count ?? 0}</TableCell>
                    <TableCell className="text-right text-sm">{r.open_line_count ?? 0}</TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {r.outstanding_quantity ?? 0}
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      {money(r.estimated_total, r.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </PageBody>
    </>
  );
}
