/**
 * Opening-inventory remediation dialog.
 *
 * An enterprise ledger never posts from a single unlabelled button click.
 * This dialog enforces the sequence an auditor expects:
 *
 *   1. DRY RUN on open — the server computes exactly what would be posted
 *      (company, entry date, amount, debit and credit accounts) and returns
 *      it without writing anything.
 *   2. The operator reads the proposed entry and confirms.
 *   3. Only then is the same RPC called with `p_dry_run = false`.
 *
 * Skip reasons (already posted, nothing to post, locked period) are shown
 * as-is and disable the confirm action — the button is never "live" when
 * the server has already said it will not post.
 */
import { useEffect } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useBackfillOpeningInventory } from "@/hooks/finance/useInventoryReconciliation";

const SKIP_COPY: Record<string, string> = {
  opening_already_posted:
    "An opening inventory journal has already been posted for this company. Posting again would double-count inventory, so this action is blocked.",
  no_zero_cost_opening_movements:
    "There are no zero-cost opening stock movements to value. The drift you are seeing comes from something else — check “Difference explained”.",
  no_layer_basis_drift:
    "The cost-layer reconciliation shows no shortfall on the Inventory control account at this date, so there is nothing to bring on. Posting anyway would create new drift.",
  period_locked:
    "The accounting period that would receive this entry is locked. Re-open the period, or choose an as-at date in an open period.",
};

const fmt = (n: number) =>
  new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    n ?? 0,
  );

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asOf?: string;
}

export function OpeningInventoryBackfillDialog({ open, onOpenChange, asOf }: Props) {
  const backfill = useBackfillOpeningInventory();
  const preview = backfill.data?.dry_run ? backfill.data : null;
  const skipped = preview?.skipped ? preview : null;
  const canPost = !!preview && !preview.skipped;

  // Preview on open. Never posts.
  useEffect(() => {
    if (open) {
      backfill.reset();
      backfill.mutate({ asOf, dryRun: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, asOf]);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Post opening inventory journal</AlertDialogTitle>
          <AlertDialogDescription>
            This posts a balanced journal that brings historic stock on hand onto the Inventory
            control account against Opening Balance Equity. Review the proposed entry before
            confirming.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {backfill.isPending && !backfill.data ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Calculating the proposed entry…
          </div>
        ) : backfill.isError ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{(backfill.error as Error).message}</AlertDescription>
          </Alert>
        ) : skipped ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {SKIP_COPY[skipped.reason ?? ""] ?? `Nothing will be posted (${skipped.reason}).`}
            </AlertDescription>
          </Alert>
        ) : preview ? (
          <dl className="rounded-md border divide-y text-sm">
            <div className="flex justify-between gap-4 px-3 py-2">
              <dt className="text-muted-foreground">Entry date</dt>
              <dd className="font-medium">{preview.entry_date}</dd>
            </div>
            <div className="flex justify-between gap-4 px-3 py-2">
              <dt className="text-muted-foreground">Debit — Inventory</dt>
              <dd className="font-medium tabular-nums">{fmt(preview.total_posted ?? 0)}</dd>
            </div>
            <div className="flex justify-between gap-4 px-3 py-2">
              <dt className="text-muted-foreground">Credit — Opening Balance Equity</dt>
              <dd className="font-medium tabular-nums">{fmt(preview.total_posted ?? 0)}</dd>
            </div>
            <div className="flex justify-between gap-4 px-3 py-2">
              <dt className="text-muted-foreground">Drift measured on the cost-layer basis</dt>
              <dd className="font-medium tabular-nums">
                {fmt(preview.layer_basis_drift ?? 0)}
              </dd>
            </div>
            <div className="px-3 py-2 text-xs text-muted-foreground">
              Valued at product cost — these positions have no cost layers to value
              them. The posting is capped at the drift the reconciliation measures.
            </div>
          </dl>
        ) : null}


        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!canPost || backfill.isPending}
            onClick={(e) => {
              e.preventDefault();
              backfill.mutate(
                { asOf, dryRun: false },
                { onSuccess: () => onOpenChange(false) },
              );
            }}
          >
            {backfill.isPending && backfill.variables?.dryRun === false ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : null}
            Post journal
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
