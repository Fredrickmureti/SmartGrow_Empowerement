/**
 * Drill-down beneath the generated eliminations (Brick 7, Step 7.4).
 *
 * Each leg the engine produced can be opened to reveal the evidence the engine
 * itself consumed: the source account in the subsidiary's own books, the rate
 * class and rate applied, and every posted journal entry behind the position —
 * all returned by `consolidation_elimination_evidence`.
 *
 * This component computes nothing. It does not re-add, re-translate or
 * re-round anything; the amounts shown are the server's. Whether a viewer may
 * open another company's ledger is also the server's decision
 * (`viewer_can_open_ledger`); where it says no, the row says so plainly instead
 * of offering a link that would fail.
 *
 * Difference legs have no source entries by construction — they are the
 * residual the policy allowed — so they show the policy in force rather than
 * an empty table.
 */
import { Fragment, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ChevronDown, ChevronRight, ExternalLink, Filter, Loader2, Lock } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { toAppError } from "@/lib/supabaseError";
import { ledgerDrillHref, journalEntryDrillHref } from "@/lib/reports/crossEntityDrill";
import { DrillDownDialog, type DrillDownConfig } from "@/components/reports/DrillDownDialog";
import { TransactionPreviewDrawer } from "@/components/finance/TransactionPreviewDrawer";

import {
  ELIMINATION_CLASS_LABELS,
  ELIMINATION_POLICY_LABELS,
  useEliminationEvidence,
  type EliminationRow,
  type EliminationRule,
  type EliminationLegKey,
} from "@/hooks/finance/useConsolidationEliminations";

function money(value: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
      Number(value),
    );
  } catch {
    return `${currency} ${Number(value).toFixed(2)}`;
  }
}

function legKey(row: EliminationRow): EliminationLegKey {
  return {
    elimination_class: row.elimination_class,
    declaring_business_id: row.declaring_business_id,
    counterparty_business_id: row.counterparty_business_id,
    group_account_id: row.group_account_id,
  };
}

interface Props {
  groupId: string;
  dateFrom: string;
  dateTo: string;
  currency: string;
  eliminations: EliminationRow[];
  rules: EliminationRule[];
  isLoading: boolean;
  /**
   * Arrived here from a consolidated statement line: show only the legs that
   * moved that group account. This is a filter over rows the server already
   * returned — no figure is recomputed or re-summed here.
   */
  focusAccountId?: string | null;
  onClearFocus?: () => void;
}

export function EliminationEvidencePanel({
  groupId,
  dateFrom,
  dateTo,
  currency,
  eliminations,
  rules,
  isLoading,
  focusAccountId = null,
  onClearFocus,
}: Props) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading eliminations…
      </div>
    );
  }

  if (eliminations.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing generated for this period yet. Generating is safe to repeat: a new run
        replaces the period's set rather than adding to it.
      </p>
    );
  }

  const visible = focusAccountId
    ? eliminations.filter((r) => r.group_account_id === focusAccountId)
    : eliminations;
  const focusLabel = focusAccountId
    ? eliminations.find((r) => r.group_account_id === focusAccountId)
    : null;

  return (
    <div className="space-y-2">
      {focusAccountId && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">
            Showing only the legs that moved{" "}
            <span className="font-medium text-foreground">
              {focusLabel
                ? `${focusLabel.group_account_code} · ${focusLabel.group_account_name}`
                : "the selected statement line"}
            </span>
            .
          </span>
          {onClearFocus && (
            <Button variant="link" size="sm" className="h-auto p-0" onClick={onClearFocus}>
              Show all eliminations
            </Button>
          )}
        </div>
      )}
      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No generated elimination touches that account in this period. The Eliminations
          column on that statement line comes from a different account, or the period has
          not been regenerated since the line changed.
        </p>
      ) : (
    <div className="border rounded-md divide-y">
      {visible.map((row) => {
        const isOpen = openId === row.id;
        return (
          <Fragment key={row.id}>
            <button
              type="button"
              onClick={() => setOpenId(isOpen ? null : row.id)}
              aria-expanded={isOpen}
              className="w-full text-left px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 hover:bg-muted/50 transition-colors"
            >
              {isOpen ? (
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <Badge variant={row.is_difference ? "destructive" : "secondary"}>
                {ELIMINATION_CLASS_LABELS[row.elimination_class] ?? row.elimination_class}
              </Badge>
              <span className="text-sm font-medium">
                {row.declaring_business_name} → {row.counterparty_business_name}
              </span>
              <span className="text-sm text-muted-foreground">
                {row.group_account_code} · {row.group_account_name}
              </span>
              <span className="ml-auto text-sm tabular-nums">
                {Number(row.debit) !== 0 && <>Dr {money(row.debit, currency)}</>}
                {Number(row.credit) !== 0 && <> Cr {money(row.credit, currency)}</>}
              </span>
              <span className="text-xs text-muted-foreground w-full pl-7">
                {row.is_difference
                  ? "Unreconciled residual, disclosed under the group's policy"
                  : "Eliminated — open to see the entries behind it"}
              </span>
            </button>
            {isOpen && (
              <div className="px-3 py-3 bg-muted/30">
                {row.is_difference ? (
                  <DifferenceExplanation row={row} rules={rules} currency={currency} />
                ) : (
                  <LegEvidence
                    groupId={groupId}
                    dateFrom={dateFrom}
                    dateTo={dateTo}
                    currency={currency}
                    row={row}
                  />
                )}
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
      )}
    </div>
  );
}

function DifferenceExplanation({
  row,
  rules,
  currency,
}: {
  row: EliminationRow;
  rules: EliminationRule[];
  currency: string;
}) {
  const rule = rules.find((r) => r.elimination_class === row.elimination_class) ?? null;
  return (
    <div className="space-y-2 text-sm">
      <p>
        This leg is not an elimination of a position. It is the amount by which the two
        sides of the declared pair still disagreed after translation, carried to{" "}
        <span className="font-medium">
          {row.group_account_code} · {row.group_account_name}
        </span>{" "}
        so the group's books stay balanced.
      </p>
      {rule ? (
        <p className="text-muted-foreground">
          Policy in force for{" "}
          {ELIMINATION_CLASS_LABELS[row.elimination_class] ?? row.elimination_class}:{" "}
          tolerance {money(Number(rule.tolerance_amount), currency)} ·{" "}
          {ELIMINATION_POLICY_LABELS[rule.difference_policy] ?? rule.difference_policy}
          {rule.is_system_default ? " (still the seeded default)" : ""}.
        </p>
      ) : (
        <p className="text-muted-foreground">
          No saved policy for this class — the engine used its default.
        </p>
      )}
      <p className="text-muted-foreground">
        The positions on both sides are listed under “Positions the run consumed”. The
        residual disappears when the two companies agree, not when it is reclassified.
      </p>
    </div>
  );
}

function LegEvidence({
  groupId,
  dateFrom,
  dateTo,
  currency,
  row,
}: {
  groupId: string;
  dateFrom: string;
  dateTo: string;
  currency: string;
  row: EliminationRow;
}) {
  const navigate = useNavigate();
  /**
   * Inspection happens in place: the entry opens in the canonical
   * `TransactionPreviewDrawer` (which offers "View full record" for the exact
   * source document), and the account opens the entity-scoped
   * `DrillDownDialog` on the declaring company's own books. Navigating away is
   * the secondary affordance only.
   */
  const [preview, setPreview] = useState<{ type: string; id: string } | null>(null);
  const [drillConfig, setDrillConfig] = useState<DrillDownConfig | null>(null);
  const { data, isLoading, error } = useEliminationEvidence(
    groupId,
    dateFrom,
    dateTo,
    legKey(row),
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Reading the entries behind this elimination…
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="text-sm">
          {toAppError(error, "The evidence could not be read").message}
        </AlertDescription>
      </Alert>
    );
  }

  const rows = data ?? [];
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        The server returned no source entries for this leg. That means the position it
        eliminated no longer exists in the period as scoped — regenerate the period before
        relying on this figure.
      </p>
    );
  }

  const blocked = rows.some((r) => !r.viewer_can_open_ledger);

  return (
    <div className="space-y-3">
      {blocked && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Lock className="h-3.5 w-3.5" />
          You can see this company's contribution to the group, but you are not permitted
          to open its ledger, so those links are withheld.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="text-left">
              <th className="py-1 pr-3 font-medium">Entry</th>
              <th className="py-1 pr-3 font-medium">Date</th>
              <th className="py-1 pr-3 font-medium">Its account</th>
              <th className="py-1 pr-3 font-medium text-right">Debit (local)</th>
              <th className="py-1 pr-3 font-medium text-right">Credit (local)</th>
              <th className="py-1 pr-3 font-medium">Rate</th>
              <th className="py-1 pr-3 font-medium text-right">Debit ({currency})</th>
              <th className="py-1 font-medium text-right">Credit ({currency})</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.journal_entry_id}:${r.account_id}`} className="border-t">
                <td className="py-1 pr-3">
                  {r.viewer_can_open_ledger ? (
                    <span className="inline-flex items-center gap-1">
                      {/* Opens the entry in place; the drawer offers "View full
                          record" for the source document itself. */}
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0"
                        onClick={() =>
                          setPreview({ type: "journal_entry", id: r.journal_entry_id })
                        }
                      >
                        {r.entry_number ?? "Journal entry"}
                      </Button>
                      {/* Secondary: the stable deep link to the entry in that
                          company's books, built by `crossEntityDrill`. */}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5"
                        aria-label="Open journal entry in its own company"
                        onClick={() =>
                          navigate(
                            journalEntryDrillHref(
                              r.journal_entry_id,
                              r.declaring_business_id,
                            ),
                          )
                        }
                      >
                        <ExternalLink className="h-3 w-3" />
                      </Button>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      {r.entry_number ?? "Journal entry"}
                    </span>
                  )}
                  {r.entry_description && (
                    <div className="text-xs text-muted-foreground">
                      {r.entry_description}
                    </div>
                  )}
                </td>
                <td className="py-1 pr-3 whitespace-nowrap">
                  {format(new Date(r.entry_date), "MMM d, yyyy")}
                </td>
                <td className="py-1 pr-3">
                  {r.viewer_can_open_ledger ? (
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-left"
                      onClick={() =>
                        setDrillConfig({
                          title: `${r.account_code} · ${r.account_name} — ${r.declaring_business_name ?? row.declaring_business_name}`,
                          accountId: r.account_id,
                          businessId: r.declaring_business_id,
                          businessName:
                            r.declaring_business_name ?? row.declaring_business_name,
                          startDate: dateFrom,
                          endDate: dateTo,
                        })
                      }
                    >
                      {r.account_code} · {r.account_name}
                    </Button>
                  ) : (
                    <span>
                      {r.account_code} · {r.account_name}
                    </span>
                  )}
                </td>

                <td className="py-1 pr-3 text-right tabular-nums">
                  {Number(r.debit_base).toFixed(2)}
                </td>
                <td className="py-1 pr-3 text-right tabular-nums">
                  {Number(r.credit_base).toFixed(2)}
                </td>
                <td className="py-1 pr-3 whitespace-nowrap text-xs text-muted-foreground">
                  {r.rate_class} @ {Number(r.rate_used)} · {r.basis}
                </td>
                <td className="py-1 pr-3 text-right tabular-nums">
                  {money(r.debit_presentation, currency)}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {money(r.credit_presentation, currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <TransactionPreviewDrawer
        open={!!preview}
        onOpenChange={(open) => !open && setPreview(null)}
        sourceType={preview?.type ?? null}
        sourceId={preview?.id ?? null}
      />

      <DrillDownDialog
        open={!!drillConfig}
        onOpenChange={(open) => !open && setDrillConfig(null)}
        config={drillConfig}
      />
    </div>
  );
}
