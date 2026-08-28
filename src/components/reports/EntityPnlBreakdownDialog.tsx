/**
 * What sits behind one company's Income / Expenses figure — in place.
 *
 * The Cross-Company Comparative View shows one P&L line per legal entity. Those
 * figures are group-free but entity-scoped aggregations, so the lineage a
 * reviewer needs is: company figure → the accounts that make it up → the ledger
 * lines on an account → the source document. This dialog is the middle step; the
 * last two are the existing `DrillDownDialog` + `TransactionPreviewDrawer`
 * stack, so nothing is cloned and the reviewer never leaves the report.
 *
 * SINGLE SOURCE OF TRUTH
 * ----------------------
 * Rows come from `get_general_ledger` for the clicked entity and period — the
 * same posted-ledger RPC the General Ledger report and the drill-down use. The
 * only client work is regrouping the server's lines by account for display; no
 * balance is recomputed and no classification is invented (the account type
 * comes from the server row).
 *
 * The entity is passed explicitly: a comparative view deliberately shows
 * companies other than the one in the workspace switcher, so an ambient scope
 * would drill into the wrong books.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, Info } from "lucide-react";
import { DrillDownDialog, type DrillDownConfig } from "@/components/reports/DrillDownDialog";

/** Which side of the P&L the reviewer clicked. */
export type PnlSection = "income" | "expense" | "net";

export interface EntityPnlTarget {
  businessId: string;
  businessName: string;
  currency: string;
  section: PnlSection;
  dateFrom: string;
  dateTo: string;
}

interface EntityPnlBreakdownDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: EntityPnlTarget | null;
}

interface AccountLine {
  accountId: string;
  code: string;
  name: string;
  type: string;
  debit: number;
  credit: number;
  /** Net movement in the account's normal-balance direction. */
  net: number;
}

const SECTION_LABELS: Record<PnlSection, string> = {
  income: "Income",
  expense: "Expenses",
  net: "Net income",
};

function isIncome(type: string) {
  return type === "income" || type === "revenue";
}
function isExpense(type: string) {
  return type === "expense" || type === "cost_of_goods_sold" || type === "cogs";
}

function formatAmount(value: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

export function EntityPnlBreakdownDialog({
  open,
  onOpenChange,
  target,
}: EntityPnlBreakdownDialogProps) {
  const { currentOrg } = useOrganization();
  const [drillConfig, setDrillConfig] = useState<DrillDownConfig | null>(null);

  const query = useQuery({
    queryKey: [
      "entity-pnl-breakdown",
      currentOrg?.id,
      target?.businessId,
      target?.dateFrom,
      target?.dateTo,
    ],
    enabled: open && !!currentOrg?.id && !!target?.businessId,
    queryFn: async (): Promise<AccountLine[]> => {
      const { data, error } = await supabase.rpc("get_general_ledger", {
        _org_id: currentOrg!.id,
        _date_from: target!.dateFrom,
        _date_to: target!.dateTo,
        _business_id: target!.businessId,
        _include_zero_activity: false,
      });
      if (error) throw error;

      const byAccount = new Map<string, AccountLine>();
      for (const row of (data ?? []) as any[]) {
        const type = String(row.account_type ?? "");
        if (!isIncome(type) && !isExpense(type)) continue;
        const existing = byAccount.get(row.account_id) ?? {
          accountId: row.account_id as string,
          code: (row.account_code ?? "—") as string,
          name: (row.account_name ?? "") as string,
          type,
          debit: 0,
          credit: 0,
          net: 0,
        };
        existing.debit += Number(row.debit ?? 0);
        existing.credit += Number(row.credit ?? 0);
        byAccount.set(row.account_id, existing);
      }
      return Array.from(byAccount.values())
        .map((line) => ({
          ...line,
          // Normal-balance direction: income is credit-normal, expenses debit-normal.
          net: isIncome(line.type)
            ? line.credit - line.debit
            : line.debit - line.credit,
        }))
        .sort((a, b) => a.code.localeCompare(b.code));
    },
    staleTime: 15_000,
  });

  const lines = useMemo(() => {
    const all = query.data ?? [];
    if (!target || target.section === "net") return all;
    return all.filter((line) =>
      target.section === "income" ? isIncome(line.type) : isExpense(line.type),
    );
  }, [query.data, target]);

  const currency = target?.currency && target.currency !== "—" ? target.currency : "";
  const total = lines.reduce((sum, line) => sum + line.net, 0);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-base">
              {target ? `${SECTION_LABELS[target.section]} — ${target.businessName}` : "Breakdown"}
            </DialogTitle>
            <DialogDescription>
              {target
                ? `${target.dateFrom} → ${target.dateTo} · posted ledger, ${target.businessName}'s own books and currency`
                : null}
            </DialogDescription>
          </DialogHeader>

          {query.isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Loading accounts…
            </div>
          ) : query.error ? (
            <Alert variant="destructive">
              <AlertDescription>
                {query.error instanceof Error
                  ? query.error.message
                  : "Failed to load the account breakdown."}
              </AlertDescription>
            </Alert>
          ) : lines.length === 0 ? (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                No posted movement on this company's profit &amp; loss accounts for
                the selected period.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="max-h-[55vh] overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Movement</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line) => (
                    <TableRow
                      key={line.accountId}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() =>
                        setDrillConfig({
                          title: `${line.code} ${line.name}`.trim(),
                          accountId: line.accountId,
                          businessId: target!.businessId,
                          businessName: target!.businessName,
                          startDate: target!.dateFrom,
                          endDate: target!.dateTo,
                        })
                      }
                    >
                      <TableCell className="font-medium">{line.code}</TableCell>
                      <TableCell>{line.name}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatAmount(line.net, currency)}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground whitespace-nowrap">
                        Open ledger →
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-muted/40 font-semibold">
                    <TableCell colSpan={2}>
                      {target ? SECTION_LABELS[target.section] : "Total"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatAmount(total, currency)}
                    </TableCell>
                    <TableCell />
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}
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
