/**
 * Inventory integrity report (ADR 0142 Phase 3 item 4).
 *
 * Surfaces the two server-owned integrity checks:
 *   - check_stock_quant_drift            — four-way balance agreement
 *   - check_movement_reversal_coverage   — every stock writer can be undone
 *
 * This page never computes an integrity verdict in the browser; it renders
 * whatever the database reports.
 */
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import {
  useStockQuantDrift,
  useMovementReversalCoverage,
  type StockQuantDriftRow,
} from "@/hooks/inventory/useStockQuants";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { RefreshButton } from "@/components/ui/RefreshButton";
import { CheckCircle2, AlertTriangle, Scale, Undo2 } from "lucide-react";

const SCOPE_LABEL: Record<StockQuantDriftRow["scope"], string> = {
  warehouse_stock: "Warehouse rollup",
  warehouse_stock_lots: "Per-lot balance",
  "products.stock_quantity": "Product cache",
};

function CleanState({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
      <CheckCircle2 className="h-4 w-4 text-primary" aria-hidden />
      {message}
    </div>
  );
}

export default function InventoryIntegrity() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const drift = useStockQuantDrift(businessId);
  const coverage = useMovementReversalCoverage(Boolean(currentOrg?.id));

  const driftRows = drift.data ?? [];
  const coverageRows = coverage.data ?? [];
  const isClean =
    !drift.isLoading &&
    !coverage.isLoading &&
    driftRows.length === 0 &&
    coverageRows.length === 0;

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Inventory integrity</h1>
          <p className="text-sm text-muted-foreground">
            Server-owned checks over the stock ledger. An empty report means the quant
            ledger, its projections, and every reversal path agree.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isClean && (
            <Badge variant="secondary" className="gap-1">
              <CheckCircle2 className="h-3 w-3" aria-hidden /> All checks passing
            </Badge>
          )}
          <RefreshButton
            onRefresh={async () => {
              await Promise.all([drift.refetch(), coverage.refetch()]);
            }}
          />
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Scale className="h-4 w-4" aria-hidden />
            Balance agreement
            {!drift.isLoading && driftRows.length > 0 && (
              <Badge variant="destructive">{driftRows.length}</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Compares the quant ledger against the warehouse rollup, the per-lot balance,
            and the product-level cache.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {drift.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !businessId ? (
            <p className="text-sm text-muted-foreground">
              Select a company to run the balance check.
            </p>
          ) : driftRows.length === 0 ? (
            <CleanState message="All four balance stores agree." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Projection</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Lot</TableHead>
                  <TableHead className="text-right">Quant ledger</TableHead>
                  <TableHead className="text-right">Projected</TableHead>
                  <TableHead className="text-right">Drift</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {driftRows.map((row, i) => (
                  <TableRow key={`${row.scope}-${row.product_id}-${row.lot_number ?? ""}-${i}`}>
                    <TableCell>{SCOPE_LABEL[row.scope] ?? row.scope}</TableCell>
                    <TableCell className="font-mono text-xs">{row.product_id}</TableCell>
                    <TableCell className="font-mono text-xs">{row.lot_number ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.quant_qty}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.projected_qty}</TableCell>
                    <TableCell className="text-right tabular-nums text-destructive">
                      {row.drift}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Undo2 className="h-4 w-4" aria-hidden />
            Reversal coverage
            {!coverage.isLoading && coverageRows.length > 0 && (
              <Badge variant="destructive">{coverageRows.length}</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Every routine that writes stock must have a registered, existing way to undo
            what it wrote.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {coverage.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : coverageRows.length === 0 ? (
            <CleanState message="Every stock writer has a working reversal path." />
          ) : (
            <ul className="space-y-2">
              {coverageRows.map((row) => (
                <li
                  key={`${row.issue}-${row.function_name}`}
                  className="flex items-start gap-2 rounded-md border border-destructive/40 p-3 text-sm"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" aria-hidden />
                  <span>
                    <span className="font-mono">{row.function_name}</span> — {row.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
