/**
 * Custom Deduction Types — dedicated workspace.
 *
 * Phase C of the Statutory Rules architectural hardening separates this
 * tenant-owned, operational concept from the pack-owned legislative
 * Statutory Rules workspace. The two have different governance,
 * different lifecycles, and different downstream consumers; co-locating
 * them under one screen blurred the legislative-vs-operational
 * distinction (W8 of the architectural investigation).
 *
 * Route: /hr/payroll/configuration/deduction-types
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useOrganization } from "@/hooks/useOrganization";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Loader2, Edit2, Trash2, Settings2, ArrowLeft } from "lucide-react";
import { normalizeError } from "@/services/resilience";
import { useRuleTypes, type RuleType } from "@/hooks/usePayrollRuleTypes";
import { CustomDeductionTypeDialog } from "@/components/payroll/CustomDeductionTypeDialog";

export default function CustomDeductionTypes() {
  const { currentOrg } = useOrganization();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: ruleTypes = [], isLoading } = useRuleTypes(currentOrg?.id);

  const [showTypeDialog, setShowTypeDialog] = useState(false);
  const [editingType, setEditingType] = useState<RuleType | null>(null);
  const [deleteType, setDeleteType] = useState<RuleType | null>(null);

  const deleteTypeMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("payroll_rule_types" as any)
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payroll-rule-types"] });
      toast({ title: "Rule type deleted" });
      setDeleteType(null);
    },
    onError: (err: any) => {
      toast({ title: "Error", description: normalizeError(err).message, variant: "destructive" });
    },
  });

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <Link to="/hr/payroll/configuration" className="flex items-center gap-1 hover:text-foreground">
                <ArrowLeft className="h-3 w-3" /> Configuration
              </Link>
            </div>
            <h1 className="page-title">Custom Deduction Types</h1>
            <p className="text-sm sm:text-base text-muted-foreground">
              Tenant-defined, non-statutory deduction shapes (loans, advances, SACCO, gym fees, etc.).
              Statutory rules (PAYE, social security, levies) are governed separately in{" "}
              <Link to="/hr/payroll/statutory-rules" className="underline">Statutory Rules</Link>{" "}
              via localization packs.
            </p>
          </div>
          <Button onClick={() => { setEditingType(null); setShowTypeDialog(true); }}>
            <Plus className="h-4 w-4 mr-2" /> New custom type
          </Button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : ruleTypes.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Settings2 className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium">No custom deduction types defined</h3>
              <p className="text-muted-foreground text-sm text-center max-w-md mt-1">
                Create a type to describe the shape of a non-statutory deduction your organization uses.
              </p>
              <Button className="mt-4" onClick={() => { setEditingType(null); setShowTypeDialog(true); }}>
                <Plus className="h-4 w-4 mr-2" /> New custom type
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {ruleTypes.map((rt) => (
              <Card key={rt.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-base flex items-center gap-2">
                        {rt.label}
                        {rt.is_system && <Badge variant="outline" className="text-xs">System</Badge>}
                        {rt.is_bracket && <Badge variant="secondary" className="text-xs">Bracket</Badge>}
                      </CardTitle>
                      <CardDescription className="text-xs mt-1">{rt.description}</CardDescription>
                    </div>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" onClick={() => { setEditingType(rt); setShowTypeDialog(true); }}>
                        <Edit2 className="h-4 w-4" />
                      </Button>
                      {!rt.is_system && (
                        <Button variant="ghost" size="icon" onClick={() => setDeleteType(rt)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="text-xs text-muted-foreground mb-1">
                    Code: <code className="bg-muted px-1 rounded">{rt.code}</code>
                  </div>
                  <div className="text-xs font-medium mb-1">Parameter fields:</div>
                  <div className="space-y-1">
                    {rt.parameter_schema.map((f, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <code className="bg-muted px-1 rounded">{f.key}</code>
                        <span className="text-muted-foreground">{f.label}</span>
                        <Badge variant="outline" className="text-xs h-4">{f.type}</Badge>
                        {f.optional && <Badge variant="secondary" className="text-xs h-4">optional</Badge>}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <CustomDeductionTypeDialog
        open={showTypeDialog}
        onOpenChange={(v) => { setShowTypeDialog(v); if (!v) setEditingType(null); }}
        editingType={editingType}
        orgId={currentOrg?.id ?? ""}
      />

      <AlertDialog open={!!deleteType} onOpenChange={() => setDeleteType(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete custom deduction type?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete the <strong>"{deleteType?.label}"</strong> type. Existing rules of this
              type remain but you won't be able to create new ones.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteType && deleteTypeMutation.mutate(deleteType.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
