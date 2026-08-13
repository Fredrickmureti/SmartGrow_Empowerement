/**
 * ContractListPage — P2 Contracts Workbench entry.
 *
 * Answer-first workspace: a KPI ribbon bound to real lifecycle states
 * (active, awaiting governance, expiring 30/60/90, near-exhausted,
 * off-contract leakage) above the register. Every KPI is a lens on the
 * same canonical rows — no second source of truth, no client-side spend
 * arithmetic beyond display of ledger-derived rollups.
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
  KpiRibbon,
  KpiTile,
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
import {
  useContracts,
  useContractLeakage,
  portfolioKpis,
  matchesLens,
  daysToExpiry,
  exhaustionPercent,
  type ContractLifecycleLens,
} from "./useContracts";

const STATUS_TONE: Record<
  string,
  "neutral" | "info" | "success" | "warning" | "danger"
> = {
  draft: "neutral",
  pending_approval: "info",
  active: "success",
  expired: "warning",
  terminated: "danger",
  suspended: "danger",
};

function fmtStatus(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function money(n: number | null | undefined, cur?: string | null) {
  if (n == null) return "—";
  return `${cur ?? ""} ${Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`.trim();
}

function compactMoney(n: number) {
  return Number(n).toLocaleString(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  });
}

function utilizationPct(used: number | null | undefined, ceiling: number | null | undefined) {
  const u = Number(used ?? 0);
  const c = Number(ceiling ?? 0);
  if (!c) return null;
  return Math.min(100, (u / c) * 100);
}

/** Expiry state of a live contract, expressed the way a buyer reads it. */
function expiryLabel(row: { end_date: string | null; status: string }) {
  const days = daysToExpiry(row);
  if (days == null) return { text: "Open-ended", tone: "neutral" as const };
  if (days < 0) return { text: `Lapsed ${Math.abs(days)}d ago`, tone: "danger" as const };
  if (days <= 30) return { text: `${days}d left`, tone: "danger" as const };
  if (days <= 90) return { text: `${days}d left`, tone: "warning" as const };
  return { text: `${days}d left`, tone: "neutral" as const };
}

const LENS_LABEL: Record<ContractLifecycleLens, string> = {
  all: "All contracts",
  active: "Active",
  pending_approval: "Awaiting approval",
  expiring_30: "Expiring in 30 days",
  expiring_60: "Expiring in 60 days",
  expiring_90: "Expiring in 90 days",
  exhausted: "90%+ exhausted",
  expired: "Expired",
};

export default function ContractListPage() {
  const navigate = useNavigate();
  const { rows, loading, error, refresh } = useContracts();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [lens, setLens] = useState<ContractLifecycleLens>("all");
  const [supplier, setSupplier] = useState<string>("all");

  const kpis = useMemo(() => portfolioKpis(rows), [rows]);

  const contractedSupplierIds = useMemo(
    () =>
      Array.from(
        new Set(
          rows
            .filter((r) => r.status === "active")
            .map((r) => r.supplier_id)
            .filter(Boolean),
        ),
      ),
    [rows],
  );
  const { leakage } = useContractLeakage(contractedSupplierIds);

  const suppliers = useMemo(() => {
    const map = new Map<string, string>();
    rows.forEach((r) => {
      if (r.supplier_id) {
        map.set(r.supplier_id, r.supplier?.contact?.name ?? r.supplier?.supplier_code ?? "Unnamed supplier");
      }
    });
    return Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [rows]);

  const currency = rows.find((r) => r.currency)?.currency ?? "";

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (status !== "all" && r.status !== status) return false;
      if (supplier !== "all" && r.supplier_id !== supplier) return false;
      if (!matchesLens(r, lens)) return false;
      if (!needle) return true;
      return (
        r.contract_number?.toLowerCase().includes(needle) ||
        r.title?.toLowerCase().includes(needle) ||
        r.supplier?.contact?.name?.toLowerCase().includes(needle)
      );
    });
  }, [rows, q, status, supplier, lens]);


  return (
    <>
      <PageHeader
        eyebrow="Purchases"
        title="Contracts"
        description="Master agreements, blankets, and framework contracts governing PO issuance."
        actions={
          <ActionBar>
            <Button variant="outline" size="sm" onClick={refresh}>
              Refresh
            </Button>
            <Button size="sm" onClick={() => navigate("/purchases/contracts/new")}>
              <Plus className="mr-2 h-4 w-4" /> New contract
            </Button>
          </ActionBar>
        }
      />
      <PageBody>
        <KpiRibbon>
          <KpiTile
            label="Active"
            value={kpis.active}
            hint={
              kpis.ceilingValue
                ? `${compactMoney(kpis.committedValue)} committed of ${compactMoney(kpis.ceilingValue)} ${currency}`
                : "No value ceilings set"
            }
            tone={kpis.active ? "positive" : "neutral"}
            loading={loading}
          />
          <KpiTile
            label="Awaiting approval"
            value={kpis.pendingApproval}
            hint="Routed to the approval engine"
            tone={kpis.pendingApproval ? "info" : "neutral"}
            loading={loading}
          />
          <KpiTile
            label="Expiring ≤ 30d"
            value={kpis.expiring30}
            hint={`${kpis.expiring60} in 60d · ${kpis.expiring90} in 90d`}
            tone={kpis.expiring30 ? "critical" : kpis.expiring90 ? "warning" : "neutral"}
            loading={loading}
          />
          <KpiTile
            label="90%+ exhausted"
            value={kpis.exhausted}
            hint="Committed against the value ceiling"
            tone={kpis.exhausted ? "critical" : "neutral"}
            loading={loading}
          />
          <KpiTile
            label="Off-contract leakage"
            value={compactMoney(leakage.value)}
            unit={currency || undefined}
            hint={`${leakage.orderCount} orders on ${leakage.supplierCount} contracted suppliers, last ${leakage.windowDays}d`}
            tone={leakage.orderCount ? "warning" : "neutral"}
            higherIsBetter={false}
            loading={loading}
          />
        </KpiRibbon>

        <FilterBar>
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search number, title, supplier…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-8"
            />
          </div>
          <select
            value={lens}
            onChange={(e) => setLens(e.target.value as ContractLifecycleLens)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            aria-label="Lifecycle lens"
          >
            {(Object.keys(LENS_LABEL) as ContractLifecycleLens[]).map((k) => (
              <option key={k} value={k}>
                {LENS_LABEL[k]}
              </option>
            ))}
          </select>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            aria-label="Status"
          >
            <option value="all">All statuses</option>
            <option value="draft">Draft</option>
            <option value="pending_approval">Pending approval</option>
            <option value="active">Active</option>
            <option value="expired">Expired</option>
            <option value="terminated">Terminated</option>
            <option value="suspended">Suspended</option>
          </select>
          <select
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            aria-label="Supplier"
          >
            <option value="all">All suppliers</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </FilterBar>


        {loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState title="Failed to load contracts" description={error} />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={rows.length === 0 ? "No contracts yet" : "No matches"}
            description={
              rows.length === 0
                ? "Create a contract to govern PO issuance against a supplier ceiling."
                : "Adjust the filters to see more results."
            }
            action={
              rows.length === 0 ? (
                <Button size="sm" onClick={() => navigate("/purchases/contracts/new")}>
                  <Plus className="mr-2 h-4 w-4" /> New contract
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
                  <TableHead>Title</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Utilization</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r) => {
                  const pct = utilizationPct(r.committed_value, r.ceiling_value);
                  return (
                    <TableRow
                      key={r.id}
                      className="cursor-pointer hover:bg-muted/40"
                      onClick={() => navigate(`/purchases/contracts/${r.id}`)}
                    >
                      <TableCell className="font-mono text-sm">
                        {r.contract_number}
                      </TableCell>
                      <TableCell className="font-medium">{r.title}</TableCell>
                      <TableCell>
                        {r.supplier?.contact?.name ?? "—"}
                        {r.supplier?.supplier_code ? (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {r.supplier.supplier_code}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="capitalize text-sm text-muted-foreground">
                        {r.kind}
                      </TableCell>
                      <TableCell>
                        <StatusBadge tone={STATUS_TONE[r.status] ?? "neutral"}>
                          {fmtStatus(r.status)}
                        </StatusBadge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {r.start_date ?? "—"} → {r.end_date ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="text-sm">
                          {money(r.committed_value, r.currency)}
                          <span className="text-muted-foreground"> / </span>
                          {money(r.ceiling_value, r.currency)}
                        </div>
                        {pct != null && (
                          <div className="mt-1 h-1.5 w-32 ml-auto rounded-full bg-muted overflow-hidden">
                            <div
                              className={`h-full ${
                                pct >= 90
                                  ? "bg-destructive"
                                  : pct >= 70
                                    ? "bg-warning"
                                    : "bg-primary"
                              }`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </PageBody>
    </>
  );
}
