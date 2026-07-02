import { PayrollRun } from "@/hooks/usePayroll";
import { useCurrency } from "@/hooks/useCurrency";
import { usePermissions } from "@/hooks/usePermissions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eye, CheckCircle, DollarSign, Calculator, Loader2, BookOpen, ClipboardCheck, Trash2, AlertTriangle, RotateCcw, ExternalLink } from "lucide-react";
import { format } from "date-fns";
import { Link } from "react-router-dom";
import { useState } from "react";
import { useGenerateAttendanceWorkEntries } from "@/hooks/payroll/useGenerateAttendanceWorkEntries";
import { canReverseRun, getLineageBadge } from "@/lib/payroll/runLifecycle";
interface PayrollRunListProps {
  runs: PayrollRun[];
  isLoading: boolean;
  currencyReady: boolean;
  onViewDetails: (run: PayrollRun) => void;
  onApprove: (run: PayrollRun) => void;
  onPostToGL: (run: PayrollRun) => void;
  onMarkPaid: (run: PayrollRun) => void;
  onDelete?: (run: PayrollRun) => Promise<void> | void;
  /** Reverse a posted/paid run (opens ReversePayrollDialog in the parent). */
  onReverse?: (run: PayrollRun) => void;
  /** Run id currently being posted to GL — disables Post buttons + shows spinner. */
  postingRunId?: string | null;
}

const getStatusBadge = (status: PayrollRun["status"]) => {
  const styles: Record<string, string> = {
    draft: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200",
    processing: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
    processed: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    approved: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    posted: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200",
    paid: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200",
    cancelled: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  };
  const label = status === "posted" ? "GL Posted" : status;
  return <Badge className={styles[status] || ""}>{label}</Badge>;
};

export function PayrollRunList({ runs, isLoading, currencyReady, onViewDetails, onApprove, onPostToGL, onMarkPaid, onDelete, onReverse, postingRunId }: PayrollRunListProps) {
  const { formatCurrency } = useCurrency();
  const generate = useGenerateAttendanceWorkEntries();
  // SoD-aware permissions: discard requires `runPayroll`, reversal requires `postPayrollGL`.
  const { canRunPayroll, canPostPayrollGL } = usePermissions();
  const [confirmDelete, setConfirmDelete] = useState<PayrollRun | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [typedConfirm, setTypedConfirm] = useState("");

  const requiresTyping = confirmDelete && confirmDelete.status !== "draft";
  const typedMatches = !requiresTyping || typedConfirm.trim() === confirmDelete?.payroll_number;

  const openConfirm = (run: PayrollRun) => {
    setTypedConfirm("");
    setConfirmDelete(run);
  };
  const closeConfirm = () => {
    setConfirmDelete(null);
    setTypedConfirm("");
  };

  const handleDeleteConfirmed = async () => {
    if (!confirmDelete || !onDelete || !typedMatches) return;
    setIsDeleting(true);
    try {
      await onDelete(confirmDelete);
      closeConfirm();
    } finally {
      setIsDeleting(false);
    }
  };

  if (isLoading || !currencyReady) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (runs.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center px-4">
          <Calculator className="h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium">No payroll runs found</h3>
          <p className="text-muted-foreground text-sm">Create your first payroll run to get started.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
    <Card>
      <CardContent className="p-0">
        {/* Mobile */}
        <div className="md:hidden p-3 space-y-3">
          {runs.map((run) => (
            <div key={run.id} className="border rounded-lg p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm">{run.payroll_number}</div>
                  <div className="text-xs text-muted-foreground">
                    {format(new Date(run.pay_period_start), "MMM d")} - {format(new Date(run.pay_period_end), "MMM d, yyyy")}
                  </div>
                </div>
                {getStatusBadge(run.status)}
              </div>
              <div className="flex items-center justify-between gap-2 pt-1 border-t flex-wrap">
                <span className="text-xs min-w-0 break-all"><span className="text-muted-foreground">Gross: </span><span className="font-medium">{formatCurrency(run.total_gross)}</span></span>
                <span className="text-sm font-semibold min-w-0 break-all">Net: {formatCurrency(run.total_net)}</span>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button variant="outline" size="sm" className="flex-1" onClick={() => onViewDetails(run)}>
                  <Eye className="h-4 w-4 mr-1" /> View
                </Button>
                <Button asChild variant="outline" size="sm" title="Open work entries for this run">
                  <Link to={`/timesheets/work-entries?run_id=${run.id}`}>
                    <ExternalLink className="h-4 w-4" />
                  </Link>
                </Button>
                {run.status === "draft" && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => generate.mutate(run.id)}
                      disabled={generate.isPending}
                      title="Sync attendance into payroll work entries"
                    >
                      {generate.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardCheck className="h-4 w-4" />}
                    </Button>
                    <Button variant="outline" size="sm" className="flex-1" onClick={() => onApprove(run)}>
                      <CheckCircle className="h-4 w-4 mr-1" /> Approve
                    </Button>
                    {onDelete && canRunPayroll && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => openConfirm(run)}
                        title="Delete draft"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </>
                )}

                {run.status === "approved" && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => onPostToGL(run)}
                      disabled={postingRunId === run.id}
                    >
                      {postingRunId === run.id ? (
                        <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Posting…</>
                      ) : (
                        <><BookOpen className="h-4 w-4 mr-1" /> Post GL</>
                      )}
                    </Button>
                    {onDelete && canRunPayroll && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => openConfirm(run)}
                        title="Delete approved (pre-GL) run"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </>
                )}
                {run.status === "posted" && (
                  <Button variant="outline" size="sm" className="flex-1" onClick={() => onMarkPaid(run)}>
                    <DollarSign className="h-4 w-4 mr-1" /> Mark Paid
                  </Button>
                )}
                {onReverse && canPostPayrollGL && canReverseRun(run).allowed && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive shrink-0"
                    onClick={() => onReverse(run)}
                    title="Reverse run"
                    aria-label="Reverse run"
                  >
                    <RotateCcw className="h-4 w-4" />
                  </Button>
                )}
                {(() => {
                  const badge = getLineageBadge(run);
                  return badge ? (
                    <Badge variant={badge.variant} className="text-[10px] shrink-0">
                      {badge.label}
                    </Badge>
                  ) : null;
                })()}
              </div>
            </div>
          ))}
        </div>

        {/* Desktop */}
        <div className="hidden md:block table-container">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Payroll #</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Payment Date</TableHead>
                <TableHead>Employees</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total Gross</TableHead>
                <TableHead className="text-right">Total Net</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell className="font-medium">{run.payroll_number}</TableCell>
                  <TableCell>
                    {format(new Date(run.pay_period_start), "MMM d")} - {format(new Date(run.pay_period_end), "MMM d, yyyy")}
                  </TableCell>
                  <TableCell>{run.payment_date ? format(new Date(run.payment_date), "MMM d, yyyy") : "—"}</TableCell>
                  <TableCell>{run.employee_count}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {getStatusBadge(run.status)}
                      {(() => {
                        const badge = getLineageBadge(run);
                        return badge ? (
                          <Badge variant={badge.variant} className="text-[10px]">{badge.label}</Badge>
                        ) : null;
                      })()}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">{formatCurrency(run.total_gross)}</TableCell>
                  <TableCell className="text-right font-medium">{formatCurrency(run.total_net)}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" onClick={() => onViewDetails(run)} title="View Details">
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button asChild variant="ghost" size="icon" title="Open work entries for this run">
                        <Link to={`/timesheets/work-entries?run_id=${run.id}`}>
                          <ExternalLink className="h-4 w-4" />
                        </Link>
                      </Button>
                      {run.status === "draft" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => generate.mutate(run.id)}
                          disabled={generate.isPending}
                          title="Sync attendance → work entries"
                        >
                          {generate.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardCheck className="h-4 w-4" />}
                        </Button>
                      )}
                      {run.status === "draft" && (
                        <Button variant="ghost" size="icon" onClick={() => onApprove(run)} title="Approve">
                          <CheckCircle className="h-4 w-4" />
                        </Button>
                      )}
                      {(run.status === "draft" || run.status === "approved") && onDelete && canRunPayroll && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive"
                          onClick={() => openConfirm(run)}
                          title={run.status === "draft" ? "Delete draft" : "Delete approved (pre-GL) run"}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                      {run.status === "approved" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onPostToGL(run)}
                          title="Post to GL"
                          disabled={postingRunId === run.id}
                        >
                          {postingRunId === run.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <BookOpen className="h-4 w-4" />
                          )}
                        </Button>
                      )}
                      {run.status === "posted" && (
                        <Button variant="ghost" size="icon" onClick={() => onMarkPaid(run)} title="Mark Paid">
                          <DollarSign className="h-4 w-4" />
                        </Button>
                      )}
                      {onReverse && canPostPayrollGL && canReverseRun(run).allowed && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive"
                          onClick={() => onReverse(run)}
                          title="Reverse run"
                        >
                          <RotateCcw className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>

    <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && closeConfirm()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {requiresTyping && <AlertTriangle className="h-5 w-5 text-destructive" />}
            {confirmDelete?.status === "draft"
              ? "Delete draft payroll run?"
              : "Delete approved payroll run?"}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                This permanently removes <span className="font-medium text-foreground">{confirmDelete?.payroll_number}</span>
                {" "}and all its payslips ({confirmDelete?.employee_count ?? 0} employee{(confirmDelete?.employee_count ?? 0) === 1 ? "" : "s"}).
                {" "}This action cannot be undone.
              </p>
              {requiresTyping ? (
                <p className="text-destructive">
                  This run has already been <span className="font-semibold">approved</span>. Deletion is allowed only because
                  it has <span className="font-semibold">not yet been posted to the General Ledger</span>. Once posted or paid,
                  it can only be reversed.
                </p>
              ) : (
                <p>Approved, posted, or paid runs must be reversed instead.</p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {requiresTyping && (
          <div className="space-y-2">
            <Label htmlFor="payroll-delete-confirm">
              Type <span className="font-mono font-semibold">{confirmDelete?.payroll_number}</span> to confirm
            </Label>
            <Input
              id="payroll-delete-confirm"
              autoComplete="off"
              autoFocus
              value={typedConfirm}
              onChange={(e) => setTypedConfirm(e.target.value)}
              placeholder={confirmDelete?.payroll_number}
            />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); handleDeleteConfirmed(); }}
            disabled={isDeleting || !typedMatches}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
            {confirmDelete?.status === "draft" ? "Delete draft" : "Delete approved run"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
