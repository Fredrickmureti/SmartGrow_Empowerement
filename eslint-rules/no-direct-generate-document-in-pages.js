// ESLint rule (ADR-0086 / D3): forbid direct `generate-document` edge
// function invocations from `src/pages/` and `src/features/**/pages/`.
//
// The canonical client entrypoint is `useDocumentPrint` (which owns
// %PDF magic-byte validation, toasts, and the render-mode contract).
// Pages that call `supabase.functions.invoke("generate-document", ...)`
// directly reopen a shadow path — the same drift class that motivated
// ADR-0086.
//
// Escape hatch: `// RENDERER-EXEMPT: <reason>` on the preceding line.

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid direct generate-document invocations in page modules; use useDocumentPrint (ADR-0086 / D3).',
    },
    schema: [],
    messages: {
      direct:
        'Direct generate-document invocation in a page bypasses the canonical print entrypoint. Use useDocumentPrint (ADR-0086 / D3).',
    },
  },
  create(context) {
    const sourceCode = context.getSourceCode();

    function isExempt(node) {
      const comments = sourceCode.getCommentsBefore(node);
      for (const c of comments) {
        if (/RENDERER-EXEMPT:/.test(c.value)) return true;
      }
      return false;
    }

    // Match `<anything>.functions.invoke("generate-document", ...)`.
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (!callee || callee.type !== 'MemberExpression') return;
        if (!callee.property || callee.property.name !== 'invoke') return;
        const parent = callee.object;
        if (!parent || parent.type !== 'MemberExpression') return;
        if (!parent.property || parent.property.name !== 'functions') return;
        const arg0 = node.arguments && node.arguments[0];
        if (!arg0) return;
        const value =
          arg0.type === 'Literal'
            ? arg0.value
            : arg0.type === 'TemplateLiteral' && arg0.expressions.length === 0
              ? arg0.quasis[0].value.cooked
              : null;
        if (value !== 'generate-document') return;
        if (isExempt(node)) return;
        context.report({ node, messageId: 'direct' });
      },
    };
  },
};