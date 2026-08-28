/**
 * Elimination policy per group (Brick 7 configuration surface).
 *
 * This screen holds *decisions a person makes*, never figures:
 *
 * - whether a class of eliminations is produced at all;
 * - how far the two sides of an intra-group pair may disagree before the run
 *   is refused (the tolerance);
 * - what happens when they disagree by more than that — refuse the run, or
 *   post the residual to a named group account where it can be seen.
 *
 * No elimination amount is calculated here or anywhere else in the browser.
 * `consolidation_generate_eliminations` reads these rows and does the work.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { eliminationClassAnchor } from "@/lib/finance/eliminationRemedies";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertTriangle, Info, Loader2, Scissors } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useConsolidationGroupAccounts } from "@/hooks/finance/useConsolidationAccountMapping";
import {
  ELIMINATION_CLASS_LABELS,
  ELIMINATION_POLICY_LABELS,
  ELIMINATION_RULE_DEFAULTS,
  ELIMINATION_TOLERANCE_CAP,

  useConsolidationEliminationRules,
  useConsolidationEliminationMutations,
  type EliminationClass,
  type EliminationDifferencePolicy,
  type EliminationRule,
} from "@/hooks/finance/useConsolidationEliminations";

const CLASSES: EliminationClass[] = [
  "intercompany_balance" as EliminationClass,
  "intercompany_trading" as EliminationClass,
];

const CLASS_HELP: Record<string, string> = {
  intercompany_balance:
    "What one member says it is owed by another, against what that member says it owes.",
  intercompany_trading:
    "Revenue booked by one member against the matching cost booked by another.",
};

interface Props {
  groupId: string;
  groupName: string;
  canManage: boolean;
  /** The group's presentation currency, so the bound is stated in real money. */
  presentationCurrency?: string | null;
  /**
   * The class an elimination refusal sent the accountant here to settle, and
   * the remedy code it named. Both come from the server's diagnosis by way of
   * the URL — nothing is inferred from a message.
   */
  focusClass?: string | null;
  focusRemedy?: string | null;
}


interface Draft {
  is_active: boolean;
  tolerance_amount: string;
  tolerance_reason: string;
  difference_policy: EliminationDifferencePolicy;
  difference_group_account_id: string;
}

const NO_ACCOUNT = "__none__";

/** The rule as stored, or the engine's own default when none has been saved. */
function draftFrom(rule: EliminationRule | undefined): Draft {
  return {
    is_active: rule?.is_active ?? ELIMINATION_RULE_DEFAULTS.is_active,
    tolerance_amount: String(
      rule ? rule.tolerance_amount : ELIMINATION_RULE_DEFAULTS.tolerance_amount,
    ),
    tolerance_reason: rule?.tolerance_reason ?? "",
    difference_policy:
      rule?.difference_policy ?? ELIMINATION_RULE_DEFAULTS.difference_policy,
    difference_group_account_id: rule?.difference_group_account_id ?? NO_ACCOUNT,
  };
}


export function ConsolidationEliminationRules({
  groupId,
  groupName,
  canManage,
  presentationCurrency = null,
  focusClass = null,
  focusRemedy = null,
}: Props) {
  const capLabel = presentationCurrency
    ? `${ELIMINATION_TOLERANCE_CAP.toLocaleString()} ${presentationCurrency}`
    : `${ELIMINATION_TOLERANCE_CAP.toLocaleString()} in the group's presentation currency`;
  const rulesQuery = useConsolidationEliminationRules(groupId);
  const accountsQuery = useConsolidationGroupAccounts(groupId);
  const { saveRule } = useConsolidationEliminationMutations();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [savingClass, setSavingClass] = useState<string | null>(null);


  const ruleFor = useMemo(() => {
    const map = new Map<string, EliminationRule>();
    for (const r of rulesQuery.data ?? []) map.set(r.elimination_class, r);
    return map;
  }, [rulesQuery.data]);

  const accounts = accountsQuery.data ?? [];

  /**
   * Arriving from a refusal that named "configure a difference account" only
   * makes sense with that policy selected, so the draft starts there. It stays
   * a draft: nothing is saved until the accountant names the account and saves.
   */
  const prefilled = useRef<string | null>(null);
  useEffect(() => {
    if (!focusClass || focusRemedy !== "configure_difference_account") return;
    const key = `${groupId}:${focusClass}`;
    if (prefilled.current === key) return;
    prefilled.current = key;
    setDrafts((prev) => ({
      ...prev,
      [focusClass]: {
        ...draftFrom(ruleFor.get(focusClass)),
        ...prev[focusClass],
        difference_policy: "post_difference" as EliminationDifferencePolicy,
      },
    }));
  }, [focusClass, focusRemedy, groupId, ruleFor]);


  const draftOf = (cls: EliminationClass): Draft =>
    drafts[cls] ?? draftFrom(ruleFor.get(cls));

  const patch = (cls: EliminationClass, change: Partial<Draft>) =>
    setDrafts((prev) => ({ ...prev, [cls]: { ...draftOf(cls), ...change } }));

  const save = async (cls: EliminationClass) => {
    const draft = draftOf(cls);
    const tolerance = Number(draft.tolerance_amount);
    const reason = draft.tolerance_reason.trim();
    if (!Number.isFinite(tolerance) || tolerance < 0) {
      toast.error("The tolerance must be zero or a positive amount");
      return;
    }
    // The bound and the reason are the database's rules; checking them here
    // only spares a round trip, it never decides them.
    if (tolerance > ELIMINATION_TOLERANCE_CAP) {
      toast.error(
        `A tolerance absorbs rounding: it cannot exceed ${ELIMINATION_TOLERANCE_CAP} in the group's presentation currency`,
      );
      return;
    }
    if (tolerance > 0 && reason.length < 20) {
      toast.error(
        "Say why the group accepts a difference of that size without treating it as a disagreement",
      );
      return;
    }
    if (
      draft.difference_policy === "post_difference" &&
      draft.difference_group_account_id === NO_ACCOUNT
    ) {
      toast.error("Name the group account the residual should be posted to");
      return;
    }
    setSavingClass(cls);
    try {
      await saveRule.mutateAsync({
        group_id: groupId,
        elimination_class: cls,
        is_active: draft.is_active,
        tolerance_amount: tolerance,
        tolerance_reason: reason === "" ? null : reason,
        difference_policy: draft.difference_policy,
        difference_group_account_id:
          draft.difference_group_account_id === NO_ACCOUNT
            ? null
            : draft.difference_group_account_id,
      });
      setDrafts((prev) => {

        const next = { ...prev };
        delete next[cls];
        return next;
      });
      toast.success("Elimination policy saved");
    } catch (e) {
      // The database guard's own words — never a paraphrase.
      toast.error(e instanceof Error ? e.message : "The policy change was rejected");
    } finally {
      setSavingClass(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <Scissors className="h-5 w-5 text-muted-foreground" />
          <div>
            <CardTitle className="text-base">Elimination policy — {groupName}</CardTitle>
            <CardDescription>
              How intra-group positions are removed from the group's statements, and what
              happens when the two sides disagree.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription className="text-sm">
            Nothing here produces a figure. Eliminations are generated by the server from
            the declared intercompany relationships and the translated consolidated trial
            balance; these settings only decide whether a disagreement stops the run or is
            posted somewhere it can be seen and investigated.
          </AlertDescription>
        </Alert>

        {rulesQuery.error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {rulesQuery.error instanceof Error
                ? rulesQuery.error.message
                : "The elimination policy could not be read."}
            </AlertDescription>
          </Alert>
        )}

        {CLASSES.map((cls) => {
          const draft = draftOf(cls);
          const stored = ruleFor.get(cls);
          const dirty = !!drafts[cls];
          const typeMatched = accounts.filter((a) => a.is_active);
          const focused = focusClass === cls;
          const toleranceNumber = Number(draft.tolerance_amount);
          const overCap =
            Number.isFinite(toleranceNumber) &&
            toleranceNumber > ELIMINATION_TOLERANCE_CAP;
          return (

              <div
                key={cls}
                id={eliminationClassAnchor(cls)}
                className={
                  focused
                    ? "rounded-lg border-2 border-primary p-4 space-y-4"
                    : "rounded-lg border p-4 space-y-4"
                }
              >
                {focused && (
                  <Alert>
                    <Info className="h-4 w-4" />
                    <AlertDescription className="text-sm">
                      An elimination run for this group was refused over this class.
                      {focusRemedy === "configure_difference_account"
                        ? " Name the group account the residual should be disclosed in, then save — the next run reads this policy."
                        : " Settle the policy below, then run the eliminations again."}
                    </AlertDescription>
                  </Alert>
                )}

              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-medium">
                    {ELIMINATION_CLASS_LABELS[cls] ?? cls}
                  </p>
                  <p className="text-xs text-muted-foreground">{CLASS_HELP[cls]}</p>
                  <div className="mt-1">
                    {stored ? (
                      <Badge variant={stored.is_system_default ? "secondary" : "outline"}>
                        {stored.is_system_default
                          ? "System default"
                          : "Customised for this group"}
                      </Badge>
                    ) : (
                      <Badge variant="outline">Not configured</Badge>
                    )}
                  </div>
                  {stored?.is_system_default && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Seeded when the group was created: a rounding-scale tolerance, with a
                      currency-translation residual carried to the group's translation
                      reserve. Saving any change here makes it this group's own policy.
                    </p>
                  )}
                  {!stored && (
                    <p className="text-xs text-muted-foreground mt-1">
                      No policy row for this class — the values shown are the system
                      default; save to apply them.
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Switch
                    id={`elim-active-${cls}`}
                    checked={draft.is_active}
                    disabled={!canManage}
                    onCheckedChange={(v) => patch(cls, { is_active: v })}
                  />
                  <Label htmlFor={`elim-active-${cls}`} className="text-sm">
                    Produce these eliminations
                  </Label>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1">
                  <Label htmlFor={`elim-tol-${cls}`}>Tolerance</Label>
                  <Input
                    id={`elim-tol-${cls}`}
                    type="number"
                    min="0"
                    max={ELIMINATION_TOLERANCE_CAP}
                    step="0.01"
                    value={draft.tolerance_amount}
                    disabled={!canManage}
                    onChange={(e) => patch(cls, { tolerance_amount: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    In the group's presentation currency. Zero means the two sides must
                    agree exactly. A tolerance absorbs rounding, so it cannot exceed{" "}
                    {capLabel}: a larger gap is a real difference and has to be explained
                    by the books, not widened away.
                  </p>
                  {overCap && (
                    <Alert variant="destructive" className="mt-2">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertDescription className="text-xs">
                        {Number(draft.tolerance_amount).toLocaleString()}{" "}
                        {presentationCurrency ?? ""} is not rounding, so it cannot be
                        saved as a tolerance. To carry a gap of that size, leave the
                        tolerance at a rounding amount and set “When they disagree by
                        more” to post the difference to a named group account — the
                        residual is then disclosed on the face of the statements instead
                        of being hidden inside the eliminated accounts.
                      </AlertDescription>
                    </Alert>
                  )}
                  <Textarea
                    className="mt-2 text-xs"
                    rows={2}
                    placeholder="Why a difference of this size is not a disagreement"
                    value={draft.tolerance_reason}
                    disabled={!canManage || Number(draft.tolerance_amount) <= 0}
                    onChange={(e) => patch(cls, { tolerance_reason: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Required for any tolerance above zero, and recorded with who changed
                    it and when.
                  </p>
                </div>


                <div className="space-y-1">
                  <Label>When they disagree by more</Label>
                  <Select
                    value={draft.difference_policy}
                    disabled={!canManage}
                    onValueChange={(v) =>
                      patch(cls, {
                        difference_policy: v as EliminationDifferencePolicy,
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(ELIMINATION_POLICY_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {draft.difference_policy === "post_to_cta" ? (
                    <p className="text-xs text-muted-foreground">
                      Only for pairs where a company reports in another currency: the
                      residual left by translating trading legs at average rates and
                      balances at closing rates goes to the group's translation reserve.
                      A gap between two companies that both report in the presentation
                      currency is still refused.
                    </p>
                  ) : null}
                </div>


                <div className="space-y-1">
                  <Label>Difference account</Label>
                  <Select
                    value={draft.difference_group_account_id}
                    disabled={!canManage || draft.difference_policy !== "post_difference"}
                    onValueChange={(v) => patch(cls, { difference_group_account_id: v })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a group account" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_ACCOUNT}>None</SelectItem>
                      {typeMatched.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.code} · {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    A line of the group's own chart. The residual is disclosed there, not
                    absorbed into the eliminated accounts.
                  </p>
                </div>
              </div>

              {canManage && (
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    disabled={!dirty || savingClass === cls}
                    onClick={() => save(cls)}
                  >
                    {savingClass === cls && (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    )}
                    Save policy
                  </Button>
                </div>
              )}
            </div>
          );
        })}

        {!canManage && (
          <p className="text-xs text-muted-foreground">
            Your role can read this policy but not change it.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
