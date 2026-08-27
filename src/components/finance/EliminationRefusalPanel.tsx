/**
 * The refusal, and what may be done about it.
 *
 * Every judgement shown here comes from the server's own preflight
 * (`consolidation_diagnose_eliminations`): the residual, the tolerance and
 * policy in force, whether the gap is a translation effect or a real
 * disagreement, and the remedy codes the engine would accept. This component
 * never parses a message and never computes an amount — a quick action only
 * writes the policy row the accountant would otherwise have set by hand, and
 * the engine re-decides on the next run.
 */
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AlertTriangle, ExternalLink, Loader2, Stethoscope } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { toAppError } from "@/lib/supabaseError";
import {
  ELIMINATION_CLASS_LABELS,
  ELIMINATION_POLICY_LABELS,
  useConsolidationEliminationMutations,
  type EliminationClass,
  type EliminationDiagnosisRow,
  type EliminationRule,
} from "@/hooks/finance/useConsolidationEliminations";
import {
  ELIMINATION_CAUSE_LABELS,
  ELIMINATION_REMEDY_LABELS,
  isApplicableRemedy,
  remedyLink,
} from "@/lib/finance/eliminationRemedies";

interface Props {
  groupId: string;
  currency: string;
  canManage: boolean;
  /** The server's refusal, verbatim, when a run has already been attempted. */
  refusal: string | null;
  diagnosis: EliminationDiagnosisRow[];
  isLoading: boolean;
  error: unknown;
  rules: EliminationRule[];
}

function money(value: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

export function EliminationRefusalPanel({
  groupId,
  currency,
  canManage,
  refusal,
  diagnosis,
  isLoading,
  error,
  rules,
}: Props) {
  const navigate = useNavigate();
  const { saveRule } = useConsolidationEliminationMutations();
  const [applying, setApplying] = useState<string | null>(null);

  const blocking = diagnosis.filter((d) => d.would_refuse);
  const advisory = diagnosis.filter((d) => !d.would_refuse);

  if (!refusal && blocking.length === 0 && advisory.length === 0 && !error && !isLoading) {
    return null;
  }

  /**
   * Write the policy the remedy stands for. The tolerance figure is the
   * server's own `suggested_tolerance`, not a number computed here.
   */
  const apply = async (row: EliminationDiagnosisRow, code: string) => {
    const cls = row.elimination_class;
    if (!cls) return;
    const existing = rules.find((r) => r.elimination_class === cls);
    const key = `${cls}:${code}`;
    setApplying(key);
    try {
      const base = {
        group_id: groupId,
        elimination_class: cls as EliminationClass,
        is_active: existing?.is_active ?? true,
        tolerance_amount: Number(existing?.tolerance_amount ?? 0),
        difference_policy: existing?.difference_policy ?? "refuse",
        difference_group_account_id: existing?.difference_group_account_id ?? null,
      };
      if (code === "raise_tolerance") {
        base.tolerance_amount = Number(row.suggested_tolerance ?? 0);
      } else if (code === "set_policy_post_to_cta") {
        base.difference_policy = "post_to_cta";
      } else if (code === "set_policy_post_difference") {
        base.difference_policy = "post_difference";
      }
      await saveRule.mutateAsync(base);
      toast.success("Policy saved — run the eliminations again to see the effect");
    } catch (e) {
      // The guard's own words, never a paraphrase.
      toast.error(toAppError(e, "The policy change was rejected").message);
    } finally {
      setApplying(null);
    }
  };

  return (
    <div className="space-y-4">
      {refusal && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            <p className="font-medium">The elimination run was refused</p>
            <p className="text-sm mt-1 whitespace-pre-wrap">{refusal}</p>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Stethoscope className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle className="text-base">
                Why this period would be refused
              </CardTitle>
              <CardDescription>
                Checked on the server against the same intercompany positions the run
                reads, before anything is written.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading && (
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking the period…
            </p>
          )}

          {!!error && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                {error instanceof Error
                  ? error.message
                  : "The period could not be checked."}
              </AlertDescription>
            </Alert>
          )}

          {!isLoading && !error && blocking.length === 0 && advisory.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing in this period would refuse the run.
            </p>
          )}

          {[...blocking, ...advisory].map((row, i) => {
            const cls = row.elimination_class;
            return (
              <div
                key={`${row.finding_kind}:${cls ?? "none"}:${row.business_a_id ?? i}:${row.business_b_id ?? i}`}
                className="rounded-lg border p-3 space-y-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={row.would_refuse ? "destructive" : "secondary"}>
                    {row.would_refuse ? "Refuses the run" : "Proceeds"}
                  </Badge>
                  {cls && (
                    <span className="text-sm font-medium">
                      {ELIMINATION_CLASS_LABELS[cls] ?? cls}
                    </span>
                  )}
                  <Badge variant="outline">
                    {ELIMINATION_CAUSE_LABELS[row.cause] ?? row.cause}
                  </Badge>
                  {row.is_cross_currency && (
                    <Badge variant="outline">
                      {row.business_a_currency} / {row.business_b_currency} →{" "}
                      {row.presentation_currency}
                    </Badge>
                  )}
                </div>

                {/* The server's sentence, unedited. */}
                <p className="text-sm whitespace-pre-wrap">{row.message}</p>

                {row.difference_amount !== null && (
                  <p className="text-xs text-muted-foreground">
                    Gap {money(Number(row.difference_amount), currency)} · tolerance{" "}
                    {money(Number(row.effective_tolerance ?? 0), currency)} ·{" "}
                    {ELIMINATION_POLICY_LABELS[row.effective_policy ?? "refuse"] ??
                      row.effective_policy}
                    {row.rule_exists ? "" : " (no policy saved for this class)"}
                  </p>
                )}

                {row.remedies.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {row.remedies.map((code) => {
                      const label = ELIMINATION_REMEDY_LABELS[code] ?? code;
                      if (isApplicableRemedy(code) && cls) {
                        const busy = applying === `${cls}:${code}`;
                        return (
                          <Button
                            key={code}
                            size="sm"
                            variant="outline"
                            disabled={!canManage || applying !== null}
                            onClick={() => apply(row, code)}
                          >
                            {busy && (
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            )}
                            {code === "raise_tolerance" && row.suggested_tolerance !== null
                              ? `${label} — ${money(Number(row.suggested_tolerance), currency)}`
                              : label}
                          </Button>
                        );
                      }
                      const href = remedyLink(code, {
                        groupId,
                        eliminationClass: cls,
                      });
                      if (!href) return null;
                      return (
                        <Button
                          key={code}
                          size="sm"
                          variant="ghost"
                          onClick={() => navigate(href)}
                        >
                          {label}
                          <ExternalLink className="h-3.5 w-3.5 ml-2" />
                        </Button>
                      );
                    })}
                  </div>
                )}

                {!canManage && row.remedies.some(isApplicableRemedy) && (
                  <p className="text-xs text-muted-foreground">
                    Your role can read this diagnosis but not change the policy.
                  </p>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
