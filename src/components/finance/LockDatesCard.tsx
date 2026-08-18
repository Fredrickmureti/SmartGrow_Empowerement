import { normalizeError } from "@/services/resilience";
/**
 * LockDatesCard — Odoo-parity lock date hierarchy.
 *
 * Three layers (most → least restrictive):
 *   1. fiscalyear_lock_date — hard lock, blocks every user (including
 *      admins) from posting on/before this date. Set after the audit signs
 *      off on the fiscal year. Enforced by DB trigger
 *      `enforce_fiscal_period_lock_header` (Migration 4).
 *   2. period_lock_date — soft lock, blocks non-advisor users from posting
 *      on/before this date. Surfaced here for awareness; enforcement at the
 *      RPC layer where role context is available.
 *   3. tax_lock_date — blocks tax-impacting entries on/before this date.
 *      Used when filing periodic VAT / sales-tax returns to freeze the
 *      tax base.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useToast } from "@/hooks/use-toast";
import { useAuditLog } from "@/hooks/useAuditLog";
import { useFinancePermission } from "@/hooks/finance/useFinancePermission";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { FinanceReadOnlyNotice } from "@/components/finance/FinanceReadOnlyNotice";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Lock, ShieldAlert, Save, Loader2 } from "lucide-react";

interface LockDates {
  fiscalyear_lock_date: string | null;
  period_lock_date: string | null;
  tax_lock_date: string | null;
}

export function LockDatesCard() {
  const { currentOrg } = useOrganization();
  const { toast } = useToast();
  const { logAction } = useAuditLog();
  const { allowed: canManagePeriods, isLoading: permLoading } =
    useFinancePermission("finance.manage_periods");
  // Lock dates are a parent-business action (Odoo / QuickBooks parity).
  // HQ branch IS the parent-business edit surface; non-HQ branches are
  // read-only. Single-branch businesses always pass through.
  const { isBranchScopedReadOnly } = useFinanceScope();
  const readOnly = !canManagePeriods || isBranchScopedReadOnly;

  const [dates, setDates] = useState<LockDates>({
    fiscalyear_lock_date: null,
    period_lock_date: null,
    tax_lock_date: null,
  });
  const [original, setOriginal] = useState<LockDates>({
    fiscalyear_lock_date: null,
    period_lock_date: null,
    tax_lock_date: null,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!currentOrg?.id) return;
    setIsLoading(true);
    (supabase as any)
      .from("organizations")
      .select("fiscalyear_lock_date, period_lock_date, tax_lock_date")
      .eq("id", currentOrg.id)
      .single()
      .then(({ data, error }: any) => {
        if (!error && data) {
          const next: LockDates = {
            fiscalyear_lock_date: data.fiscalyear_lock_date,
            period_lock_date: data.period_lock_date,
            tax_lock_date: data.tax_lock_date,
          };
          setDates(next);
          setOriginal(next);
        }
        setIsLoading(false);
      });
  }, [currentOrg?.id]);

  const hasChanges =
    dates.fiscalyear_lock_date !== original.fiscalyear_lock_date ||
    dates.period_lock_date !== original.period_lock_date ||
    dates.tax_lock_date !== original.tax_lock_date;

  const handleSave = async () => {
    if (!currentOrg?.id) return;
    setIsSaving(true);
    const { error } = await (supabase as any)
      .from("organizations")
      .update({
        fiscalyear_lock_date: dates.fiscalyear_lock_date || null,
        period_lock_date: dates.period_lock_date || null,
        tax_lock_date: dates.tax_lock_date || null,
      })
      .eq("id", currentOrg.id);

    if (error) {
      toast({
        title: "Could not save lock dates",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } else {
      logAction({
        action: "updated",
        entityType: "organization_lock_dates",
        entityId: currentOrg.id,
        entityName: currentOrg.name ?? "Organization",
        oldValues: original as unknown as Record<string, unknown>,
        newValues: dates as unknown as Record<string, unknown>,
        changesSummary: "Updated finance lock dates",
      });
      setOriginal(dates);
      toast({
        title: "Lock dates saved",
        description:
          "Posting on or before these dates is now restricted per Odoo-parity rules.",
      });
    }
    setIsSaving(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Lock className="h-4 w-4" />
          Lock Dates
          <Badge variant="outline" className="text-[10px]">
            Advisor only
          </Badge>
        </CardTitle>
        <CardDescription className="text-xs">
          Freeze posting to closed periods. Set after audits or tax filings to
          guarantee historical reports never change.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <ShieldAlert className="h-4 w-4" />
          <AlertDescription className="text-xs">
            <strong>Fiscal-year lock</strong> is the strongest — once set,
            <em> nobody</em> can post on or before that date, including
            admins. Use only after final sign-off.
          </AlertDescription>
        </Alert>

        <FinanceReadOnlyNotice
          what="see the current lock dates"
          permission="finance.manage_periods"
          isLoading={permLoading}
          readOnly={readOnly}
        />

        {isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="fiscalyear_lock">Fiscal-year lock (hard)</Label>
              <Input
                id="fiscalyear_lock"
                type="date"
                value={dates.fiscalyear_lock_date ?? ""}
                disabled={readOnly}
                onChange={(e) =>
                  setDates((d) => ({
                    ...d,
                    fiscalyear_lock_date: e.target.value || null,
                  }))
                }
              />
              <p className="text-[11px] text-muted-foreground">
                Blocks <strong>all</strong> users — even admins.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="period_lock">Period lock (soft)</Label>
              <Input
                id="period_lock"
                type="date"
                value={dates.period_lock_date ?? ""}
                disabled={readOnly}
                onChange={(e) =>
                  setDates((d) => ({
                    ...d,
                    period_lock_date: e.target.value || null,
                  }))
                }
              />
              <p className="text-[11px] text-muted-foreground">
                Blocks non-advisor users.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tax_lock">Tax lock</Label>
              <Input
                id="tax_lock"
                type="date"
                value={dates.tax_lock_date ?? ""}
                disabled={readOnly}
                onChange={(e) =>
                  setDates((d) => ({
                    ...d,
                    tax_lock_date: e.target.value || null,
                  }))
                }
              />
              <p className="text-[11px] text-muted-foreground">
                Blocks tax-impacting entries (filed VAT/sales-tax periods).
              </p>
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <Button
            onClick={handleSave}
            disabled={!hasChanges || isSaving || isLoading || readOnly}
            size="sm"
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Save lock dates
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
