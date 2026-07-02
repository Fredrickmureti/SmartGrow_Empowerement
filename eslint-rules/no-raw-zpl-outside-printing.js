/**
 * ESLint rule: forbid raw ZPL (Zebra Programming Language) string literals
 * outside the sanctioned printing/driver layers.
 *
 * Why: ZPL byte strings inside UI/page code bypass the `label_templates`
 * registry (and therefore branch overrides, template versioning, price
 * tokens, and promotional joins). Wave B2.2 of the hardware
 * enterprise-readiness audit ratcheted product-label generation onto the
 * template path; this rule keeps it from regressing.
 *
 * Detection: a string literal (or template literal) that begins with `^XA`
 * — the universal ZPL document opener — or that contains `^XZ`, the
 * document closer. ZPL has no other plausible string-literal use, so false
 * positives are negligible.
 *
 * Sanctioned locations (rule does NOT fire):
 *   - src/services/printing/**          (template dispatcher + renderers)
 *   - src/services/hardware/drivers/**  (label_printer driver implementations)
 *   - electron/hardware/drivers/**      (Electron-side driver implementations)
 *   - src/test/**                       (test fixtures and assertion strings)
 *   - supabase/**                       (template bodies in seed migrations)
 */

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid raw ZPL string literals outside src/services/printing, src/services/hardware/drivers, and electron/hardware/drivers.',
    },
    schema: [],
    messages: {
      raw:
        'Raw ZPL ({{snippet}}) is forbidden here. Use printLabelByTemplate({ templateKey, vars }) from @/services/printing/labelDispatch and store the body in label_templates — Wave B2.2.',
    },
  },
  create(context) {
    const filename = context.getFilename().replace(/\\/g, '/');

    // Sanctioned paths
    if (
      filename.includes('/src/services/printing/') ||
      filename.includes('/src/services/hardware/drivers/') ||
      filename.includes('/electron/hardware/drivers/') ||
      filename.includes('/src/test/') ||
      filename.includes('/supabase/') ||
      // Tests and non-src files are exempt
      !filename.includes('/src/')
    ) {
      return {};
    }

    const looksLikeZpl = (str) => {
      if (typeof str !== 'string') return false;
      // Match the document opener at the start of the literal OR the closer
      // anywhere. ZPL is line-oriented, so multi-line template literals
      // with leading whitespace still start with ^XA at column 0 within
      // the literal — strict startsWith is enough.
      return str.startsWith('^XA') || str.includes('^XZ');
    };

    const report = (node, value) => {
      const snippet = value.length > 16 ? value.slice(0, 16) + '…' : value;
      context.report({ node, messageId: 'raw', data: { snippet } });
    };

    return {
      Literal(node) {
        if (looksLikeZpl(node.value)) report(node, String(node.value));
      },
      TemplateLiteral(node) {
        // Concatenate the cooked quasi values; if the resulting string
        // looks like ZPL, flag it. Inserted expressions are skipped — the
        // raw skeleton is what gives ZPL away.
        const cooked = node.quasis.map((q) => q.value.cooked || '').join('\u0000');
        if (looksLikeZpl(cooked)) report(node, cooked);
      },
    };
  },
};
