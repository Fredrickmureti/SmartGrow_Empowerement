/**
 * LocalizationFormShell — thin wrapper around WorkflowSheet so every
 * Localization (Payroll → Configuration → Localization) editor opens
 * in the same right-side enterprise sheet, sized and titled
 * consistently. Keeps the migration recipe in one place so future
 * editors don't re-derive the chrome.
 */
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import {
  WorkflowSheet,
  type WorkflowSheetSize,
} from "@/components/workflow/WorkflowSheet";

type Entity =
  | "rule"
  | "template"
  | "create-template"
  | "tax-template"
  | "account-template"
  | "remittance-schedule"
  | "publish-version"
  | "diff-version"
  | "promote-version"
  | "certificate"
  | "return"
  | "publisher-grant"
  | "pack-token"
  | "garnishment-kind"
  | "garnishment-policy"
  | "bank-export"
  | "statutory-authority"
  | "pack-requirement";

const META: Record<Entity, { create: string; edit: string; description: string; size: WorkflowSheetSize }> = {
  rule: {
    create: "New rule",
    edit: "Edit rule",
    description: "Define how this rule computes — type, parameters, and effective behaviour.",
    size: "xl",
  },
  template: {
    create: "New template",
    edit: "Edit template",
    description: "Design the body and layout. Tokens render from the live payroll context.",
    size: "2xl",
  },
  "create-template": {
    create: "New template",
    edit: "New template",
    description: "Set the metadata. After saving you'll be taken into the body editor.",
    size: "lg",
  },
  "tax-template": {
    create: "New tax",
    edit: "Edit tax",
    description: "Configure the rate, type, and flags applied to transactions using this tax.",
    size: "lg",
  },
  "account-template": {
    create: "New account",
    edit: "Edit account",
    description: "Position this account in the chart of accounts and classify it for reporting.",
    size: "lg",
  },
  "remittance-schedule": {
    create: "New remittance schedule",
    edit: "Edit remittance schedule",
    description: "Tell the engine when this statutory liability is due and where it posts.",
    size: "lg",
  },
  "publish-version": {
    create: "Publish new version",
    edit: "Publish new version",
    description: "Snapshot the current pack as a new semver release. Tenants can promote it from their workspace.",
    size: "lg",
  },
  "diff-version": {
    create: "Version diff",
    edit: "Version diff",
    description: "Side-by-side changes between the two most recent pack snapshots.",
    size: "2xl",
  },
  "promote-version": {
    create: "Promote version",
    edit: "Promote version",
    description: "Flip this version to active for the chosen scope. Every affected tenant is audited.",
    size: "lg",
  },
  certificate: {
    create: "New certificate",
    edit: "Edit certificate",
    description: "Define the certificate's metadata. After saving you'll be taken into the body editor to design the layout using tokens.",
    size: "lg",
  },
  return: {
    create: "New statutory return",
    edit: "Edit statutory return",
    description: "Define the return's metadata. After saving you'll be taken into the body editor to design the layout using tokens.",
    size: "lg",
  },
  "publisher-grant": {
    create: "Invite publisher",
    edit: "Edit publisher access",
    description: "Grant a teammate the right to author or review this pack. Owners can manage other grantees; publishers author content; reviewers comment only.",
    size: "lg",
  },
  "pack-token": {
    create: "New token",
    edit: "Edit token",
    description: "Declare a value the resolver can render. Templates reference tokens by path; deprecating one shows every consumer.",
    size: "lg",
  },
  "garnishment-kind": {
    create: "New garnishment kind",
    edit: "Edit garnishment kind",
    description: "Statutory deduction order this jurisdiction recognises (child support, tax levy, court order). Controls priority, caps, and required evidence.",
    size: "xl",
  },
  "garnishment-policy": {
    create: "Garnishment policy",
    edit: "Edit garnishment policy",
    description: "Cross-order limits: aggregate caps, minimum take-home, priority resolution, and the protected-earnings formula.",
    size: "xl",
  },
  "bank-export": {
    create: "New bank export template",
    edit: "Edit bank export template",
    description: "Defines how payroll payment batches are serialised for a bank (CSV columns, fixed-width layouts, or vendor-specific specs).",
    size: "xl",
  },
  "statutory-authority": {
    create: "New statutory authority",
    edit: "Edit statutory authority",
    description: "The regulator (revenue, pension, health, court) that receives filings or remittances. Return templates and remittance schedules bind to authorities by id.",
    size: "lg",
  },
  "pack-requirement": {
    create: "New requirement",
    edit: "Edit requirement",
    description: "A field or capability the pack expects a tenant to configure before onboarding or payroll can proceed. Blockers stop the flow; warnings surface as advisories.",
    size: "lg",
  },
};

export interface LocalizationFormShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entity: Entity;
  mode?: "create" | "edit";
  /** Override the default title (e.g. include the entity name being edited). */
  title?: ReactNode;
  /** Override the default subtitle. */
  description?: ReactNode;
  size?: WorkflowSheetSize;
  busy?: boolean;
  /** Submit handler — wired to a form when present so Enter submits. */
  onSubmit?: () => void;
  /** Submit button label. */
  submitLabel?: ReactNode;
  /** Disable submit (validation errors, busy, etc.). */
  submitDisabled?: boolean;
  /** Hide the default footer when the editor renders its own actions. */
  hideFooter?: boolean;
  /** Replace the footer entirely. */
  footer?: ReactNode;
  children: ReactNode;
}

export function LocalizationFormShell({
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
}: LocalizationFormShellProps) {
  const meta = META[entity];
  const resolvedTitle = title ?? (mode === "edit" ? meta.edit : meta.create);
  const resolvedDescription = description ?? meta.description;
  const resolvedSize = size ?? meta.size;

  const defaultFooter = onSubmit && !hideFooter ? (
    <>
      <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
        Cancel
      </Button>
      <Button type="submit" disabled={submitDisabled || busy}>
        {busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
        {submitLabel ?? "Save"}
      </Button>
    </>
  ) : footer;

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
