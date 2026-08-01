/**
 * ESLint rule: forbid importing the legacy `useDocumentPrint` hook.
 *
 * Plan phase C (Print Pipeline Continuation) deleted the hook: every
 * document-print entry point now goes through `printClient.print()` /
 * `printClient.download()` / `printClient.printDocument()`, or through
 * `usePrintOrPreview` for surfaces that still need a preview dialog
 * fallback. Any new import of `useDocumentPrint` re-introduces the
 * shadow path and undoes the single-chokepoint guarantee.
 *
 * Scope: src/**. Tests are exempt.
 */

// The allowlist is intentionally empty — the hook file no longer exists.
// If a future refactor genuinely needs a new document-print helper, add it
// to `PrintService`, not a new hook, and leave this list empty.
const ALLOWED_FILES = [];

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid useDocumentPrint imports in new files (allowlist current surfaces only).' },
    schema: [],
    messages: {
      shadow: 'useDocumentPrint is the legacy shadow print path. Use printDocument() from @/services/printing/PrintService — ADR-0026.',
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
