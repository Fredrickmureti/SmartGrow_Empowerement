/**
 * Full-page "Add Employee" — the Odoo-grade alternative to the modal.
 *
 * Lifecycle (after the redesign):
 *   - Typing never hits the DB. The form keeps a local crash-recovery copy
 *     in localStorage (handled inside EmployeeFormDialog).
 *   - "Save as draft" creates a `lifecycle_status='draft'` row in one
 *     transactional RPC (`create_employee_with_identifiers`).
 *   - "Create" calls a single `finalize_employee_draft` RPC that applies the
 *     final field values + identifier replacement + status flip in one
 *     transaction. No more update-then-promote split, no contradictory
 *     "updated successfully" + "could not save" toast pair.
 */
import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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

import { useToast } from "@/hooks/use-toast";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useEmployees } from "@/hooks/useEmployees";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { normalizeError } from "@/services/resilience";
import { supabase } from "@/integrations/supabase/client";

import {
  EmployeeFormDialog,
  type EmployeeFormData,
} from "@/components/employees/EmployeeFormDialog";
import { saveEmployeeForm } from "@/lib/hr/saveEmployeeForm";
import { buildEmployeePayload } from "@/lib/hr/buildEmployeePayload";

export default function EmployeeNewPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  // `useEmployees` is needed for the create-without-draft path
  // (`saveEmployeeForm`) which uses the hook's `updateEmployee` only in
  // edit mode. Disabled to avoid an extra list fetch on this page.
  const { updateEmployee } = useEmployees({ enabled: false });

  const [dirty, setDirty] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const guard = useUnsavedChangesGuard(dirty);

  const createDraft = useCallback(
    async (form: EmployeeFormData): Promise<string | null> => {
      if (draftId) return draftId;
      try {
        const countryCode = (currentBusiness?.country || "").toUpperCase().trim();
        const { employeeId } = await saveEmployeeForm({
          form,
          editingEmployee: null,
          organizationId: currentOrg?.id ?? null,
          businessId: currentBusiness?.id ?? null,
          countryCode,
          updateEmployee,
          asDraft: true,
        });
        setDraftId(employeeId);
        toast({
          title: "Draft saved",
          description: "You can find it under My drafts in your user menu.",
        });
        return employeeId;
      } catch (err: any) {
        toast({
          title: "Could not save draft",
          description: normalizeError(err).message,
          variant: "destructive",
        });
        throw err;
      }
    },
    [draftId, currentOrg?.id, currentBusiness?.id, currentBusiness?.country, updateEmployee, toast],
  );

  const handleSubmit = useCallback(
    async (form: EmployeeFormData) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      try {
        const countryCode = (currentBusiness?.country || "").toUpperCase().trim();

        // Path A: a server-side draft already exists → atomic finalize.
        if (draftId) {
          const payload = buildEmployeePayload(form, {
            user_id: null,
            manager_id: null,
          }) as Record<string, unknown>;
          const identifiers = Object.entries(form.statutory_identifiers ?? {})
            .filter(([, v]) => (v ?? "").trim() !== "")
            .map(([identifier_type, identifier_value]) => ({
              identifier_type,
              identifier_value: identifier_value as string,
            }));
          if (identifiers.length > 0 && !countryCode) {
            throw new Error(
              "Set the company country in Settings before saving statutory identifiers.",
            );
          }
          const { error } = await supabase.rpc("finalize_employee_draft" as any, {
            p_employee_id: draftId,
            p_employee: { ...payload, _country_code: countryCode || null },
            p_identifiers: identifiers,
          });
          if (error) throw error;
          toast({ title: "Employee created" });
          setDirty(false);
          setTimeout(() => navigate(`/hr/employees/${draftId}`), 0);
          return;
        }

        // Path B: no draft → create-active in a single transactional RPC.
        const { employeeId } = await saveEmployeeForm({
          form,
          editingEmployee: null,
          organizationId: currentOrg?.id ?? null,
          businessId: currentBusiness?.id ?? null,
          countryCode,
          updateEmployee,
        });
        toast({ title: "Employee created" });
        setDirty(false);
        setTimeout(() => navigate(`/hr/employees/${employeeId}`), 0);
      } catch (err: any) {
        toast({
          title: "Could not save employee",
          description: normalizeError(err).message,
          variant: "destructive",
        });
        throw err;
      } finally {
        submittingRef.current = false;
      }
    },
    [draftId, currentOrg?.id, currentBusiness?.id, currentBusiness?.country, updateEmployee, toast, navigate],
  );

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div>
            <Button
              variant="ghost"
              size="sm"
              className="-ml-3 mb-2 text-muted-foreground hover:text-foreground"
              onClick={() => navigate("/hr/employees")}
            >
              <ArrowLeft className="h-4 w-4 mr-1" /> Back to employees
            </Button>
            <h1 className="page-title">Add Employee</h1>
            <p className="text-sm sm:text-base text-muted-foreground">
              Create a new employee record. Use "Save as draft" to keep an
              unfinished record under My drafts, or "Create" to publish.
            </p>
          </div>
        </div>

        <Card>
          <CardContent className="p-4 sm:p-6">
            <EmployeeFormDialog
              renderAs="page"
              open
              onOpenChange={(next) => {
                if (!next) navigate("/hr/employees");
              }}
              editingEmployee={null}
              onSubmit={handleSubmit}
              onSaveAsDraft={(form) => createDraft(form).then(() => undefined)}
              onDirtyChange={setDirty}
              draftId={draftId}
              onDiscardDraft={async (id) => {
                // Hard-delete the server-side draft so it does not leak
                // into the 30-day stale-draft cron sweep. The local form
                // is reset by the dialog regardless of this RPC's outcome.
                const { error } = await supabase.rpc("discard_employee_draft" as any, {
                  p_employee_id: id,
                });
                if (error) {
                  toast({
                    title: "Could not discard draft",
                    description: normalizeError(error).message,
                    variant: "destructive",
                  });
                  throw error;
                }
                setDraftId(null);
                setDirty(false);
                toast({ title: "Draft discarded" });
              }}
            />

          </CardContent>
        </Card>
      </div>

      <AlertDialog open={guard.isBlocked} onOpenChange={(o) => { if (!o) guard.cancel(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes on this employee. {draftId
                ? "Your server-side draft is up to date with your last explicit save; any later edits will be lost."
                : "Your local draft will be available the next time you open the Add Employee page."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={guard.cancel}>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={guard.confirm}>Leave page</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
