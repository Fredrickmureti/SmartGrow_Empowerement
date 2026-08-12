/**
 * SupplierListPage — Supplier 360 workbench entry point.
 *
 * Replaces the CRUD "Vendors = filtered contacts" surface for the
 * Purchases module. Reads canonical `suppliers` rows (backfilled from
 * vendor-typed contacts by P1). The legacy vendors route remains until
 * P11 workbench-cutover.
 */
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, Search, ShieldCheck, ShieldAlert, Star } from "lucide-react";

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
import { useSuppliers } from "./useSuppliers";

const STATE_TONE: Record<
  string,
  "neutral" | "info" | "success" | "warning" | "danger"
> = {
  draft: "neutral",
  qualifying: "info",
  approved: "success",
  suspended: "warning",
  blocked: "danger",
  archived: "neutral",
};

function fmtState(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function SupplierListPage() {
  const navigate = useNavigate();
  const { rows, loading, error, refresh } = useSuppliers();
  const [q, setQ] = useState("");
  const [state, setState] = useState<string>("all");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (state !== "all" && r.lifecycle_state !== state) return false;
      if (!needle) return true;
      return (
        r.contact?.name?.toLowerCase().includes(needle) ||
        r.supplier_code?.toLowerCase().includes(needle) ||
        r.contact?.email?.toLowerCase().includes(needle)
      );
    });
  }, [rows, q, state]);

  return (
    <>
      <PageHeader
        eyebrow="Purchases"
        title="Suppliers"
        description="Qualified supplier master — the source of truth for procurement."
        actions={
          <ActionBar>
            <Button variant="outline" size="sm" onClick={refresh}>
              Refresh
            </Button>
            <Button size="sm" onClick={() => navigate("/purchases/suppliers/new")}>
              <Plus className="mr-2 h-4 w-4" /> New supplier
            </Button>
          </ActionBar>
        }
      />
      <PageBody>
        <FilterBar>
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search name, code, email…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-8"
            />
          </div>
          <select
            value={state}
            onChange={(e) => setState(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="all">All lifecycle states</option>
            <option value="draft">Draft</option>
            <option value="qualifying">Qualifying</option>
            <option value="approved">Approved</option>
            <option value="suspended">Suspended</option>
            <option value="blocked">Blocked</option>
            <option value="archived">Archived</option>
          </select>
        </FilterBar>

        {loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState title="Failed to load suppliers" description={error} />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={rows.length === 0 ? "No suppliers yet" : "No matches"}
            description={
              rows.length === 0
                ? "Create your first supplier to start the qualification workflow."
                : "Adjust the filters to see more results."
            }
            action={
              rows.length === 0 ? (
                <Button size="sm" onClick={() => navigate("/purchases/suppliers/new")}>
                  <Plus className="mr-2 h-4 w-4" /> New supplier
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Lifecycle</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                  <TableHead>Qualification expires</TableHead>
                  <TableHead className="text-right">Preferred</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r) => (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/purchases/suppliers/${r.id}`)}
                  >
                    <TableCell className="font-medium">
                      <Link
                        to={`/purchases/suppliers/${r.id}`}
                        className="hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {r.contact?.name ?? "—"}
                      </Link>
                      {r.contact?.email && (
                        <div className="text-xs text-muted-foreground">
                          {r.contact.email}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {r.supplier_code ?? "—"}
                    </TableCell>
                    <TableCell>{r.category?.name ?? "—"}</TableCell>
                    <TableCell>
                      <StatusBadge tone={STATE_TONE[r.lifecycle_state] ?? "neutral"}>
                        {fmtState(r.lifecycle_state)}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.qualification_score != null
                        ? Number(r.qualification_score).toFixed(1)
                        : "—"}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {r.qualification_expires_at
                        ? new Date(r.qualification_expires_at).toLocaleDateString()
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.is_preferred ? (
                        <span className="inline-flex items-center gap-1 text-amber-500">
                          <Star className="h-4 w-4 fill-current" />
                          #{r.preferred_rank ?? "?"}
                        </span>
                      ) : r.lifecycle_state === "suspended" ||
                        r.lifecycle_state === "blocked" ? (
                        <ShieldAlert className="ml-auto h-4 w-4 text-destructive" />
                      ) : r.lifecycle_state === "approved" ? (
                        <ShieldCheck className="ml-auto h-4 w-4 text-muted-foreground" />
                      ) : (
                        "—"
                      )}
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
