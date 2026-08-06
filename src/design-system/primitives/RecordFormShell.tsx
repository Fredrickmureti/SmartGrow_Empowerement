/**
 * RecordFormShell — the ONLY approved scaffold for create (/new) and
 * edit (/:id/edit) routes of a business record.
 *
 * It is `RecordShell` pre-wired for form flows:
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ RecordHeader   ← back link, entity title, mode tag          │
 *   ├─────────────────────────────────────────────┬──────────────┤
 *   │  <form> body (Section + FieldGrid stack)     │  aside       │
 *   ├──────────────────────────────────────────────┴──────────────┤
 *   │ FooterActionBar  ← Cancel (leading), Save/Submit (trailing) │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * The shell owns:
 *   - the surrounding <form> element (id + onSubmit)
 *   - the Cancel button (routes back or calls onCancel)
 *   - the primary Submit button (form=<id>, disabled while submitting)
 *   - the busy state and the "unsaved changes" affordance
 *
 * Modules pass in header details + section children + optional aside +
 * optional extra leading/trailing footer slots. Modules must NOT render
 * their own <form> or their own Save/Cancel buttons — that is the exact
 * drift this primitive prevents. If a page needs a third action (e.g.
 * "Save & new") it belongs in `extraTrailingActions`.
 */
import type { FormEvent, ReactNode } from "react";
import { useId } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RecordShell } from "./RecordShell";
import { RecordHeader } from "./RecordHeader";
import { FooterActionBar } from "./FooterActionBar";

export type RecordFormMode = "create" | "edit";

interface RecordFormShellProps {
  /** "create" → /new page. "edit" → /:id/edit page. */
  mode: RecordFormMode;
  /** Entity label shown in the header title (e.g. "Invoice", "Sales Order"). */
  entityLabel: string;
  /** Identifier shown next to the entity label on edit (e.g. "INV-000123"). */
  recordRef?: string;
  /** Optional meta chips row rendered below the title (dates, contact, branch). */
  meta?: ReactNode;
  /** Where Cancel routes to. Falls back to `navigate(-1)` if omitted. */
  cancelHref?: string;
  /** Called when Cancel is clicked. Overrides cancelHref if provided. */
  onCancel?: () => void;
  /** Called on form submit. Receives the native event so callers can
   *  read submitter/formData if they need to. Most callers just close
   *  over their own state and ignore it. */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
  /** Disables Cancel + Submit and shows a spinner on Submit. */
  isSubmitting?: boolean;
  /** Blocks Submit even when not submitting (e.g. form invalid). */
  submitDisabled?: boolean;
  /** Label for the primary Submit button. Defaults per mode. */
  submitLabel?: string;
  /** Body — usually a stack of `<Section>` blocks with `<FieldGrid>` inside. */
  children: ReactNode;
  /** Optional right rail (SummaryPanel or totals). */
  aside?: ReactNode;
  /** Extra actions rendered in the header (top-right, next to mode tag). */
  headerActions?: ReactNode;
  /** Extra buttons rendered LEFT of Cancel in the footer
   *  (e.g. "Delete" on edit, "Save as draft" on create). */
  extraLeadingActions?: ReactNode;
  /** Extra buttons rendered LEFT of the primary Submit
   *  (e.g. "Save & new", "Save & send"). */
  extraTrailingActions?: ReactNode;
  className?: string;
}

/**
 * Compose a form-driven object page. See file header for the layout
 * contract and rules.
 */
export function RecordFormShell({
  mode,
  entityLabel,
  recordRef,
  meta,
  cancelHref,
  onCancel,
  onSubmit,
  isSubmitting = false,
  submitDisabled = false,
  submitLabel,
  children,
  aside,
  headerActions,
  extraLeadingActions,
  extraTrailingActions,
  className,
}: RecordFormShellProps) {
  const navigate = useNavigate();
  const formId = useId();

  const title =
    mode === "create"
      ? `New ${entityLabel}`
      : recordRef
        ? `Edit ${entityLabel} · ${recordRef}`
        : `Edit ${entityLabel}`;

  const primaryLabel =
    submitLabel ?? (mode === "create" ? `Create ${entityLabel}` : "Save changes");

  const handleCancel = () => {
    if (onCancel) return onCancel();
    if (cancelHref) return navigate(cancelHref);
    navigate(-1);
  };

  return (
    <RecordShell
      className={className}
      header={
        <RecordHeader
          title={title}
          meta={meta}
          eyebrow={mode === "create" ? "New record" : "Editing"}
          actions={headerActions}
        />
      }
      aside={aside}
      footer={
        <FooterActionBar
          anchor="page"
          leading={
            <>
              {extraLeadingActions}
              <Button
                type="button"
                variant="ghost"
                onClick={handleCancel}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
            </>
          }
          trailing={
            <>
              {extraTrailingActions}
              <Button
                type="submit"
                form={formId}
                disabled={isSubmitting || submitDisabled}
              >
                {isSubmitting && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {primaryLabel}
              </Button>
            </>
          }
        />
      }
    >
      <form
        id={formId}
        onSubmit={onSubmit}
        className={cn("space-y-6")}
        noValidate
      >
        {children}
      </form>
    </RecordShell>
  );
}
