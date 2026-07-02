/**
 * Shift integrity reconciliation card (MC-2 of POS audit).
 *
 * Surfaces shifts where the running `pos_shifts.total_sales` counter has
 * drifted away from the authoritative `SUM(pos_transactions.total)`. A
 * non-zero delta is a red flag for trigger drift, manual edits, or replay
 * issues — investigate before posting GL.
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useShiftIntegrity } from "@/hooks/pos/useShiftIntegrity";
import { useCurrency } from "@/hooks/useCurrency";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { format } from "date-fns";

interface ShiftIntegrityCardProps {
  dateFrom: string;
  dateTo: string;
  branchId?: string;
}

export function ShiftIntegrityCard({ dateFrom, dateTo, branchId }: ShiftIntegrityCardProps) {
  const { data: rows = [], isLoading } = useShiftIntegrity({ dateFrom, dateTo, branchId });
  const { formatCurrency } = useCurrency();

  // A 1-cent tolerance absorbs floating-point noise without hiding real drift.
  const drifted = rows.filter((r) => Math.abs(r.delta) > 0.01);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              Shift Integrity
              {!isLoading && drifted.length === 0 && rows.length > 0 && (
                <CheckCircle2 className="h-4 w-4 text-success" />
              )}
              {drifted.length > 0 && <AlertTriangle className="h-4 w-4 text-destructive" />}
            </CardTitle>
            <CardDescription>
              Reconciles each shift's running total against summed completed transactions.
              Non-zero deltas indicate trigger drift or manual edits.
            </CardDescription>
          </div>
          {drifted.length > 0 && (
            <Badge variant="destructive">{drifted.length} drifted</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No shifts in the selected period.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Shift</TableHead>
                <TableHead>Register</TableHead>
                <TableHead>Opened</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Txns</TableHead>
                <TableHead className="text-right">Recorded</TableHead>
                <TableHead className="text-right">Computed</TableHead>
                <TableHead className="text-right">Delta</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const isDrifted = Math.abs(r.delta) > 0.01;
                return (
                  <TableRow key={r.shift_id} className={isDrifted ? "bg-destructive/5" : undefined}>
                    <TableCell className="font-mono text-xs">{r.shift_number}</TableCell>
                    <TableCell>{r.register_name ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {format(new Date(r.opened_at), "MMM d, HH:mm")}
                    </TableCell>
                    <TableCell>
                      <Badge variant={r.status === "open" ? "default" : "secondary"} className="text-xs">
                        {r.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">{r.transaction_count}</TableCell>
                    <TableCell className="text-right font-mono">{formatCurrency(r.recorded_total)}</TableCell>
                    <TableCell className="text-right font-mono">{formatCurrency(r.computed_total)}</TableCell>
                    <TableCell
                      className={`text-right font-mono font-medium ${
                        isDrifted ? "text-destructive" : "text-muted-foreground"
                      }`}
                    >
                      {formatCurrency(r.delta)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
