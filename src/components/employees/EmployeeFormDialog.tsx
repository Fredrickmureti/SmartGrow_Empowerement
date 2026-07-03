/**
 * Employee Form Dialog (self-owning state)
 *
 * Stage 3 refactor: this dialog now owns its own form state. Parent only passes
 * `editingEmployee` (or null for create) and an async `onSubmit(data)` callback.
 * The previous design forced the page to duplicate ~250 lines of state.
 *
 * Stage 2.1 cleanup: writes `job_position_id` (catalog) instead of free-text
 * `position` and `work_location_id`. Existing employees with only `position`
 * text continue to display via the catalog backfill done in migration
 * 20260504161404_…
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WorkflowSheet } from "@/components/workflow/WorkflowSheet";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, Mail, Link as LinkIcon, UserPlus, Shield, Info, ArrowRight, Save, Trash2 } from "lucide-react";
import { CustomFieldsSection } from "@/components/studio/CustomFieldsSection";
import type { Employee } from "@/hooks/useEmployees";
import type { Department } from "@/hooks/useDepartments";
import { useJobPositions } from "@/hooks/useJobPositions";
import { useWorkLocations } from "@/hooks/useWorkLocations";
import { useDepartments } from "@/hooks/useDepartments";
import { useEmployeeStatutoryIdentifiers } from "@/hooks/employees/useEmployeeStatutoryIdentifiers";
import { useEmployeeRequirements } from "@/hooks/hr/useEmployeeRequirements";
import { useBusinessModules } from "@/hooks/hr/useBusinessModules";
import { useOrganization } from "@/hooks/useOrganization";

export interface EmployeeFormData {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  national_id: string;
  // Statutory identifiers are managed via `employee_statutory_identifiers`
  // and rendered through dynamic field config (`useEmployeeFields`).
  hire_date: string;
  termination_date: string | null;
  department_id: string;
  job_position_id: string;
  work_location_id: string;
  employment_type: string;
  bank_name: string;
  bank_branch: string;
  bank_account_number: string;
  bank_code: string;
  is_active: boolean;
  gender: string;
  date_of_birth: string;
  work_email: string;
  personal_phone: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  emergency_contact_relationship: string;
  marital_status: string;
  address_line1: string;
  address_line2: string;
  city: string;
  county: string;
  postal_code: string;
  country: string;
  /** Statutory identifier values keyed by field_key (e.g. tax_pin, nssf_number).
   *  Persisted to `employee_statutory_identifiers` by the page after submit. */
  statutory_identifiers: Record<string, string>;
}

const emptyForm = (): EmployeeFormData => ({
  first_name: "",
  last_name: "",
  email: "",
  phone: "",
  national_id: "",
  // Intentionally blank — the field is `required` and must be set explicitly.
  // Auto-defaulting to today silently mis-dates employees whose contract
  // starts earlier (e.g. backfilled records), which then breaks payroll
  // proration. See plan P0 step 2.
  hire_date: "",
  termination_date: null,
  department_id: "",
  job_position_id: "",
  work_location_id: "",
  employment_type: "full_time",
  bank_name: "",
  bank_branch: "",
  bank_account_number: "",
  bank_code: "",
  is_active: true,
  gender: "",
  date_of_birth: "",
  work_email: "",
  personal_phone: "",
  emergency_contact_name: "",
  emergency_contact_phone: "",
  emergency_contact_relationship: "",
  marital_status: "",
  address_line1: "",
  address_line2: "",
  city: "",
  county: "",
  postal_code: "",
  country: "",
  statutory_identifiers: {},
});

const fromEmployee = (e: Employee): EmployeeFormData => ({
  ...emptyForm(),
  first_name: e.first_name,
  last_name: e.last_name,
  email: e.email || "",
  phone: e.phone || "",
  national_id: e.national_id || "",
  hire_date: e.hire_date,
  termination_date: e.termination_date,
  department_id: e.department_id || "",
  job_position_id: (e as any).job_position_id || "",
  work_location_id: (e as any).work_location_id || "",
  employment_type: e.employment_type,
  bank_name: e.bank_name || "",
  bank_branch: e.bank_branch || "",
  bank_account_number: e.bank_account_number || "",
  bank_code: e.bank_code || "",
  is_active: e.is_active,
  gender: (e as any).gender || "",
  date_of_birth: (e as any).date_of_birth || "",
  work_email: (e as any).work_email || "",
  personal_phone: (e as any).personal_phone || "",
  emergency_contact_name: (e as any).emergency_contact_name || "",
  emergency_contact_phone: (e as any).emergency_contact_phone || "",
  emergency_contact_relationship: (e as any).emergency_contact_relationship || "",
  marital_status: (e as any).marital_status || "",
  address_line1: (e as any).address_line1 || "",
  address_line2: (e as any).address_line2 || "",
  city: (e as any).city || "",
  county: (e as any).county || "",
  postal_code: (e as any).postal_code || "",
  country: (e as any).country || "",
});

export interface EmployeeFormActions {
  submit: () => Promise<void>;
  saveAsDraft: () => Promise<void>;
  discardDraft: () => Promise<void>;
}

interface EmployeeFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingEmployee: Employee | null;
  onSubmit: (data: EmployeeFormData) => Promise<void>;
  onInvite?: (employee: Employee) => void;
  onLink?: (employee: Employee) => void;
  onSetManager?: (employee: Employee) => void;
  /**
   * Rendering mode.
   *  - "dialog" (default): wrap the form in a Radix Dialog (legacy modal).
   *  - "page": render the form body inline, suitable for a full-page route.
   *    The page is responsible for its own header, breadcrumbs, navigation
   *    blocker, and close behaviour (passed via `onOpenChange(false)`).
   */
  renderAs?: "dialog" | "page";
  /** Notifies the parent page when the form's dirty flag changes. Used by
   *  the full-page route to install a router-level navigation blocker. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Optional "Save as draft" handler. When provided AND in page mode, a
   *  secondary button is shown that calls this with the current form data
   *  without any validation. Used to create a server-side draft row. */
  onSaveAsDraft?: (data: EmployeeFormData) => Promise<void>;
  /** Existing server-side draft row id. When set, the form runs per-section
   *  debounced autosave directly against this row. */
  draftId?: string | null;
  /** Invoked when the user explicitly discards an existing server-side
   *  draft (via the Discard button or the unsaved-changes guard). The
   *  page is responsible for calling `discard_employee_draft` RPC so the
   *  row is hard-deleted instead of leaking into the 30-day cron sweep.
   *  No-op when there is no draft id. */
  onDiscardDraft?: (draftId: string) => Promise<void>;
  /** When true (page mode only), suppress the inline action row so the host
   *  page can render Cancel/Submit/Save-as-draft inside a shared shell like
   *  `RecordFormShell`. */
  hideInlineFooter?: boolean;
  /** When true (page mode only), render the body inside a plain `<div>`
   *  instead of a `<form>`. Submit must be triggered imperatively via
   *  `actionsRef.current.submit()`. Prevents nested-form invalid HTML when
   *  the host shell already owns the outer `<form>`. */
  hideInlineForm?: boolean;
  /** Imperative handle exposing submit / saveAsDraft / discardDraft so a
   *  shell footer can wire buttons without duplicating validation. */
  actionsRef?: React.MutableRefObject<EmployeeFormActions | null>;
  /** Fires whenever internal `isSubmitting` flips. Lets the shell show a
   *  spinner on its primary Submit button. */
  onSubmittingChange?: (submitting: boolean) => void;
  /** Fires whenever local-draft state changes. Lets the shell decide
   *  whether to render "Discard draft" / show the "Draft saved" chip. */
  onDraftStateChange?: (s: { hasSavedDraft: boolean; isSavingDraft: boolean }) => void;
}

export function EmployeeFormDialog({
  open,
  onOpenChange,
  editingEmployee,
  onSubmit,
  onInvite,
  onLink,
  onSetManager,
  renderAs = "dialog",
  onDirtyChange,
  onSaveAsDraft,
  draftId,
  onDiscardDraft,
  hideInlineFooter = false,
  hideInlineForm = false,
  actionsRef,
  onSubmittingChange,
  onDraftStateChange,
}: EmployeeFormDialogProps) {

  const [activeTab, setActiveTab] = useState("personal");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [formData, setFormData] = useState<EmployeeFormData>(emptyForm());
  const formRef = useRef<HTMLFormElement | null>(null);
  const { activeDepartments } = useDepartments();
  const { activePositions } = useJobPositions();
  const { activeLocations } = useWorkLocations();
  const modules = useBusinessModules();
  const { statutory: statutoryRequirements } = useEmployeeRequirements({ module: "payroll" });
  const { data: existingIdentifiers } = useEmployeeStatutoryIdentifiers(
    open ? editingEmployee?.id : null,
  );
  const { currentOrg } = useOrganization();

  // ── Draft persistence + dirty tracking ─────────────────────────────────
  // Storage key scoped to org + mode so drafts don't leak across tenants
  // or between create/edit. Edit-mode drafts are NOT persisted (they could
  // overwrite remote changes); only the "Add new" path is autosaved.
  const draftKey = useMemo(() => {
    if (editingEmployee) return null;
    const org = currentOrg?.id ?? "no-org";
    return `employee-form-draft:v1:${org}:new`;
  }, [currentOrg?.id, editingEmployee]);

  // Snapshot of the seed state — what `formData` looks like before any user
  // input. We diff against this to compute `isDirty` so we can guard the
  // dialog from accidental dismissal.
  const initialSnapshotRef = useRef<string>(JSON.stringify(emptyForm()));
  // Bumping this version forces `isDirty` to recompute after we advance the
  // snapshot ref following a successful save. Without it, the memo would
  // keep returning the stale "dirty" result until the next formData change.
  const [snapshotVersion, setSnapshotVersion] = useState(0);
  const isDirty = useMemo(
    () => JSON.stringify(formData) !== initialSnapshotRef.current,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [formData, snapshotVersion],
  );

  // Advance the dirty baseline to the current form values. Called after a
  // successful Save Draft or Submit so the unsaved-changes guard stops
  // firing for values the server already has.
  const rebaselineDirty = (values: EmployeeFormData) => {
    initialSnapshotRef.current = JSON.stringify(values);
    setSnapshotVersion((v) => v + 1);
  };

  // Surface dirty state to the parent page (used by the full-page route to
  // install a react-router blocker + beforeunload warning).
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // Surface submit + draft state so a host shell can drive its own footer.
  useEffect(() => {
    onSubmittingChange?.(isSubmitting);
  }, [isSubmitting, onSubmittingChange]);
  useEffect(() => {
    onDraftStateChange?.({ hasSavedDraft, isSavingDraft });
  }, [hasSavedDraft, isSavingDraft, onDraftStateChange]);

  // ── Server-side draft autosave: removed ────────────────────────────────
  // Typing no longer triggers DB writes. Local-only debounced cache in
  // localStorage (below) is the crash-recovery story for unfilled forms.
  // Server-side persistence happens on explicit user actions only:
  //   - "Save as draft" → onSaveAsDraft (creates a draft row via RPC)
  //   - "Create"        → onSubmit (finalize_employee_draft RPC)
  // See plan: Employee module — lifecycle redesign.


  // Dismissal-guard state for the AlertDialog. We capture *what to do* when
  // the user confirms discarding (close, or close + invoke a handler).
  const [pendingClose, setPendingClose] = useState<null | (() => void)>(null);
  const [hasSavedDraft, setHasSavedDraft] = useState(false);

  // Show Statutory tab only when payroll is installed AND the installed
  // pack publishes at least one identifier requirement. No pack → no tab.
  const showStatutoryTab = modules.payroll && statutoryRequirements.length > 0;

  // Seed form when entering edit mode, or when switching between employees.
  // For "Add new", we hydrate from localStorage if a draft exists for this
  // org. The draft is reset only after a successful submit (handleSubmit)
  // or an explicit "Discard draft" click.
  useEffect(() => {
    if (!open) return;
    setActiveTab("personal");
    if (editingEmployee) {
      const seeded = fromEmployee(editingEmployee);
      initialSnapshotRef.current = JSON.stringify(seeded);
      setFormData(seeded);
      setHasSavedDraft(false);
      return;
    }
    // Add-new mode: try to restore a saved draft for this org.
    const seed = emptyForm();
    initialSnapshotRef.current = JSON.stringify(seed);
    if (draftKey && typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem(draftKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          setFormData({ ...seed, ...parsed });
          setHasSavedDraft(true);
          return;
        }
      } catch {
        // ignore — fall through to empty seed
      }
    }
    setFormData(seed);
    setHasSavedDraft(false);
  }, [open, editingEmployee?.id, draftKey]);

  // Debounced autosave of the current draft to localStorage. Only fires
  // in add-new mode (draftKey is null in edit mode), and only when dirty
  // so we don't write an empty draft on first open.
  useEffect(() => {
    if (!open || !draftKey || !isDirty) return;
    if (typeof window === "undefined") return;
    const handle = window.setTimeout(() => {
      try {
        window.localStorage.setItem(draftKey, JSON.stringify(formData));
        setHasSavedDraft(true);
      } catch {
        // quota / private mode — silent
      }
    }, 600);
    return () => window.clearTimeout(handle);
  }, [formData, open, draftKey, isDirty]);

  // Warn before unload if the user has unsaved changes in the dialog.
  useEffect(() => {
    if (!open || !isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [open, isDirty]);

  const clearDraft = () => {
    if (draftKey && typeof window !== "undefined") {
      try { window.localStorage.removeItem(draftKey); } catch { /* ignore */ }
    }
    setHasSavedDraft(false);
  };

  // Centralised "request close" entry point. If the form is dirty and we're
  // in add-new mode, prompt the user before discarding. Edit-mode closes go
  // through unchanged (their draft auto-persists to localStorage is off,
  // and edit-mode commonly has read-only history they can re-fetch).
  const requestClose = (next: () => void) => {
    if (isDirty && !editingEmployee) {
      setPendingClose(() => next);
      return;
    }
    next();
  };

  const handleDiscardDraft = async () => {
    // If a server-side draft row exists, hard-delete it via the RPC before
    // wiping the local form. Without this, "Discard" only clears the
    // localStorage cache and the lifecycle_status='draft' row leaks until
    // the 30-day stale-draft cron picks it up — exactly the accumulation
    // bug the architecture audit called out.
    if (draftId && onDiscardDraft) {
      try {
        await onDiscardDraft(draftId);
      } catch {
        // The page-level handler shows its own toast; swallow here so the
        // local form still resets and the user isn't stuck on a stale
        // draft they explicitly asked to discard.
      }
    }
    clearDraft();
    const seed = emptyForm();
    initialSnapshotRef.current = JSON.stringify(seed);
    setFormData(seed);
  };


  // Seed statutory identifiers once they load (edit mode). Keys come
  // from `identifier_type` and are matched against pack requirements
  // by the same key — no country switch, no hardcoded mapping.
  useEffect(() => {
    if (!open || !existingIdentifiers?.length) return;
    setFormData((prev) => {
      const seeded: Record<string, string> = { ...prev.statutory_identifiers };
      for (const row of existingIdentifiers) {
        if (!(row.identifier_type in seeded)) {
          seeded[row.identifier_type] = row.identifier_value ?? "";
        }
      }
      return { ...prev, statutory_identifiers: seeded };
    });
  }, [open, existingIdentifiers]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();

    if (formData.first_name.trim() === "" || formData.last_name.trim() === "") {
      setActiveTab("personal");
      window.requestAnimationFrame(() => formRef.current?.reportValidity?.());
      return;
    }

    if (formData.hire_date.trim() === "") {
      setActiveTab("employment");
      window.requestAnimationFrame(() => formRef.current?.reportValidity?.());
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmit(formData);
      if (!editingEmployee) {
        clearDraft();
        const seed = emptyForm();
        initialSnapshotRef.current = JSON.stringify(seed);
        setFormData(seed);
        setSnapshotVersion((v) => v + 1);
      } else {
        rebaselineDirty(formData);
      }
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Draft-save handler shared by the inline footer button and the imperative
  // actionsRef so a host shell can drive the same code path.
  const handleSaveAsDraft = async () => {
    if (!onSaveAsDraft) return;
    setIsSavingDraft(true);
    try {
      await onSaveAsDraft(formData);
      clearDraft();
      rebaselineDirty(formData);
    } finally {
      setIsSavingDraft(false);
    }
  };

  // Expose imperative actions so `RecordFormShell`-hosted footers can wire
  // Submit / Save-as-draft / Discard without duplicating validation.
  useEffect(() => {
    if (!actionsRef) return;
    actionsRef.current = {
      submit: () => handleSubmit(),
      saveAsDraft: handleSaveAsDraft,
      discardDraft: handleDiscardDraft,
    };
    return () => {
      if (actionsRef) actionsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionsRef, formData, editingEmployee, draftId]);

  // Shared body rendered inside either a Sheet (modal) or a plain div
  // (full-page route). The header is rendered as SheetHeader in modal mode
  // and as a plain block in page mode; the page route renders its own
  // breadcrumb/title above this component.
  const headerNode = renderAs === "dialog" ? null : (
    !editingEmployee && hasSavedDraft ? (
      <div className="flex justify-end">
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Save className="h-3 w-3" /> Draft saved
        </span>
      </div>
    ) : null
  );

  const sheetTitle = editingEmployee ? "Edit Employee" : "Add New Employee";
  const sheetDescription = editingEmployee
    ? "Update the employee details."
    : "Enter the employee information below.";
  const sheetHeaderRight = !editingEmployee && hasSavedDraft ? (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Save className="h-3 w-3" /> Draft saved
    </span>
  ) : null;


  // Footer action row — extracted so we can render it sticky inside the
  // Sheet, or inline at the bottom of the page form.
  const footerActions = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {!editingEmployee && hasSavedDraft && (
        <Button
          type="button"
          variant="ghost"
          className="mr-auto text-destructive hover:text-destructive"
          onClick={handleDiscardDraft}
        >
          <Trash2 className="h-4 w-4 mr-2" /> Discard draft
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        onClick={() => requestClose(() => onOpenChange(false))}
      >
        {renderAs === "page" ? "Back" : "Cancel"}
      </Button>
      {renderAs === "page" && !editingEmployee && onSaveAsDraft && (
        <Button
          type="button"
          variant="secondary"
          disabled={isSavingDraft || isSubmitting}
          onClick={async () => {
            setIsSavingDraft(true);
            try {
              await onSaveAsDraft(formData);
              clearDraft();
              rebaselineDirty(formData);
            } finally {
              setIsSavingDraft(false);
            }
          }}
        >
          {isSavingDraft && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save as draft
        </Button>
      )}
      <Button
        type="submit"
        form="employee-form-body"
        disabled={isSubmitting || isSavingDraft}
      >
        {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {editingEmployee ? "Update" : "Create"}
      </Button>
    </div>
  );

  const formInner = (
    <>
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex flex-wrap h-auto gap-1 w-full">
          <TabsTrigger value="personal" className="flex-1 min-w-[4.5rem] text-xs sm:text-sm">Personal</TabsTrigger>
          <TabsTrigger value="employment" className="flex-1 min-w-[4.5rem] text-xs sm:text-sm">Employment</TabsTrigger>
          {showStatutoryTab && (
            <TabsTrigger value="statutory" className="flex-1 min-w-[4.5rem] text-xs sm:text-sm">Statutory</TabsTrigger>
          )}
          <TabsTrigger value="salary" className="flex-1 min-w-[5rem] text-xs sm:text-sm">Payment Info</TabsTrigger>
          {editingEmployee && <TabsTrigger value="hr_settings" className="flex-1 min-w-[5rem] text-xs sm:text-sm">HR Settings</TabsTrigger>}
        </TabsList>
        <EmployeeFormTabContents
          formData={formData}
          setFormData={setFormData}
          editingEmployee={editingEmployee}
          showStatutoryTab={showStatutoryTab}
          statutoryRequirements={statutoryRequirements}
          activeDepartments={activeDepartments}
          activePositions={activePositions}
          activeLocations={activeLocations}
          onInvite={onInvite}
          onLink={onLink}
          onSetManager={onSetManager}
          onOpenChange={onOpenChange}
        />
      </Tabs>

      <CustomFieldsSection entityType="employee" entityId={editingEmployee?.id || null} />

      {/* In page mode the footer renders inline below the form unless the
          host shell opted out via `hideInlineFooter`. In sheet mode the
          footer is sticky outside this <form>, and the submit button
          references this form via `form="employee-form-body"`. */}
      {renderAs === "page" && !hideInlineFooter && (
        <div className="pt-4 border-t">{footerActions}</div>
      )}
    </>
  );

  const formBody = hideInlineForm ? (
    <div className="space-y-4">{formInner}</div>
  ) : (
    <form
      id="employee-form-body"
      ref={formRef}
      onSubmit={handleSubmit}
      className="space-y-4"
    >
      {formInner}
    </form>
  );

  const discardGuard = (
    <AlertDialog
      open={pendingClose !== null}
      onOpenChange={(o) => { if (!o) setPendingClose(null); }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>
            You have unsaved changes in this form. Closing now will discard
            them. Your draft is also saved locally and will be available the
            next time you open this dialog.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setPendingClose(null)}>
            Keep editing
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              const fn = pendingClose;
              setPendingClose(null);
              fn?.();
            }}
          >
            Discard &amp; close
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  if (renderAs === "page") {
    return (
      <>
        <div className="space-y-4">
          {headerNode}
          {formBody}
        </div>
        {discardGuard}
      </>
    );
  }

  return (
    <>
      <WorkflowSheet
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            requestClose(() => onOpenChange(false));
            return;
          }
          onOpenChange(next);
        }}
        size="2xl"
        title={sheetTitle}
        description={sheetDescription}
        headerRight={sheetHeaderRight}
        preventAutoClose={isDirty && !editingEmployee}
        onAutoCloseAttempt={() => setPendingClose(() => () => onOpenChange(false))}
        footer={footerActions}
      >
        {formBody}
      </WorkflowSheet>

      {discardGuard}
    </>
  );

}

function FieldRow({ label, colSpan, children }: { label: string; colSpan?: number; children: React.ReactNode }) {
  const cls = colSpan === 2 ? "space-y-2 md:col-span-2" : "space-y-2";
  return (
    <div className={cls}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EmployeeFormTabContents
//
// Extracted from the dialog body so the same field set can be reused inside
// the full-page route (`/hr/employees/new`). All state still lives in the
// parent EmployeeFormDialog component — this is a pure presentational shell.
// ─────────────────────────────────────────────────────────────────────────────
interface EmployeeFormTabContentsProps {
  formData: EmployeeFormData;
  setFormData: React.Dispatch<React.SetStateAction<EmployeeFormData>>;
  editingEmployee: Employee | null;
  showStatutoryTab: boolean;
  statutoryRequirements: Array<{
    requirement_key: string;
    label: string;
    is_required: boolean;
    validation_regex?: string | null;
    help_text?: string | null;
  }>;
  activeDepartments: Department[];
  activePositions: Array<{ id: string; name: string }>;
  activeLocations: Array<{ id: string; name: string; location_type: string }>;
  onInvite?: (employee: Employee) => void;
  onLink?: (employee: Employee) => void;
  onSetManager?: (employee: Employee) => void;
  onOpenChange: (open: boolean) => void;
}

function EmployeeFormTabContents({
  formData, setFormData, editingEmployee, showStatutoryTab, statutoryRequirements,
  activeDepartments, activePositions, activeLocations,
  onInvite, onLink, onSetManager, onOpenChange,
}: EmployeeFormTabContentsProps) {
  return (
    <>
      <TabsContent value="personal" className="space-y-4 mt-4">
        <div className="grid gap-4 md:grid-cols-2">
          <FieldRow label="First Name *">
            <Input value={formData.first_name} onChange={(e) => setFormData({ ...formData, first_name: e.target.value })} required />
          </FieldRow>
          <FieldRow label="Last Name *">
            <Input value={formData.last_name} onChange={(e) => setFormData({ ...formData, last_name: e.target.value })} required />
          </FieldRow>
          <FieldRow label="Personal Email">
            <Input type="email" value={formData.email} onChange={(e) => setFormData({ ...formData, email: e.target.value })} />
          </FieldRow>
          <FieldRow label="Work Email">
            <Input type="email" value={formData.work_email} onChange={(e) => setFormData({ ...formData, work_email: e.target.value })} />
          </FieldRow>
          <FieldRow label="Phone">
            <Input value={formData.phone} onChange={(e) => setFormData({ ...formData, phone: e.target.value })} />
          </FieldRow>
          <FieldRow label="Personal Phone">
            <Input value={formData.personal_phone} onChange={(e) => setFormData({ ...formData, personal_phone: e.target.value })} />
          </FieldRow>
          <FieldRow label="National ID">
            <Input value={formData.national_id} onChange={(e) => setFormData({ ...formData, national_id: e.target.value })} />
          </FieldRow>
          <FieldRow label="Gender">
            <Select value={formData.gender} onValueChange={(v) => setFormData({ ...formData, gender: v })}>
              <SelectTrigger><SelectValue placeholder="Select gender" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="male">Male</SelectItem>
                <SelectItem value="female">Female</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="Date of Birth">
            <Input type="date" value={formData.date_of_birth} onChange={(e) => setFormData({ ...formData, date_of_birth: e.target.value })} />
          </FieldRow>
          <FieldRow label="Marital Status">
            <Select value={formData.marital_status} onValueChange={(v) => setFormData({ ...formData, marital_status: v })}>
              <SelectTrigger><SelectValue placeholder="Select status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="single">Single</SelectItem>
                <SelectItem value="married">Married</SelectItem>
                <SelectItem value="divorced">Divorced</SelectItem>
                <SelectItem value="widowed">Widowed</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
        </div>

        <div className="border-t pt-4 mt-4">
          <h4 className="font-medium mb-4">Address</h4>
          <div className="grid gap-4 md:grid-cols-2">
            <FieldRow label="Address Line 1" colSpan={2}>
              <Input value={formData.address_line1} onChange={(e) => setFormData({ ...formData, address_line1: e.target.value })} />
            </FieldRow>
            <FieldRow label="Address Line 2" colSpan={2}>
              <Input value={formData.address_line2} onChange={(e) => setFormData({ ...formData, address_line2: e.target.value })} />
            </FieldRow>
            <FieldRow label="City / Town"><Input value={formData.city} onChange={(e) => setFormData({ ...formData, city: e.target.value })} /></FieldRow>
            <FieldRow label="County / State"><Input value={formData.county} onChange={(e) => setFormData({ ...formData, county: e.target.value })} /></FieldRow>
            <FieldRow label="Postal Code"><Input value={formData.postal_code} onChange={(e) => setFormData({ ...formData, postal_code: e.target.value })} /></FieldRow>
            <FieldRow label="Country"><Input value={formData.country} onChange={(e) => setFormData({ ...formData, country: e.target.value })} /></FieldRow>
          </div>
        </div>

        <div className="border-t pt-4 mt-4">
          <h4 className="font-medium mb-4">Emergency Contact</h4>
          <div className="grid gap-4 md:grid-cols-2">
            <FieldRow label="Contact Name"><Input value={formData.emergency_contact_name} onChange={(e) => setFormData({ ...formData, emergency_contact_name: e.target.value })} /></FieldRow>
            <FieldRow label="Contact Phone"><Input value={formData.emergency_contact_phone} onChange={(e) => setFormData({ ...formData, emergency_contact_phone: e.target.value })} /></FieldRow>
            <FieldRow label="Relationship"><Input value={formData.emergency_contact_relationship} placeholder="e.g. Spouse, Parent, Sibling" onChange={(e) => setFormData({ ...formData, emergency_contact_relationship: e.target.value })} /></FieldRow>
          </div>
        </div>
      </TabsContent>

      <TabsContent value="employment" className="space-y-4 mt-4">
        <div className="grid gap-4 md:grid-cols-2">
          <FieldRow label="Hire Date *">
            <Input type="date" value={formData.hire_date} onChange={(e) => setFormData({ ...formData, hire_date: e.target.value })} required />
          </FieldRow>
          <FieldRow label="Employment Type">
            <Select value={formData.employment_type} onValueChange={(v) => setFormData({ ...formData, employment_type: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="full_time">Full Time</SelectItem>
                <SelectItem value="part_time">Part Time</SelectItem>
                <SelectItem value="contract">Contract</SelectItem>
                <SelectItem value="intern">Intern</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="Department">
            <Select value={formData.department_id} onValueChange={(v) => setFormData({ ...formData, department_id: v })}>
              <SelectTrigger><SelectValue placeholder="Select department" /></SelectTrigger>
              <SelectContent>
                {activeDepartments.map((d: Department) => (
                  <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="Job Position">
            <Select value={formData.job_position_id} onValueChange={(v) => setFormData({ ...formData, job_position_id: v })}>
              <SelectTrigger><SelectValue placeholder="Select position" /></SelectTrigger>
              <SelectContent>
                {activePositions.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
                {activePositions.length === 0 && (
                  <SelectItem value="__none__" disabled>No positions defined yet</SelectItem>
                )}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              Define positions in <span className="underline">Configuration → Job Positions</span>
            </p>
          </FieldRow>
          <FieldRow label="Work Location">
            <Select value={formData.work_location_id} onValueChange={(v) => setFormData({ ...formData, work_location_id: v })}>
              <SelectTrigger><SelectValue placeholder="Select work location" /></SelectTrigger>
              <SelectContent>
                {activeLocations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>{l.name} <span className="text-muted-foreground text-xs ml-1">({l.location_type})</span></SelectItem>
                ))}
                {activeLocations.length === 0 && (
                  <SelectItem value="__none__" disabled>No work locations defined yet</SelectItem>
                )}
              </SelectContent>
            </Select>
          </FieldRow>
        </div>
      </TabsContent>

      {showStatutoryTab && (
        <TabsContent value="statutory" className="space-y-4 mt-4">
          <p className="text-sm text-muted-foreground mb-4">
            Statutory identifiers required by the installed payroll pack. Per-business toggles can be adjusted in HR → Configuration → Statutory fields.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {statutoryRequirements.map((field) => {
              const key = field.requirement_key;
              const value = formData.statutory_identifiers[key] ?? "";
              const invalid =
                !!field.validation_regex &&
                value !== "" &&
                !new RegExp(field.validation_regex).test(value);
              return (
                <div key={key} className="space-y-2">
                  <Label htmlFor={key}>
                    {field.label}
                    {field.is_required && " *"}
                  </Label>
                  <Input
                    id={key}
                    value={value}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        statutory_identifiers: {
                          ...prev.statutory_identifiers,
                          [key]: e.target.value,
                        },
                      }))
                    }
                    required={field.is_required}
                    aria-invalid={invalid}
                  />
                  {field.help_text && (
                    <p className={`text-xs ${invalid ? "text-destructive" : "text-muted-foreground"}`}>
                      {field.help_text}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </TabsContent>
      )}

      <TabsContent value="salary" className="space-y-4 mt-4">
        <div className="rounded-md border bg-muted/40 p-3 text-sm flex items-start gap-2">
          <Info className="h-4 w-4 mt-0.5 text-primary shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">Compensation lives on the contract</p>
            <p className="text-muted-foreground text-xs">
              Payroll calculates wages, allowances and salary structure from the employee's <strong>active contract</strong>, not from this form.
              {editingEmployee
                ? " Open the Contracts tab on this employee's profile to set or change pay."
                : " After saving this employee, open their profile and create a contract to set pay."}
            </p>
            {editingEmployee && (
              <Button asChild type="button" variant="link" size="sm" className="px-0 h-auto">
                <a href={`/hr/employees/${editingEmployee.id}?tab=contracts`}>
                  Open contracts <ArrowRight className="ml-1 h-3.5 w-3.5" />
                </a>
              </Button>
            )}
          </div>
        </div>
        <div className="border-t pt-4 mt-4">
          <h4 className="font-medium mb-4">Bank Details</h4>
          <div className="grid gap-4 md:grid-cols-2">
            <FieldRow label="Bank Name"><Input value={formData.bank_name} onChange={(e) => setFormData({ ...formData, bank_name: e.target.value })} /></FieldRow>
            <FieldRow label="Branch"><Input value={formData.bank_branch} onChange={(e) => setFormData({ ...formData, bank_branch: e.target.value })} /></FieldRow>
            <FieldRow label="Account Number"><Input value={formData.bank_account_number} onChange={(e) => setFormData({ ...formData, bank_account_number: e.target.value })} /></FieldRow>
            <FieldRow label="Bank Code"><Input value={formData.bank_code} onChange={(e) => setFormData({ ...formData, bank_code: e.target.value })} /></FieldRow>
          </div>
        </div>
      </TabsContent>

      {editingEmployee && (
        <TabsContent value="hr_settings" className="space-y-4 mt-4">
          <div className="space-y-4">
            <h4 className="font-medium flex items-center gap-2">
              <Shield className="h-4 w-4" />
              System Access
            </h4>
            <div className="rounded-lg border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Access Status</span>
                <Badge variant={
                  editingEmployee.user_id ? "default" :
                  (editingEmployee as any).user_access_status === "invited" ? "secondary" :
                  "outline"
                }>
                  {editingEmployee.user_id ? "Active" :
                   (editingEmployee as any).user_access_status === "invited" ? "Invited" :
                   "No Access"}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                {editingEmployee.user_id
                  ? "This employee is linked to a user account and can log into the system."
                  : "This employee has no system access. Use the actions below to invite them or link an existing user."}
              </p>
              <div className="flex gap-2 pt-2">
                {!editingEmployee.user_id && onInvite && (
                  <Button type="button" variant="default" size="sm" onClick={() => { onOpenChange(false); onInvite(editingEmployee); }}>
                    <Mail className="h-4 w-4 mr-2" /> Invite to System
                  </Button>
                )}
                {onLink && (
                  <Button type="button" variant="outline" size="sm" onClick={() => { onOpenChange(false); onLink(editingEmployee); }}>
                    <LinkIcon className="h-4 w-4 mr-2" />
                    {editingEmployee.user_id ? "Change User Link" : "Link Existing User"}
                  </Button>
                )}
              </div>
            </div>

            <div className="rounded-lg border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Manager</span>
                {editingEmployee.manager ? (
                  <Badge variant="secondary">
                    {editingEmployee.manager.first_name} {editingEmployee.manager.last_name}
                  </Badge>
                ) : (
                  <Badge variant="outline">Not assigned</Badge>
                )}
              </div>
              {onSetManager && (
                <Button type="button" variant="outline" size="sm" onClick={() => { onOpenChange(false); onSetManager(editingEmployee); }}>
                  <UserPlus className="h-4 w-4 mr-2" />
                  {editingEmployee.manager_id ? "Change Manager" : "Set Manager"}
                </Button>
              )}
            </div>
          </div>
        </TabsContent>
      )}
    </>
  );
}
