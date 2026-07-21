/**
 * ESLint rule: forbid `<expr>.id` from being used as the `barcode` value
 * passed into `printLabelByTemplate(...)` or `useLabelPrint().print(...)`.
 *
 * Enforces ADR-0089 (barcode identity contract): an internal DB
 * identifier must never be encoded as a scannable barcode. The correct
 * path is `resolveLabelBarcode(product)` from
 * `@/services/printing/labelBarcode`, which returns `null` when there is
 * no legitimate barcode/SKU — callers refuse and route the operator to
 * enrollment instead of printing a UUID.
 *
 * Detection heuristic: inside a `vars: { ... }` sub-object of a call
 * expression named `printLabelByTemplate` or `print`, flag any
 * `barcode:` property whose value contains a `MemberExpression` ending
 * in `.id` (including logical-OR fallbacks like
 * `product.barcode || product.sku || product.id`).
 */

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid `.id` fallbacks in the `barcode` var passed to printLabelByTemplate/useLabelPrint. Use resolveLabelBarcode instead (ADR-0089).',
    },
    schema: [],
    messages: {
      idAsBarcode:
        'Do not fall back to `.id` for a printable barcode — a UUID is not a scannable identifier. Use `resolveLabelBarcode(product)` from @/services/printing/labelBarcode and refuse when it returns null (ADR-0089).',
    },
  },
  create(context) {
    const filename = context.getFilename().replace(/\\/g, '/');
    // Exempt tests and the labelBarcode module itself.
    if (
      filename.includes('/src/test/') ||
      filename.includes('/src/services/printing/labelBarcode.') ||
      !filename.includes('/src/')
    ) {
      return {};
    }

    const containsDotId = (node) => {
      if (!node) return false;
      if (node.type === 'MemberExpression' && node.property && node.property.name === 'id') {
        return true;
      }
      if (node.type === 'LogicalExpression') {
        return containsDotId(node.left) || containsDotId(node.right);
      }
      if (node.type === 'ConditionalExpression') {
        return containsDotId(node.consequent) || containsDotId(node.alternate);
      }
      return false;
    };

    const findBarcodeProp = (objExpr) => {
      if (!objExpr || objExpr.type !== 'ObjectExpression') return null;
      for (const p of objExpr.properties) {
        if (
          p.type === 'Property' &&
          !p.computed &&
          ((p.key.type === 'Identifier' && p.key.name === 'barcode') ||
            (p.key.type === 'Literal' && p.key.value === 'barcode'))
        ) {
          return p;
        }
      }
      return null;
    };

    const findVarsObject = (callArgObj) => {
      if (!callArgObj || callArgObj.type !== 'ObjectExpression') return null;
      for (const p of callArgObj.properties) {
        if (
          p.type === 'Property' &&
          !p.computed &&
          ((p.key.type === 'Identifier' && p.key.name === 'vars') ||
            (p.key.type === 'Literal' && p.key.value === 'vars'))
        ) {
          return p.value.type === 'ObjectExpression' ? p.value : null;
        }
      }
      return null;
    };

    const isTargetCall = (calleeNode) => {
      if (!calleeNode) return false;
      if (calleeNode.type === 'Identifier') {
        return calleeNode.name === 'printLabelByTemplate';
      }
      if (calleeNode.type === 'MemberExpression' && calleeNode.property) {
        // Match `.print({ ... })` — safe because we then require a
        // matching `vars.barcode` shape, so unrelated `.print(...)` calls
        // never trip.
        return calleeNode.property.name === 'print';
      }
      return false;
    };

    return {
      CallExpression(node) {
        if (!isTargetCall(node.callee)) return;
        const arg0 = node.arguments[0];
        if (!arg0 || arg0.type !== 'ObjectExpression') return;
        const varsObj = findVarsObject(arg0);
        if (!varsObj) return;
        const barcodeProp = findBarcodeProp(varsObj);
        if (!barcodeProp) return;
        if (containsDotId(barcodeProp.value)) {
          context.report({ node: barcodeProp, messageId: 'idAsBarcode' });
        }
      },
    };
  },
};
