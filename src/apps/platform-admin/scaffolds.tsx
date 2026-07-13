/**
 * Admin scaffolds — thin, semantically-named re-exports of the shared
 * `@/design-system` record primitives.
 *
 * Every new Platform Admin workspace / peek imports from here rather
 * than pulling `RecordShell` / `RecordFormShell` / `DocumentPeekShell`
 * directly, so admin pages surface a single, consistent vocabulary and
 * any future admin-specific defaults (breadcrumb prefix, permission
 * gate, telemetry) can be layered in exactly one place.
 *
 * Adding new scaffolds? Prefer wrapping a design-system primitive here
 * over introducing a new admin-only layout — the whole point of the
 * substrate is that admin looks and behaves like the tenant ERP.
 */
export {
  RecordShell as AdminRecordPage,
  RecordFormShell as AdminRecordForm,
  DocumentPeekShell as AdminPeekShell,
  WizardShell as AdminWizard,
  WizardStepper as AdminWizardStepper,
  DetailSheet as AdminDetailSheet,
  FooterActionBar as AdminFooterActionBar,
  SummaryPanel as AdminSummaryPanel,
  FieldGrid as AdminFieldGrid,
  FieldCell as AdminFieldCell,
  FieldGroup as AdminFieldGroup,
  useRecordFormSubmit as useAdminRecordFormSubmit,
  usePeekParam as useAdminPeekParam,
} from "@/design-system";

export type {
  RecordFormMode as AdminRecordFormMode,
  WizardStep as AdminWizardStep,
} from "@/design-system";
