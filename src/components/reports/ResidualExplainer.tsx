/**
 * Residual explainer — presentation only.
 *
 * The bank reconciliation engine (`finance_bank_reconciliation_statement`)
 * ranks the candidate causes of an unexplained difference server-side. This
 * component renders those findings and nothing else: it performs no accounting
 * arithmetic, invents no causes, and never mutates data. Every suggestion is
 * advice for the accountant to act on in the reconciliation workspace.
 */

import { AlertTriangle, ChevronDown, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  resolveRemedy,
  type RemedyContext,
} from "@/features/finance/reconciliation/residualRemedies";
import type { ResidualExplanation } from "@/services/finance/bankReconciliationStatement";

interface ResidualExplainerProps {
  residual: number | null;
  currency: string;
  explanations: ResidualExplanation[];
  /**
   * Where the remedies point. Navigation only — the explainer still performs
   * no accounting act of its own (ADR-0149).
   */
  remedyContext?: RemedyContext;
}

const money = (value: number | null, currency: string) =>
  value == null ? "—" : `${value.toFixed(2)} ${currency}`;

const remedyLinkClass =
  "inline-flex items-center gap-1 text-sm font-medium underline underline-offset-2";

export function ResidualExplainer({
  residual,
  currency,
  explanations,
  remedyContext,
}: ResidualExplainerProps) {
  const ctx: RemedyContext = remedyContext ?? { bankAccountId: null, sessionId: null };
  return (
    <Alert variant="destructive">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Statement does not reconcile</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>
          An unexplained difference of {money(residual, currency)} remains after outstanding
          and unrecorded items.
        </p>

        {explanations.length === 0 ? (
          <p className="text-sm">
            The engine found no recognisable pattern behind this difference. Check for
            postings on the control account that belong to another bank, and for statement
            lines imported twice.
          </p>
        ) : (
          <ol className="space-y-2">
            {explanations.map((explanation, index) => {
              const remedy = resolveRemedy(explanation.code);
              const primary = remedy?.primary?.(ctx) ?? null;
              return (
              <li key={explanation.code}>
                <Collapsible className="rounded-md border border-destructive/30 bg-background/60">
                  <CollapsibleTrigger className="flex w-full items-start justify-between gap-3 p-3 text-left">
                    <span className="space-y-1">
                      <span className="flex items-center gap-2">
                        <Badge variant="outline">{index + 1}</Badge>
                        <span className="font-medium text-foreground">{explanation.title}</span>
                      </span>
                      <span className="block text-sm text-muted-foreground">
                        {explanation.detail}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2 font-mono text-sm text-foreground">
                      {money(explanation.amount, currency)}
                      <ChevronDown className="h-4 w-4" />
                    </span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    {remedy && (
                      <div className="mx-3 mb-3 rounded-md border border-border/60 bg-muted/40 p-3">
                        <p className="text-sm font-medium text-foreground">{remedy.action}</p>
                        <p className="mt-1 text-sm text-muted-foreground">{remedy.guidance}</p>
                        {primary && (
                          <Link className={`${remedyLinkClass} mt-2`} to={primary.href}>
                            {primary.label}
                            <ExternalLink className="h-3 w-3" />
                          </Link>
                        )}
                      </div>
                    )}
                    {explanation.refs.length === 0 ? (
                      <p className="px-3 pb-3 text-sm text-muted-foreground">
                        No individual rows to show for this finding.
                      </p>
                    ) : (
                      <div className="px-3 pb-3">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-muted-foreground">
                              <th className="py-1 font-normal">Date</th>
                              <th className="py-1 font-normal">Reference</th>
                              <th className="py-1 font-normal">Description</th>
                              <th className="py-1 text-right font-normal">Amount</th>
                              <th className="py-1 text-right font-normal sr-only">Open</th>
                            </tr>
                          </thead>
                          <tbody>
                            {explanation.refs.map((ref, refIndex) => {
                              const refLink = remedy?.forRef?.(ref, ctx) ?? null;
                              return (
                                <tr
                                  key={`${explanation.code}-${ref.id ?? refIndex}-${refIndex}`}
                                  className="border-t border-border/60"
                                >
                                  <td className="py-1">{ref.date ?? "—"}</td>
                                  <td className="py-1">{ref.reference ?? "—"}</td>
                                  <td className="py-1">{ref.description ?? "—"}</td>
                                  <td className="py-1 text-right font-mono">
                                    {ref.amount == null ? "—" : ref.amount.toFixed(2)}
                                  </td>
                                  <td className="py-1 pl-3 text-right">
                                    {refLink ? (
                                      <Link className={remedyLinkClass} to={refLink.href}>
                                        {refLink.label}
                                        <ExternalLink className="h-3 w-3" />
                                      </Link>
                                    ) : null}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              </li>
              );
            })}
          </ol>
        )}
      </AlertDescription>
    </Alert>
  );
}
