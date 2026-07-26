/**
 * ESLint rule: forbid importing `useDocumentPrint` in NEW files.
 *
 * `useDocumentPrint` is the legacy "shadow" print path that pre-dates
 * `PrintClient` (ADR-0026). It is still wired into the surfaces listed
 * in the allowlist below while Wave B1 Step 3+ migrates them to
 * `printClient.print()`. Any new file importing the hook reopens the
 * shadow path and undoes the chokepoint guarantee.
 *
 * When migrating a surface, remove its entry from `ALLOWED_FILES`.
 *
 * Scope: src/**. Tests, the hook implementation itself, and the hooks
 * that compose it are exempt.
 */

// Snapshot taken 2026-07-26 (Print Pipeline P2 Step 2 complete). Sales /
// purchase pages (Invoices, Bills, Estimates, etc.) reach useDocumentPrint
// only transitively through usePrintOrPreview — they are NOT direct
// consumers and must not be added here. The list below is now infra-only.
const ALLOWED_FILES = [
  'src/components/common/PrintSettingsPopover.tsx',
  'src/components/finance/CreditNoteDetailDialog.tsx',
  'src/components/settings/PrinterProfilesCard.tsx',
  'src/components/settings/PrintingSettings.tsx',
  'src/hooks/useDocumentPrint.ts',
  'src/hooks/useDocumentPrintPolicies.ts',
  'src/hooks/usePrinterProfiles.ts',
  // Shared migration helper; wraps useDocumentPrint as the ask_user /
  // failure fallback for pages routed through PrintClient.
  'src/hooks/usePrintOrPreview.ts',
];

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid useDocumentPrint imports in new files (allowlist current surfaces only).' },
    schema: [],
    messages: {
      shadow: 'useDocumentPrint is the legacy shadow print path. Use printClient.print() from @/services/printing/PrintClient — ADR-0026.',
    },
  },
  create(context) {
    const filename = context.getFilename().replace(/\\/g, '/');
    if (filename.includes('/src/test/') || !filename.includes('/src/')) return {};

    const relIdx = filename.indexOf('/src/');
    const rel = filename.slice(relIdx + 1); // strip leading '/'
    if (ALLOWED_FILES.includes(rel)) return {};

    function check(node, src) {
      if (typeof src !== 'string') return;
      if (src.endsWith('useDocumentPrint') || src.endsWith('/useDocumentPrint')) {
        context.report({ node, messageId: 'shadow' });
      }
    }

    return {
      ImportDeclaration(node) {
        check(node, node.source && node.source.value);
        // also catch named import { useDocumentPrint } from any module
        if (Array.isArray(node.specifiers)) {
          for (const s of node.specifiers) {
            if (s.type === 'ImportSpecifier' && s.imported && s.imported.name === 'useDocumentPrint') {
              context.report({ node: s, messageId: 'shadow' });
              return;
            }
          }
        }
      },
    };
  },
};
