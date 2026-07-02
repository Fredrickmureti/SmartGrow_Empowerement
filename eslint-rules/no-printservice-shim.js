/**
 * ESLint rule: forbid imports from any `print-service` / `PrintService`
 * shim outside the sanctioned printing chokepoint (`src/services/printing/`).
 *
 * After ADR-0026, the only sanctioned print entry point is `PrintClient`
 * (or the thin wrappers it owns). A "print-service" shim is any module
 * whose path matches /print[-_]?service/i — historically these were the
 * pre-chokepoint façades that grew their own format/transport logic and
 * caused the divergence ADR-0026 was written to undo.
 *
 * Scope: src/**. Tests and the printing module itself are exempt.
 */

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid imports from print-service shims outside src/services/printing/.' },
    schema: [],
    messages: {
      shim: 'Importing from "{{ name }}" is forbidden. Route through PrintClient (src/services/printing/PrintClient.ts) — ADR-0026.',
    },
  },
  create(context) {
    const filename = context.getFilename();
    if (
      filename.includes('/src/test/') ||
      filename.includes('/src/services/printing/') ||
      !filename.includes('/src/')
    ) return {};

    const PATTERN = /print[-_]?service/i;

    function check(node, src) {
      if (typeof src !== 'string') return;
      if (PATTERN.test(src)) {
        context.report({ node, messageId: 'shim', data: { name: src } });
      }
    }

    return {
      ImportDeclaration(node) { check(node, node.source && node.source.value); },
      ImportExpression(node) {
        if (node.source && node.source.type === 'Literal') check(node, node.source.value);
      },
    };
  },
};
