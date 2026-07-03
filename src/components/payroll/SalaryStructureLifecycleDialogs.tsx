/**
 * Salary-structure lifecycle dialogs — Edit / Archive / Restore / Delete.
 *
 * Enterprise ERP pattern (SAP HCM, Workday, Oracle HCM):
 *  - Metadata (name/code/description) is freely editable and audited.
 *  - Archive is the everyday "delete" — reversible, structure stays queryable
 *    for history but disappears from assign-to-contract pickers.
 *  - Hard delete is gated behind a preflight that enumerates blockers
 *    (contracts, payslips, in-flight runs) plus a type-the-name confirmation.
 *
 * All state transitions go through SECURITY DEFINER RPCs; this component
 * never mutates `salary_structures` directly.
 */
import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Loader2, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import {
  useSalaryStructures,
  useSalaryStructureDeletionReport,
} from "@/hooks/useSalaryStructures";

interface EditProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  structure: { id: string; name: string; code: string | null; description: string | null };
}

export function EditSalaryStructureSheet({ open, onOpenChange, structure }: EditProps) {
  const { renameStructure } = useSalaryStructures();
  const [name, setName] = useState(structure.name);
  const [code, setCode] = useState(structure.code ?? "");
  const [description, setDescription] = useState(structure.description ?? "");

  const save = async () => {
    if (!name.trim()) return;
    await renameStructure.mutateAsync({
      id: structure.id,
      name: name.trim(),
      code: code.trim() || null,
      description: description,
    });
    onOpenChange(false);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (v) {
          setName(structure.name);
          setCode(structure.code ?? "");
          setDescription(structure.description ?? "");
        }
      }}
    >
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Edit salary structure</SheetTitle>
          <SheetDescription>
            Metadata changes are always allowed. Component and rate changes go through
            "Publish version" so historical payslips stay accurate.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-1.5">
            <Label htmlFor="ss-name">Name</Label>
            <Input id="ss-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ss-code">Code</Label>
            <Input id="ss-code" value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ss-description">Description</Label>
            <Textarea
              id="ss-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
            />
          </div>
        </div>
        <SheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!name.trim() || renameStructure.isPending}>
            {renameStructure.isPending && (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            )}
            Save changes
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

interface ArchiveProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  structure: { id: string; name: string };
}

export function ArchiveSalaryStructureDialog({ open, onOpenChange, structure }: ArchiveProps) {
  const { archiveStructure } = useSalaryStructures();
  const [reason, setReason] = useState("");
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive "{structure.name}"?</AlertDialogTitle>
          <AlertDialogDescription>
            Archived structures stay in history and remain readable on past payslips,
            but they can no longer be assigned to new contracts. You can restore an
            archived structure at any time.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="archive-reason">Reason (optional)</Label>
          <Textarea
            id="archive-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="e.g. Replaced by 2026 unified structure"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={archiveStructure.isPending}
            onClick={async (e) => {
              e.preventDefault();
              await archiveStructure.mutateAsync({
                id: structure.id,
                reason: reason.trim() || undefined,
              });
              setReason("");
              onOpenChange(false);
            }}
          >
            {archiveStructure.isPending && (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            )}
            Archive
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface DeleteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  structure: { id: string; name: string; is_active: boolean };
}

export function DeleteSalaryStructureDialog({ open, onOpenChange, structure }: DeleteProps) {
  const { deleteStructure } = useSalaryStructures();
  const report = useSalaryStructureDeletionReport(open ? structure.id : null);
  const [confirmName, setConfirmName] = useState("");

  const r = report.data;
  const nameMatches = confirmName.trim() === structure.name;
  const canDelete = !!r?.can_delete && nameMatches;

  const Row = ({
    ok,
    label,
    detail,
  }: {
    ok: boolean;
    label: string;
    detail?: string;
  }) => (
    <div className="flex items-start gap-2 text-sm">
      {ok ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
      ) : (
        <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
      )}
      <div className="flex-1">
        <div className={ok ? "" : "font-medium"}>{label}</div>
        {detail && <div className="text-xs text-muted-foreground">{detail}</div>}
      </div>
    </div>
  );

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) setConfirmName("");
      }}
    >
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            Permanently delete "{structure.name}"?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This is irreversible. All rule versions, components, and rule graphs
            attached to this structure will be removed. Historical payslips are
            preserved but will lose their live link back to this structure.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 rounded-md border p-3 bg-muted/30">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Preflight checks
          </div>
          {report.isLoading || !r ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading deletion report…
            </div>
          ) : (
            <>
              <Row
                ok={r.is_archived}
                label="Structure is archived"
                detail={
                  r.is_archived
                    ? undefined
                    : "Archive the structure before deleting."
                }
              />
              <Row
                ok={r.contract_count === 0}
                label={`No employee contracts reference this structure`}
                detail={
                  r.contract_count === 0
                    ? undefined
                    : `${r.contract_count} contract${r.contract_count === 1 ? "" : "s"} still reference it. Reassign or end those contracts first.`
                }
              />
              <Row
                ok={r.payslip_count === 0}
                label="No historical payslips reference this structure"
                detail={
                  r.payslip_count === 0
                    ? undefined
                    : `${r.payslip_count} payslip${r.payslip_count === 1 ? "" : "s"} exist. Historical payroll data must be retained — deletion is blocked.`
                }
              />
              <Row
                ok={r.active_run_count === 0}
                label="No in-flight payroll runs"
                detail={
                  r.active_run_count === 0
                    ? undefined
                    : `${r.active_run_count} run${r.active_run_count === 1 ? "" : "s"} still processing. Wait for them to complete.`
                }
              />
            </>
          )}
        </div>

        {r?.can_delete && (
          <div className="space-y-1.5">
            <Label htmlFor="confirm-name">
              Type <span className="font-mono">{structure.name}</span> to confirm
            </Label>
            <Input
              id="confirm-name"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={structure.name}
              autoComplete="off"
            />
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!canDelete || deleteStructure.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={async (e) => {
              e.preventDefault();
              await deleteStructure.mutateAsync({
                id: structure.id,
                confirmName: confirmName.trim(),
              });
              setConfirmName("");
              onOpenChange(false);
            }}
          >
            {deleteStructure.isPending && (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            )}
            Delete permanently
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
