/**
 * ESLint rule: forbid importing any print-service *shim* — i.e. a module
 * whose path looks like a print service but is NOT the canonical
 * chokepoint `src/services/printing/PrintService.ts`.
 *
 * History: ADR-0026 named `PrintClient` as the single entry point. That
 * module was superseded and deleted; the chokepoint is now
 * `@/services/printing/PrintService`. Feature code is EXPECTED to import
 * it — the failure mode this rule guards against is a second façade
 * (`utils/printService`, `lib/print-service`, `hooks/usePrintService`, …)
 * growing its own format/transport logic and re-forking the pipeline.
 *
 * Scope: src/**. Tests and `src/services/printing/` itself are exempt.
 */

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid print-service shims outside src/services/printing/.' },
    schema: [],
    messages: {
      shim:
        'Importing from "{{ name }}" is forbidden — it is a print-service shim. ' +
        'The only sanctioned print entry point is "@/services/printing/PrintService".',
    },
  },
  create(context) {
    const filename = context.getFilename();
    if (
      filename.includes('/src/test/') ||
      filename.includes('/src/services/printing/') ||
      !filename.includes('/src/')
    ) return {};

    // Boundary-anchored: `printService`, `print-service`, `PrintService`
    // as a path segment or camel-case word — never a coincidental suffix
    // such as `DeviceFingerprintService`.
    const SHIM = /(^|[/_.\-])print[-_]?service/i;
    // The canonical chokepoint, in every spelling used across the app.
    const CANONICAL = /^(@\/services\/printing\/PrintService|(\.\.?\/)+services\/printing\/PrintService)$/;

    function check(node, src) {
      if (typeof src !== 'string') return;
      if (!SHIM.test(src)) return;
      if (CANONICAL.test(src)) return;
      context.report({ node, messageId: 'shim', data: { name: src } });
    }

    return {
      ImportDeclaration(node) { check(node, node.source && node.source.value); },
      ImportExpression(node) {
        if (node.source && node.source.type === 'Literal') check(node, node.source.value);
      },
    };
  },
};
