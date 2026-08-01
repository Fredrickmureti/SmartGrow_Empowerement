/**
 * ESLint rule: forbid direct `window.print()` calls outside the printing
 * chokepoint (`src/services/printing/pdfUtils.ts`).
 *
 * Direct `window.print()` skips PrintService's policy resolution, transport
 * selection, and audit logging. ADR-0026 requires every print path to go
 * through `PrintService`. pdfUtils is the single sanctioned caller because
 * `printPdfInPage()` wraps the platform print dialog as a transport
 * primitive that PrintService composes.
 *
 * Scope: src/**. Tests are exempt.
 */

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid direct window.print() outside src/services/printing/pdfUtils.ts.' },
    schema: [],
    messages: {
      direct: 'Direct window.print() is forbidden. Use @/services/printing/PrintService — ADR-0026.',
    },
  },
  create(context) {
    const filename = context.getFilename();
    if (
      filename.includes('/src/test/') ||
      filename.endsWith('/src/services/printing/pdfUtils.ts') ||
      !filename.includes('/src/')
    ) return {};

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (!callee || callee.type !== 'MemberExpression') return;
        if (callee.property && callee.property.type === 'Identifier' && callee.property.name === 'print') {
          const obj = callee.object;
          if (obj && obj.type === 'Identifier' && obj.name === 'window') {
            context.report({ node, messageId: 'direct' });
          }
        }
      },
    };
  },
};
