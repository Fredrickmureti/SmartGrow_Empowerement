/**
 * ESLint rule: forbid raw ESC/POS command-byte construction outside the
 * sanctioned emitter layer.
 *
 * Why: Phase 4 of the receipt-rendering consolidation (`.lovable/plan.md`,
 * item 10) makes `supabase/functions/_shared/escpos/**` the *only* place
 * that turns a `Line[]` AST into ESC/POS bytes. Any UI/hook/component
 * that hand-assembles `\x1B@`, `\x1DV`, `\x1B!`, etc. bypasses paper
 * geometry, font profile, printer capabilities, and the shared row
 * producer — the exact drift Phase 2 removed. This rule keeps it out.
 *
 * Detection: string / template literals that contain the ESC (0x1B) or
 * GS (0x1D) control byte, or `String.fromCharCode(0x1B|0x1D|27|29)` /
 * `Uint8Array` initializers starting with those bytes. These bytes have
 * no legitimate use in application code — only in printer command streams.
 *
 * Sanctioned locations (rule does NOT fire):
 *   - supabase/functions/_shared/escpos/**   (canonical emitter + tests)
 *   - src/services/hardware/drivers/**       (thermal driver transport)
 *   - electron/hardware/drivers/**           (Electron thermal driver)
 *   - src/test/** and **_test.ts / *.test.* (fixtures and golden bytes)
 *   - any file outside src/ and supabase/functions/
 */

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid raw ESC/POS command bytes outside supabase/functions/_shared/escpos and the thermal driver layer.',
    },
    schema: [],
    messages: {
      raw:
        'Raw ESC/POS bytes ({{snippet}}) are forbidden here. Produce a Line[] via receipt/lines.ts and let supabase/functions/_shared/escpos emit the bytes. See .lovable/plan.md Phase 4 / ADR-0084.',
    },
  },
  create(context) {
    const filename = context.getFilename().replace(/\\/g, '/');

    // Sanctioned paths
    if (
      filename.includes('/supabase/functions/_shared/escpos/') ||
      filename.includes('/src/services/hardware/drivers/') ||
      filename.includes('/electron/hardware/drivers/') ||
      filename.includes('/src/test/') ||
      /(?:_test|\.test)\.(?:ts|tsx|js|jsx)$/.test(filename) ||
      // Only enforce inside src/ and supabase/functions/
      !(filename.includes('/src/') || filename.includes('/supabase/functions/'))
    ) {
      return {};
    }

    const looksLikeEscPos = (str) => {
      if (typeof str !== 'string' || str.length === 0) return false;
      return str.includes('\x1B') || str.includes('\x1D');
    };

    const report = (node, value) => {
      const printable = value
        .replace(/\x1B/g, '\\x1B')
        .replace(/\x1D/g, '\\x1D');
      const snippet = printable.length > 24 ? printable.slice(0, 24) + '…' : printable;
      context.report({ node, messageId: 'raw', data: { snippet } });
    };

    return {
      Literal(node) {
        if (looksLikeEscPos(node.value)) report(node, String(node.value));
      },
      TemplateLiteral(node) {
        const cooked = node.quasis.map((q) => q.value.cooked || '').join('');
        if (looksLikeEscPos(cooked)) report(node, cooked);
      },
      CallExpression(node) {
        // String.fromCharCode(0x1B, ...) / String.fromCharCode(27, ...)
        const callee = node.callee;
        const isFromCharCode =
          callee &&
          callee.type === 'MemberExpression' &&
          callee.object &&
          callee.object.name === 'String' &&
          callee.property &&
          callee.property.name === 'fromCharCode';
        if (!isFromCharCode) return;
        for (const arg of node.arguments) {
          if (
            arg.type === 'Literal' &&
            typeof arg.value === 'number' &&
            (arg.value === 0x1b || arg.value === 0x1d)
          ) {
            report(node, `String.fromCharCode(0x${arg.value.toString(16).toUpperCase()})`);
            return;
          }
        }
      },
    };
  },
};
