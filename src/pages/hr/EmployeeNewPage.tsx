/**
 * Full-page "Add Employee" — now hosted on `RecordFormShell` so it matches
 * every other create route in the ERP (Contacts, Finance accounts, etc.).
 *
 * The heavy lifting still lives inside `EmployeeFormDialog` (tabs, draft
 * autosave, validation, statutory identifiers). This page:
 *   - hosts the shell header ("New record" eyebrow + "New Employee" title)
 *   - hosts the shell footer (Cancel · Save as draft · Create Employee)
 *   - drives the dialog imperatively via `actionsRef`
 *   - keeps the same server-side draft + finalize RPC flow
 */
import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Save, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
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

import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import {
  EmployeeFormDialog,
  type EmployeeFormActions,
  type EmployeeFormData,
} from "@/components/employees/EmployeeFormDialog";
import { saveEmployeeForm } from "@/lib/hr/saveEmployeeForm";
import { buildEmployeePayload } from "@/lib/hr/buildEmployeePayload";

export default function EmployeeNewPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { updateEmployee } = useEmployees({ enabled: false });

  const [dirty, setDirty] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [draftState, setDraftState] = useState<{
    hasSavedDraft: boolean;
    isSavingDraft: boolean;
  }>({ hasSavedDraft: false, isSavingDraft: false });

  const submittingRef = useRef(false);
  const actionsRef = useRef<EmployeeFormActions | null>(null);
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

  const handleDiscardServerDraft = useCallback(
    async (id: string) => {
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
    },
    [toast],
  );

  const { hasSavedDraft, isSavingDraft } = draftState;
  const showDiscard = hasSavedDraft || draftId !== null;

  const meta = hasSavedDraft ? (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Save className="h-3 w-3" /> Draft saved
    </span>
  ) : null;

  return (
    <>
      <RecordFormShell
        mode="create"
        entityLabel="Employee"
        meta={meta}
        cancelHref="/hr/employees"
        submitLabel="Create Employee"
        isSubmitting={isSubmitting}
        onSubmit={(e) => {
          e.preventDefault();
          actionsRef.current?.submit();
        }}
        extraLeadingActions={
          showDiscard ? (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={isSubmitting || isSavingDraft}
              onClick={() => actionsRef.current?.discardDraft()}
            >
              <Trash2 className="h-4 w-4 mr-2" /> Discard draft
            </Button>
          ) : null
        }
        extraTrailingActions={
          <Button
            type="button"
            variant="secondary"
            disabled={isSubmitting || isSavingDraft}
            onClick={() => actionsRef.current?.saveAsDraft()}
          >
            Save as draft
          </Button>
        }
      >
        <EmployeeFormDialog
          renderAs="page"
          hideInlineFooter
          hideInlineForm
          actionsRef={actionsRef}
          open
          onOpenChange={(next) => {
            if (!next) navigate("/hr/employees");
          }}
          editingEmployee={null}
          onSubmit={handleSubmit}
          onSaveAsDraft={(form) => createDraft(form).then(() => undefined)}
          onDirtyChange={setDirty}
          onSubmittingChange={setIsSubmitting}
          onDraftStateChange={setDraftState}
          draftId={draftId}
          onDiscardDraft={handleDiscardServerDraft}
        />
      </RecordFormShell>

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
