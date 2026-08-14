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
  useValuationDrift,
  useValuationWriterCoverage,
  useSerialPositionDrift,
  type StockQuantDriftRow,
  type ValuationDriftRow,
  type SerialPositionDriftRow,
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
import { CheckCircle2, AlertTriangle, Scale, Undo2, Coins, ShieldCheck, Fingerprint } from "lucide-react";

const VALUATION_SCOPE_LABEL: Record<ValuationDriftRow["scope"], string> = {
  warehouse_avco_vs_layers: "Warehouse AVCO vs layers",
  product_avco_vs_layers: "Product AVCO vs layers",
};

const SCOPE_LABEL: Record<StockQuantDriftRow["scope"], string> = {
  warehouse_stock: "Warehouse rollup",
  warehouse_stock_lots: "Per-lot balance",
  "products.stock_quantity": "Product cache",
};

const SERIAL_SCOPE_LABEL: Record<SerialPositionDriftRow["scope"], string> = {
  status_vs_position: "State vs history",
  warehouse_mismatch: "Warehouse mismatch",
  orphan_serial: "No movements",
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
  const valuation = useValuationDrift(businessId);
  const valuationCoverage = useValuationWriterCoverage(Boolean(currentOrg?.id));
  const serialDrift = useSerialPositionDrift(businessId);

  const driftRows = drift.data ?? [];
  const coverageRows = coverage.data ?? [];
  const valuationRows = valuation.data ?? [];
  const valuationCoverageRows = valuationCoverage.data ?? [];
  const serialDriftRows = serialDrift.data ?? [];
  const isClean =
    !drift.isLoading &&
    !coverage.isLoading &&
    !valuation.isLoading &&
    !valuationCoverage.isLoading &&
    driftRows.length === 0 &&
    coverageRows.length === 0 &&
    valuationRows.length === 0 &&
    !serialDrift.isLoading &&
    valuationCoverageRows.length === 0 &&
    serialDriftRows.length === 0;

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
              await Promise.all([
                drift.refetch(),
                coverage.refetch(),
                valuation.refetch(),
                valuationCoverage.refetch(),
                serialDrift.refetch(),
              ]);
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Coins className="h-4 w-4" aria-hidden />
            Valuation agreement
            {!valuation.isLoading && valuationRows.length > 0 && (
              <Badge variant="destructive">{valuationRows.length}</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Compares average-cost valuation on warehouse stock and products against the
            remaining cost-layer roll-up.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {valuation.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !businessId ? (
            <p className="text-sm text-muted-foreground">
              Select a company to run the valuation check.
            </p>
          ) : valuationRows.length === 0 ? (
            <CleanState message="Average-cost valuation matches the cost-layer roll-up." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Comparison</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Unit cost</TableHead>
                  <TableHead className="text-right">AVCO value</TableHead>
                  <TableHead className="text-right">Layer value</TableHead>
                  <TableHead className="text-right">Drift</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {valuationRows.map((row, i) => (
                  <TableRow key={`${row.scope}-${row.product_id}-${row.warehouse_id ?? ""}-${i}`}>
                    <TableCell>{VALUATION_SCOPE_LABEL[row.scope] ?? row.scope}</TableCell>
                    <TableCell className="font-mono text-xs">{row.product_id}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.avco_qty}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.avco_unit_cost}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.avco_value}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.layer_value}</TableCell>
                    <TableCell className="text-right tabular-nums text-destructive">
                      {row.value_drift}
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
            <ShieldCheck className="h-4 w-4" aria-hidden />
            Costing write authority
            {!valuationCoverage.isLoading && valuationCoverageRows.length > 0 && (
              <Badge variant="destructive">{valuationCoverageRows.length}</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Only registered costing routines may change average cost or cost layers —
            there is one valuation engine, not several.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {valuationCoverage.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : valuationCoverageRows.length === 0 ? (
            <CleanState message="No unregistered costing logic found." />
          ) : (
            <ul className="space-y-2">
              {valuationCoverageRows.map((row) => (
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Fingerprint className="h-4 w-4" aria-hidden />
            Serial position
            {!serialDrift.isLoading && serialDriftRows.length > 0 && (
              <Badge variant="destructive">{serialDriftRows.length}</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Each serial's recorded state and warehouse must agree with its movement
            history.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {serialDrift.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !businessId ? (
            <p className="text-sm text-muted-foreground">
              Select a company to run the serial check.
            </p>
          ) : serialDriftRows.length === 0 ? (
            <CleanState message="Every serial agrees with the movement ledger." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Check</TableHead>
                  <TableHead>Serial</TableHead>
                  <TableHead>Recorded state</TableHead>
                  <TableHead className="text-right">Net movements</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {serialDriftRows.map((row) => (
                  <TableRow key={`${row.scope}-${row.serial_id}`}>
                    <TableCell>{SERIAL_SCOPE_LABEL[row.scope] ?? row.scope}</TableCell>
                    <TableCell className="font-mono text-xs">{row.serial_number}</TableCell>
                    <TableCell>{row.recorded_status}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.net_quantity}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{row.detail}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>

  );
}
