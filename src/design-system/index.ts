/**
 * Design System — the single approved import surface for every ERP module.
 *
 * SHELL — the canonical workspace shell (app rail + per-workspace sidebar +
 * topbar) lives in `@/components/layout/shell/PlatformShell` and is
 * re-exported here so modules can import "the shell" from one place. There
 * is intentionally NO second shell implementation in this folder — that
 * would fork the navigation model the platform spent quarters consolidating.
 *
 * PRIMITIVES — the building blocks every page composes from: PageHeader,
 * PageBody, Section, EmptyState, LoadingState, ErrorState, StatusBadge,
 * FilterBar, ActionBar, DetailLayout. Modules that hand-roll their own
 * page header / empty state markup are the reason ERPs drift — use these.
 *
 * See docs/design-system.md for the rules of the road.
 */

import "./tokens.css";

// Shell — re-exported from the canonical implementation. Never fork.
export { PlatformShell } from "@/components/layout/shell/PlatformShell";
export type {
  WorkspaceNav,
  WorkspaceNavGroup,
  WorkspaceNavItem,
} from "@/components/layout/shell/types";

// Primitives — the only approved page building blocks.
export { PageHeader } from "./primitives/PageHeader";
export { PageBody } from "./primitives/PageBody";
export { Section } from "./primitives/Section";
export { EmptyState } from "./primitives/EmptyState";
export { LoadingState } from "./primitives/LoadingState";
export { ErrorState } from "./primitives/ErrorState";
export { StatusBadge } from "./primitives/StatusBadge";
export { FilterBar } from "./primitives/FilterBar";
export { ActionBar } from "./primitives/ActionBar";
export { DetailLayout } from "./primitives/DetailLayout";

// Canonical KPI/summary card — one stat card for the whole ERP (Finance,
// Sales, Purchases, Inventory, Warehouse). Implementation still lives in
// `@/components/common/SummaryStatCards` so the 45 existing call sites keep
// working; new code should import it from here.
export {
  SummaryStatCard,
  SummaryStatGrid,
} from "@/components/common/SummaryStatCards";
export { CalloutCard } from "@/components/common/CalloutCard";
export type {
  CalloutCardProps,
  CalloutMetric,
  CalloutTone,
} from "@/components/common/CalloutCard";
export type {
  SummaryStatCardProps,
  SummaryStatTone,
  SummaryStatTrend,
  SummaryStatTrendDirection,
} from "@/components/common/SummaryStatCards";
export { AuthoringWorkspace } from "./primitives/AuthoringWorkspace";
export type { WorkspaceLayoutMode, WorkspaceNavDirection } from "./primitives/AuthoringWorkspace";


// Authoring input primitives — shared by every advanced editor
// (Localization Editor, form designers, template editors). Adopt these
// instead of raw <Input>/<Textarea> so long values are always visible
// and long-form content has an escape hatch to a dialog.
export {
  AutoGrowInput,
  AutoGrowTextarea,
  ExpandableTextField,
  CodeField,
  InspectorSection,
} from "./primitives/inputs";

// Record-interaction primitives — object pages, sheets, wizards, forms.
// These are the enterprise UX standard extracted from the HR/Payroll
// redesign. Every substantial business record (Invoice, PO, GRN, Product,
// Employee, …) is composed from these. See docs/design-system/records.md.
export { RecordShell } from "./primitives/RecordShell";
export { RecordHeader } from "./primitives/RecordHeader";
export { RecordFormShell } from "./primitives/RecordFormShell";
export type { RecordFormMode } from "./primitives/RecordFormShell";
export { DetailSheet } from "./primitives/DetailSheet";
export { WizardShell, WizardStepper } from "./primitives/WizardShell";
export type { WizardStep } from "./primitives/WizardShell";
export { FooterActionBar } from "./primitives/FooterActionBar";
export { SummaryPanel } from "./primitives/SummaryPanel";
export { FieldGrid, FieldCell, FieldGroup } from "./primitives/FieldGrid";

// Record-interaction hooks — canonical submit lifecycle for record forms.
export { useRecordFormSubmit } from "./hooks/useRecordFormSubmit";

// Record scaffolds — peek sheets, object pages, document bodies, line
// items, and the shared peek/record hooks. Promoted from the Sales
// module so every app (Purchases, Inventory, Finance) imports the
// same scaffolds from `@/design-system` instead of a sibling feature.
export {
  RecordScaffold,
  RecordBody,
  PeekScaffold,
  DocumentPeekShell,
  LineItemsGrid,
  DocumentTotalsPanel,
  DocumentActivityPanel,
  DocumentAttachmentsPanel,
  usePeekParam,
  useDocumentRecord,
} from "./records";
export type {
  DetailField,
  LineItemColumn,
  LineItemRow,
  LineItemRowCell,
  DocumentTotalsRow,
  DocumentActivityEntry,
  DocumentAttachment,
} from "./records";

// Dashboard layer — the shared composition language for module dashboards.
// Pages compose bands + widgets; they never author grid geometry. ADR 0103.
export * from "./dashboard";
