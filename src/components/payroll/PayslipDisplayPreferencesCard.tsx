/**
 * PayslipDisplayPreferencesCard — tenant-controlled toggles that affect
 * what the generated payslip PDF prints in its header.
 *
 * Currently exposes:
 *   - payslip_show_employer_statutory_ids: when OFF (default, Odoo-aligned),
 *     the employer block on the payslip prints only the legal name. When ON,
 *     statutory IDs (KRA PIN, NSSF No., SHIF No., AHL No.) tied to a rule
 *     that ran this period are printed. Blank values are never shown.
 *
 * Lives in /hr/payroll/setup beside EmployerStatutoryIdentifiersCard so the
 * person entering the IDs immediately sees the visibility switch.
 */
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { usePermissions } from "@/hooks/usePermissions";
import { normalizeError } from "@/services/resilience";

export function PayslipDisplayPreferencesCard() {
  const { currentOrg } = useOrganization();
  const { can } = usePermissions();
  const canEdit = can("managePayroll");
  const qc = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: ["payroll-settings", currentOrg?.id],
    enabled: !!currentOrg?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll_settings")
        .select("pdf_show_explainer, payslip_show_employer_statutory_ids")
        .eq("organization_id", currentOrg!.id)
        .maybeSingle();
      if (error) throw error;
      return data ?? {
        pdf_show_explainer: true,
        payslip_show_employer_statutory_ids: false,
      };
    },
  });

  const [showIds, setShowIds] = useState<boolean>(false);
  useEffect(() => {
    if (settingsQuery.data) {
      setShowIds(!!(settingsQuery.data as any).payslip_show_employer_statutory_ids);
    }
  }, [settingsQuery.data]);

  const save = useMutation({
    mutationFn: async (next: boolean) => {
      const payload = {
        organization_id: currentOrg!.id,
        payslip_show_employer_statutory_ids: next,
        // Preserve other knobs.
        pdf_show_explainer: (settingsQuery.data as any)?.pdf_show_explainer ?? true,
      };
      const { error } = await supabase
        .from("payroll_settings")
        .upsert(payload, { onConflict: "organization_id" });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Payslip display preferences saved");
      qc.invalidateQueries({ queryKey: ["payroll-settings", currentOrg?.id] });
    },
    onError: (e) => toast.error(normalizeError(e).message || "Could not save preference"),
  });

  const loading = settingsQuery.isLoading;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Payslip display preferences</CardTitle>
        <p className="text-sm text-muted-foreground mt-1">
          Controls what appears in the header of generated payslip PDFs. Defaults follow
          the industry norm (Odoo, ADP): show employer name only. Blank identifiers are
          always omitted — never printed as &quot;MISSING&quot;.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-4 rounded-md border p-3">
          <div className="space-y-1">
            <Label htmlFor="show-employer-ids" className="text-sm font-medium">
              Print employer statutory identifiers on payslip PDF
            </Label>
            <p className="text-xs text-muted-foreground">
              When enabled, registered employer IDs (KRA PIN, NSSF No., SHIF No., AHL No.)
              are printed in the employer block — but only those tied to a rule that
              actually ran this period.
            </p>
          </div>
          <div className="pt-1">
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <Switch
                id="show-employer-ids"
                checked={showIds}
                disabled={!canEdit || save.isPending}
                onCheckedChange={(v) => {
                  setShowIds(v);
                  save.mutate(v);
                }}
              />
            )}
          </div>
        </div>
        {!canEdit && (
          <p className="text-xs text-muted-foreground">
            You need the &quot;Manage Payroll&quot; permission to change these preferences.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default PayslipDisplayPreferencesCard;
