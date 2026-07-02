/**
 * Asset Depreciation History — Shows posted depreciation entries for a single asset.
 * Displays period, amount, accumulated depreciation, book value, and journal entry link.
 */
import { useDepreciationSchedule, DepreciationSchedule } from "@/hooks/useDepreciationSchedule";
import { useCurrency } from "@/hooks/useCurrency";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, FileText, CheckCircle2, Clock } from "lucide-react";
import { format } from "date-fns";

interface AssetDepreciationHistoryProps {
  assetId: string;
  assetName: string;
}

export function AssetDepreciationHistory({ assetId, assetName }: AssetDepreciationHistoryProps) {
  const { schedules, isLoading, postedSchedules, pendingSchedules } = useDepreciationSchedule(assetId);
  const { formatCurrency } = useCurrency();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (schedules.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <FileText className="h-10 w-10 mx-auto mb-2 opacity-50" />
        <p className="text-sm">No depreciation entries for this asset.</p>
        <p className="text-xs mt-1">Use "Run Depreciation" to generate and post monthly entries.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Depreciation History — {assetName}</p>
        <div className="flex gap-2">
          <Badge variant="outline" className="text-xs">
            <CheckCircle2 className="h-3 w-3 mr-1" /> {postedSchedules.length} posted
          </Badge>
          {pendingSchedules.length > 0 && (
            <Badge variant="secondary" className="text-xs">
              <Clock className="h-3 w-3 mr-1" /> {pendingSchedules.length} pending
            </Badge>
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Period</TableHead>
              <TableHead className="text-right">Depreciation</TableHead>
              <TableHead className="text-right">Accumulated</TableHead>
              <TableHead className="text-right">Book Value</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden sm:table-cell">Posted At</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {schedules.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="text-sm font-medium">
                  {format(new Date(entry.period_start), "MMM yyyy")}
                </TableCell>
                <TableCell className="text-right text-sm">
                  {formatCurrency(entry.depreciation_amount)}
                </TableCell>
                <TableCell className="text-right text-sm">
                  {formatCurrency(entry.accumulated_depreciation)}
                </TableCell>
                <TableCell className="text-right text-sm font-medium">
                  {formatCurrency(entry.book_value)}
                </TableCell>
                <TableCell>
                  {entry.is_posted ? (
                    <Badge className="bg-primary/10 text-primary text-xs">Posted</Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs">Pending</Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground hidden sm:table-cell">
                  {entry.posted_at ? format(new Date(entry.posted_at), "MMM d, yyyy") : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
