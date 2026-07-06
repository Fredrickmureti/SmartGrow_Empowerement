// Public surface of the localization shared library.
// Both the platform admin editor and the tenant editor import from here.
export * from "./types";
export { useRuleSchemas, useRuleSchema, useTokenRegistry, validatePayload } from "./hooks";
export { SchemaForm } from "./SchemaForm";
export { TokenPicker } from "./TokenPicker";
export { RuleForm } from "./RuleForm";

// Pack lifecycle hooks
export {
  usePacks, usePack, usePackVersions, usePackUpgradeProposals,
  usePackAuditLog, usePublishPackVersion, useDecidePackUpgradeProposal,
  usePackHealth, usePromotePackVersion,
  useCertificateTemplateHealth, useCertificateRenderFallbackHealth,
} from "./hooks/usePack";
export type {
  LocalizationPack, PackVersion, PackUpgradeProposal, PackAuditEntry,
} from "./hooks/usePack";

// Editor components
export { PackEditorShell } from "./components/PackEditorShell";
export { TemplateEditor } from "./components/TemplateEditor";
export { ReturnTemplateEditor } from "./components/ReturnTemplateEditor";
export { PackDiffView } from "./components/PackDiffView";
export { PreviewPanel, renderTokensClient } from "./components/PreviewPanel";
export { PackHealthPanel } from "./components/PackHealthPanel";
export { TaxTemplatesEditor } from "./components/reference/TaxTemplatesEditor";
export { AccountTemplatesEditor } from "./components/reference/AccountTemplatesEditor";
export { RemittanceSchedulesEditor } from "./components/reference/RemittanceSchedulesEditor";
