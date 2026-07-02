/**
 * HrConfigFormShell — thin wrapper around WorkflowSheet so every HR
 * Configuration (HR → Configuration → *) create/edit experience opens in
 * the same right-side enterprise sheet, sized and titled consistently.
 *
 * Mirrors TalentFormShell / LocalizationFormShell — keeps the chrome
 * recipe in one place so future configuration editors don't re-derive it.
 */
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import {
  WorkflowSheet,
  type WorkflowSheetSize,
} from "@/components/workflow/WorkflowSheet";

export type HrConfigEntity =
  | "public-holiday"
  | "onboarding-template"
  | "document-category"
  | "competency";

const META: Record<
  HrConfigEntity,
  { create: string; edit: string; description: string; size: WorkflowSheetSize }
> = {
  "public-holiday": {
    create: "Add public holiday",
    edit: "Edit public holiday",
    description:
      "Holidays consumed by Attendance and Leave entitlement. Scope per organization, business, or country.",
    size: "md",
  },
  "onboarding-template": {
    create: "New onboarding template",
    edit: "Edit onboarding template",
    description:
      "Reusable checklist of tasks applied on hire (or offboarding). After saving, open it to add items.",
    size: "lg",
  },
  "document-category": {
    create: "New document category",
    edit: "Edit document category",
    description:
      "Classify files stored on the employee record. Mark categories required during onboarding and set retention.",
    size: "md",
  },
  competency: {
    create: "New competency",
    edit: "Edit competency",
    description:
      "Skills catalog. Assign competencies to employees on their profile to track strengths and training gaps.",
    size: "md",
  },
};

export interface HrConfigFormShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entity: HrConfigEntity;
  mode?: "create" | "edit";
  title?: ReactNode;
  description?: ReactNode;
  size?: WorkflowSheetSize;
  busy?: boolean;
  onSubmit?: () => void;
  submitLabel?: ReactNode;
  submitDisabled?: boolean;
  hideFooter?: boolean;
  footer?: ReactNode;
  children: ReactNode;
}

export function HrConfigFormShell({
  open,
  onOpenChange,
  entity,
  mode = "create",
  title,
  description,
  size,
  busy,
  onSubmit,
  submitLabel,
  submitDisabled,
  hideFooter,
  footer,
  children,
}: HrConfigFormShellProps) {
  const meta = META[entity];
  const resolvedTitle = title ?? (mode === "edit" ? meta.edit : meta.create);
  const resolvedDescription = description ?? meta.description;
  const resolvedSize = size ?? meta.size;

  const defaultFooter =
    onSubmit && !hideFooter ? (
      <>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitDisabled || busy}>
          {busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
          {submitLabel ?? (mode === "edit" ? "Save" : "Create")}
        </Button>
      </>
    ) : (
      footer
    );

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      title={resolvedTitle}
      description={resolvedDescription}
      size={resolvedSize}
      onSubmit={
        onSubmit
          ? (e) => {
              e.preventDefault();
              if (!submitDisabled && !busy) onSubmit();
            }
          : undefined
      }
      footer={hideFooter ? undefined : defaultFooter}
    >
      {children}
    </WorkflowSheet>
  );
}
