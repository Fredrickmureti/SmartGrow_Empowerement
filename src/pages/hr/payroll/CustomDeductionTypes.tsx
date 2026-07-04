/**
 * Rule Type Definitions — tenant-owned catalog surface.
 *
 * Renamed in Slice 1 of the Custom Deduction Types audit (from "Custom
 * Deduction Types"). The old name was an IA lie: no consumer creates an
 * employee deduction from these rows. This screen exists solely to define
 * the (label, parameter_schema, computation_method) tuples that the
 * Statutory Rules editor exposes in its type-picker.
 *
 * For actual employee deductions see:
 *   • Loans        → /hr/payroll/loans
 *   • Advances     → /hr/employees (advances tab)  [managed via employee_advances]
 *   • Garnishments → /hr/payroll/garnishments
 *   • Salary rules → /hr/payroll/configuration/structures
 *   • Statutory    → /hr/payroll/statutory-rules
 *
 * Route: /hr/payroll/configuration/rule-types
 * (Legacy alias: /hr/payroll/configuration/deduction-types → redirected)
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
import { Plus, Loader2, Edit2, Trash2, Settings2, ArrowLeft, ExternalLink, Info } from "lucide-react";
import { normalizeError } from "@/services/resilience";
import { useRuleTypes, type RuleType } from "@/hooks/usePayrollRuleTypes";
import { RuleTypeDefinitionDialog } from "@/components/payroll/CustomDeductionTypeDialog";

const RELATED_SURFACES: Array<{ to: string; label: string; description: string }> = [
  { to: "/hr/payroll/statutory-rules", label: "Statutory rules",   description: "Legislative catalog (PAYE, SHIF, NSSF, levies) — consumes these type definitions." },
  { to: "/hr/payroll/loans",           label: "Employee loans",    description: "Full loan lifecycle: request → approval → amortised recovery." },
  { to: "/hr/payroll/garnishments",    label: "Garnishments",      description: "Court-ordered deductions with priority + carry-forward." },
  { to: "/hr/payroll/configuration/structures", label: "Salary structures", description: "Rule-graph engine for allowances, bespoke deduction formulas." },
  { to: "/hr/payroll/configuration/loan-types", label: "Loan types", description: "Tenant loan product catalog (interest, term, recovery)." },
];

export default function CustomDeductionTypes() {
  const { currentOrg } = useOrganization();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: ruleTypes = [], isLoading } = useRuleTypes(currentOrg?.id);

  const [showTypeDialog, setShowTypeDialog] = useState(false);
  const [editingType, setEditingType] = useState<RuleType | null>(null);
  const [deleteType, setDeleteType] = useState<RuleType | null>(null);

  // Slice 1: real soft-delete. Historical statutory rules keep resolving
  // their type label because useRuleTypes filters on is_active=true; making
  // this a hard DELETE would break that resolution silently.
  const deleteTypeMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("payroll_rule_types" as any)
        .update({ is_active: false })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payroll-rule-types"] });
      toast({ title: "Rule type archived" });
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
            <h1 className="page-title">Rule type definitions</h1>
            <p className="text-sm sm:text-base text-muted-foreground max-w-3xl">
              Defines the label, parameter schema, and computation method the{" "}
              <Link to="/hr/payroll/statutory-rules" className="underline">Statutory Rules</Link>{" "}
              editor exposes in its type picker. <strong>This screen does not create employee
              deductions.</strong>
            </p>
          </div>
          <Button onClick={() => { setEditingType(null); setShowTypeDialog(true); }}>
            <Plus className="h-4 w-4 mr-2" /> New rule type
          </Button>
        </div>

        {/* Truth-in-labelling banner — points mis-navigated users to the right surface. */}
        <Card className="border-dashed">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Info className="h-4 w-4" /> Looking to actually deduct something from an employee?
            </CardTitle>
            <CardDescription className="text-xs">
              Employee deductions are managed by the module that owns their lifecycle. Pick the
              right home below — creating a row here does not affect any payroll run.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {RELATED_SURFACES.map((s) => (
                <Link
                  key={s.to}
                  to={s.to}
                  className="group border rounded-md p-2 hover:bg-muted/60 transition-colors"
                >
                  <div className="flex items-center gap-1 text-sm font-medium">
                    {s.label}
                    <ExternalLink className="h-3 w-3 opacity-50 group-hover:opacity-100" />
                  </div>
                  <div className="text-[11px] text-muted-foreground leading-snug">
                    {s.description}
                  </div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : ruleTypes.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Settings2 className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium">No rule types defined</h3>
              <p className="text-muted-foreground text-sm text-center max-w-md mt-1">
                Create a rule type to describe the shape of a statutory or tenant-defined rule
                the Statutory Rules editor should offer.
              </p>
              <Button className="mt-4" onClick={() => { setEditingType(null); setShowTypeDialog(true); }}>
                <Plus className="h-4 w-4 mr-2" /> New rule type
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
                        <Badge variant="outline" className="text-xs font-mono">{rt.computation_method}</Badge>
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

      <RuleTypeDefinitionDialog
        open={showTypeDialog}
        onOpenChange={(v) => { setShowTypeDialog(v); if (!v) setEditingType(null); }}
        editingType={editingType}
        orgId={currentOrg?.id ?? ""}
      />

      <AlertDialog open={!!deleteType} onOpenChange={() => setDeleteType(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this rule type?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>"{deleteType?.label}"</strong> will be hidden from the type picker.
              Existing statutory rules of this type keep running and keep their label —
              you just can't create new ones. This can be undone by re-inserting the row
              with the same code.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteType && deleteTypeMutation.mutate(deleteType.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
