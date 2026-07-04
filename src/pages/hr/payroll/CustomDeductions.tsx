/**
 * Custom Deductions catalog — Slice 2 workspace.
 *
 * Route: /hr/payroll/configuration/custom-deductions
 *
 * The honest home for ad-hoc, tenant-defined recurring/one-time
 * deductions that aren't loans, advances, garnishments, statutory items
 * or benefits. Downstream consumers:
 *   • compute-payroll — reads active types + employee assignments
 *   • post-payroll-gl — reads gl_liability_account_id / gl_expense_account_id
 *   • payroll_readiness_summary — flags active types with missing GL mapping
 *   • employee profile → Custom Deductions tab — assignment UI
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Plus, ArrowLeft, Edit2, Archive, AlertTriangle, Info, ExternalLink, Loader2,
} from "lucide-react";
import {
  useCustomDeductionTypes,
  useCustomDeductionTypeMutations,
  type CustomDeductionType,
} from "@/hooks/payroll/useCustomDeductionTypes";
import { CustomDeductionDialog } from "@/components/payroll/CustomDeductionDialog";

const RELATED: Array<{ to: string; label: string; description: string }> = [
  { to: "/hr/payroll/loans",                     label: "Loans",             description: "Amortised recovery with priority + skip-overrides." },
  { to: "/hr/payroll/garnishments",              label: "Garnishments",      description: "Court-ordered with priority + carry-forward." },
  { to: "/hr/payroll/statutory-rules",           label: "Statutory rules",   description: "PAYE, SHIF, NSSF, levies." },
  { to: "/hr/payroll/configuration/structures",  label: "Salary structures", description: "Rule graph for allowances + bespoke formulas." },
];

export default function CustomDeductions() {
  const { data: types = [], isLoading } = useCustomDeductionTypes({ includeInactive: true });
  const { archive } = useCustomDeductionTypeMutations();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CustomDeductionType | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<CustomDeductionType | null>(null);

  const unmapped = types.filter(
    (t) => t.is_active && (!t.gl_liability_account_id || (t.is_employer_contribution && !t.gl_expense_account_id)),
  );

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="page-header">
        <div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
            <Link to="/hr/payroll/configuration" className="flex items-center gap-1 hover:text-foreground">
              <ArrowLeft className="h-3 w-3" /> Configuration
            </Link>
          </div>
          <h1 className="page-title">Custom deductions</h1>
          <p className="text-sm sm:text-base text-muted-foreground max-w-3xl">
            Workspace-defined ad-hoc deductions (gym, SACCO, parking, uniform).
            Not for loans, advances, garnishments, statutory items or benefits — each
            of those has a first-class module.
          </p>
        </div>
        <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
          <Plus className="h-4 w-4 mr-2" /> New deduction type
        </Button>
      </div>

      {unmapped.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{unmapped.length} type{unmapped.length > 1 ? "s" : ""} missing GL mapping</AlertTitle>
          <AlertDescription>
            Payroll posting will fail for runs containing these types until a
            liability {`(and expense, for employer contributions)`} account is set:
            {" "}{unmapped.map((t) => t.code).join(", ")}.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Type catalog</CardTitle>
          <CardDescription>
            Each row here is a definition. To attach one to an employee use the
            "Custom deductions" tab on the employee profile.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : types.length === 0 ? (
            <div className="py-8 text-center space-y-3">
              <Info className="h-8 w-8 mx-auto text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No custom deduction types yet. Before adding one, confirm the
                deduction isn't already covered by:
              </p>
              <div className="grid grid-cols-2 gap-2 max-w-lg mx-auto">
                {RELATED.map((r) => (
                  <Link
                    key={r.to} to={r.to}
                    className="text-left rounded-md border p-2 hover:bg-accent transition"
                  >
                    <div className="text-sm font-medium flex items-center gap-1">
                      {r.label} <ExternalLink className="h-3 w-3" />
                    </div>
                    <div className="text-xs text-muted-foreground">{r.description}</div>
                  </Link>
                ))}
              </div>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Tax</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>GL</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {types.map((t) => {
                  const mapped =
                    !!t.gl_liability_account_id &&
                    (!t.is_employer_contribution || !!t.gl_expense_account_id);
                  return (
                    <TableRow key={t.id} className={!t.is_active ? "opacity-50" : ""}>
                      <TableCell className="font-mono text-xs">{t.code}</TableCell>
                      <TableCell>
                        <div className="font-medium">{t.label}</div>
                        {t.description && <div className="text-xs text-muted-foreground">{t.description}</div>}
                      </TableCell>
                      <TableCell><Badge variant="outline">{t.deduction_kind}</Badge></TableCell>
                      <TableCell>
                        <Badge variant={t.tax_treatment === "pre_tax" ? "default" : "secondary"}>
                          {t.tax_treatment}
                        </Badge>
                        {t.is_employer_contribution && <Badge className="ml-1" variant="outline">employer</Badge>}
                      </TableCell>
                      <TableCell className="text-xs">{t.computation_method}</TableCell>
                      <TableCell>
                        {mapped
                          ? <Badge variant="outline" className="text-green-700 border-green-700">mapped</Badge>
                          : <Badge variant="destructive">unmapped</Badge>}
                      </TableCell>
                      <TableCell>
                        {t.is_active
                          ? <Badge>active</Badge>
                          : <Badge variant="outline">archived</Badge>}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => { setEditing(t); setDialogOpen(true); }}>
                          <Edit2 className="h-3 w-3" />
                        </Button>
                        {t.is_active && (
                          <Button variant="ghost" size="sm" onClick={() => setArchiveTarget(t)}>
                            <Archive className="h-3 w-3" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <CustomDeductionDialog open={dialogOpen} onOpenChange={setDialogOpen} editing={editing} />

      <AlertDialog open={!!archiveTarget} onOpenChange={(o) => !o && setArchiveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive "{archiveTarget?.label}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Existing employee assignments remain and continue to recover under
              the current configuration. The type is hidden from new-assignment
              pickers. Payroll history is preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (archiveTarget) await archive.mutateAsync(archiveTarget.id);
                setArchiveTarget(null);
              }}
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
