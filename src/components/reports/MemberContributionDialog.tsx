/**
 * Member contributions behind a consolidated statement line — in place.
 *
 * WHY THIS EXISTS
 * ---------------
 * A consolidated figure is an aggregation of several member companies' own
 * accounts. Before this dialog, clicking such a figure *navigated away* to the
 * consolidated trial balance: the reviewer lost the statement they were
 * reading, the period they had set, and had to find the line again. That is the
 * wrong affordance for lineage. Drill-down is preview → drawer → full record,
 * in place; route links remain only as an explicit deep-link escape hatch.
 *
 * SINGLE SOURCE OF TRUTH
 * ----------------------
 * The contributions come from `get_consolidated_trial_balance_translated` — the
 * very rows the Consolidated Trial Balance page renders — filtered to the group
 * account that was clicked. No arithmetic is performed here beyond adding up
 * the server's own translated figures for display of the line total, which is
 * the same regrouping the trial balance page does.
 *
 * AUTHORIZATION
 * -------------
 * Seeing a company's *contribution* to a group figure is not the same right as
 * reading that company's ledger. A member the viewer has no company grant for
 * is listed (the group figure would otherwise be unexplained) but is NOT
 * clickable, and says why. The rail is cosmetic: every query behind the drill
 * is still filtered by RLS on the server.
 */

import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, ExternalLink, Info } from "lucide-react";
import { Link } from "react-router-dom";
import {
  useConsolidatedTrialBalance,
  type ConsolidatedTrialBalanceRow,
} from "@/hooks/finance/useConsolidatedTrialBalance";
import { useMemberLedgerAccess } from "@/hooks/finance/useMemberLedgerAccess";
import { DrillDownDialog, type DrillDownConfig } from "@/components/reports/DrillDownDialog";

export interface MemberContributionTarget {
  /** Consolidation group the figure belongs to. */
  groupId: string;
  /** The GROUP account behind the clicked figure. */
  groupAccountId: string;
  /** Human label for the dialog header, e.g. "4000 Revenue". */
  label: string;
  dateFrom: string;
  dateTo: string;
}

interface MemberContributionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: MemberContributionTarget | null;
}

function formatAmount(value: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

export function MemberContributionDialog({
  open,
  onOpenChange,
  target,
}: MemberContributionDialogProps) {
  const { canOpen } = useMemberLedgerAccess();
  const [drillConfig, setDrillConfig] = useState<DrillDownConfig | null>(null);

  const query = useConsolidatedTrialBalance(
    open && target ? target.groupId : null,
    open && target ? target.dateFrom : null,
    open && target ? target.dateTo : null,
  );

  const contributions = useMemo<ConsolidatedTrialBalanceRow[]>(() => {
    if (!target) return [];
    return (query.data ?? []).filter((row) => {
      // A mapped member account reports under its group account; an unmapped one
      // reports under its own, and the statement line then carries that id.
      const key = row.group_account_id ?? row.account_id;
      return key === target.groupAccountId;
    });
  }, [query.data, target]);

  const currency = contributions[0]?.presentation_currency ?? "";
  const lineTotal = contributions.reduce(
    (sum, row) => sum + Number(row.translated_closing ?? 0),
    0,
  );

  const deepLinkHref = target
    ? `/finance/reports/consolidated-trial-balance?${new URLSearchParams({
        consolidationGroup: target.groupId,
        date_from: target.dateFrom,
        date_to: target.dateTo,
        group_account_id: target.groupAccountId,
      }).toString()}`
    : null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-base">
              {target?.label ?? "Group account"} — companies behind this figure
            </DialogTitle>
            <DialogDescription>
              {target
                ? `${target.dateFrom} → ${target.dateTo} · figures restated into the group's presentation currency`
                : null}
            </DialogDescription>
          </DialogHeader>

          {query.isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Loading member contributions…
            </div>
          ) : query.error ? (
            <Alert variant="destructive">
              <AlertDescription>
                {query.error instanceof Error
                  ? query.error.message
                  : "Failed to load member contributions."}
              </AlertDescription>
            </Alert>
          ) : contributions.length === 0 ? (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                No member company balances sit behind this line for the selected
                period. Group-owned figures — translation reserve, non-controlling
                interests and computed subtotals — have no member ledger to open.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="max-h-[55vh] overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Company</TableHead>
                    <TableHead>Member account</TableHead>
                    <TableHead className="text-right">Own currency</TableHead>
                    <TableHead className="text-right">Group currency</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {contributions.map((row) => {
                    const openable = canOpen(row.business_id) && !!row.account_id;
                    const own = row.base_currency ?? row.presentation_currency;
                    return (
                      <TableRow
                        key={`${row.business_id}:${row.account_id}`}
                        className={openable ? "cursor-pointer hover:bg-muted/50" : undefined}
                        onClick={
                          openable
                            ? () =>
                                setDrillConfig({
                                  title: `${row.account_code ?? ""} ${row.account_name}`.trim(),
                                  accountId: row.account_id,
                                  businessId: row.business_id,
                                  businessName: row.business_name,
                                  startDate: target!.dateFrom,
                                  endDate: target!.dateTo,
                                })
                            : undefined
                        }
                      >
                        <TableCell className="font-medium">
                          {row.business_name}
                          {row.is_parent ? (
                            <Badge variant="outline" className="ml-2">
                              parent
                            </Badge>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {row.account_code ? `${row.account_code} · ` : ""}
                          {row.account_name}
                          {!row.is_mapped ? " (not mapped to a group account)" : ""}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatAmount(Number(row.closing_balance ?? 0), own)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatAmount(
                            Number(row.translated_closing ?? 0),
                            row.presentation_currency,
                          )}
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground whitespace-nowrap">
                          {openable ? "Open ledger →" : "No access to this company"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  <TableRow className="bg-muted/40 font-semibold">
                    <TableCell colSpan={3}>Aggregated</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatAmount(lineTotal, currency)}
                    </TableCell>
                    <TableCell />
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}

          {deepLinkHref ? (
            <div className="flex justify-end">
              {/* Stable deep link, kept as a secondary affordance only. */}
              <Button variant="outline" size="sm" asChild>
                <Link to={deepLinkHref}>
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Open in Consolidated Trial Balance
                </Link>
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <DrillDownDialog
        open={!!drillConfig}
        onOpenChange={(next) => {
          if (!next) setDrillConfig(null);
        }}
        config={drillConfig}
      />
    </>
  );
}
