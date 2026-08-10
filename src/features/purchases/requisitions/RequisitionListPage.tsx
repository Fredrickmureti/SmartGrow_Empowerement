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

export default function RequisitionListPage() {
  const navigate = useNavigate();
  const { rows, loading, error, refresh } = useRequisitions();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (status !== "all" && r.status !== status) return false;
      if (!needle) return true;
      return (
        r.requisition_number?.toLowerCase().includes(needle) ||
        r.cost_center?.toLowerCase().includes(needle) ||
        r.requester?.full_name?.toLowerCase().includes(needle) ||
        r.requester?.email?.toLowerCase().includes(needle)
      );
    });
  }, [rows, q, status]);

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
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="all">All statuses</option>
            <option value="draft">Draft</option>
            <option value="submitted">Submitted</option>
            <option value="approved">Approved</option>
            <option value="sourcing">Sourcing</option>
            <option value="partially_procured">Partially procured</option>
            <option value="procured">Procured</option>
            <option value="ordered">Ordered</option>
            <option value="partially_fulfilled">Partially fulfilled</option>
            <option value="fulfilled">Fulfilled</option>
            <option value="rejected">Rejected</option>
            <option value="cancelled">Cancelled</option>
            <option value="closed">Closed</option>
          </select>
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
                    <TableCell className="text-sm text-muted-foreground">
                      {r.need_by_date ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-sm">{r.item_count ?? 0}</TableCell>
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
